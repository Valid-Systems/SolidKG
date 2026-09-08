/**
 * MCP shared engine — the heavyweight, *shared* state for an MCP server:
 * the project's {@link SolidKG} instance, file watcher, and the
 * {@link ToolHandler} cache for cross-project queries.
 *
 * One engine, many sessions:
 * - direct mode (single stdio session) instantiates one engine + one session;
 * - daemon mode instantiates one engine and a new session per socket
 *   connection. Every session reads from the same SQLite WAL and the same
 *   inotify watch set — that's the entire point of issue #411.
 */

import SolidKG, { findNearestSolidKGRoot } from '../index';
import { SchemaUpgradeRequiredError } from '../errors';
import { watchDisabledReason } from '../sync';
import { ToolHandler } from './tools';

const CATCH_UP_IDLE_DELAY_MS = 10_000;
const CATCH_UP_FALLBACK_DELAY_MS = 60_000;

export interface MCPEngineOptions {
  /**
   * Whether to start the file watcher when initializing. Daemon and direct
   * modes both want this true; tests may set it false to keep the engine
   * cheap. Honors {@link watchDisabledReason} regardless.
   */
  watch?: boolean;
  dataDir?: string;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently — internally it serializes initialization
 * through a single promise so multiple sessions racing each other on first
 * connect never double-open the SQLite file.
 */
export class MCPEngine {
  private cg: SolidKG | null = null;
  private toolHandler: ToolHandler;
  // Project root we resolved to. Null until `ensureInitialized` succeeds
  // (or null forever if no .solidkg/ ever turned up — that's a valid
  // state for the engine, since cross-project queries still work).
  private projectPath: string | null = null;
  // Set on first `ensureInitialized` so subsequent sessions don't redo work.
  private initPromise: Promise<void> | null = null;
  private watcherStarted = false;
  private opts: { watch: boolean; dataDir?: string };
  private closed = false;
  private activeToolCalls = 0;
  private catchUpStarted = false;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { watch: opts.watch ?? true, dataDir: opts.dataDir };
    this.toolHandler = new ToolHandler(null, opts.dataDir);
  }

  /**
   * Convenience for {@link MCPServer} compatibility: pre-seed an explicit
   * project path (from the `--path` CLI flag) without yet opening it. This
   * keeps the synchronous constructor cheap; the actual open happens on the
   * first `ensureInitialized` call.
   */
  setProjectPathHint(projectPath: string): void {
    this.projectPath = projectPath;
    this.toolHandler.setDefaultProjectHint(projectPath);
  }

  /** Project root that the engine resolved on first init (null if none). */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /** Whether the default project's SolidKG is open. */
  hasDefaultSolidKG(): boolean {
    return this.toolHandler.hasDefaultSolidKG();
  }

  beginToolCall(): void {
    this.activeToolCalls++;
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  endToolCall(): void {
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    if (this.activeToolCalls === 0) this.scheduleCatchUpSync(CATCH_UP_IDLE_DELAY_MS);
  }

  /**
   * Walk up from `searchFrom` to find the nearest `.solidkg/` and open it.
   * Idempotent: concurrent callers share one in-flight init; subsequent
   * callers after success are no-ops.
   *
   * The original `MCPServer.tryInitializeDefault` carried the same retry-on-
   * subsequent-tool-call semantics; we preserve them by NOT throwing when the
   * search misses (just leaves `cg` null so the next call can retry).
   */
  async ensureInitialized(searchFrom: string): Promise<void> {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultSolidKG()) return;
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* let caller retry */ }
      return;
    }

    this.initPromise = this.doInitialize(searchFrom).finally(() => {
      this.initPromise = null;
    });
    try {
      await this.initPromise;
    } catch {
      // Init errors are logged inside `doInitialize`; falling through here
      // matches MCPServer's previous "retry on next tool call" behavior.
    }
  }

  /**
   * Synchronous last-resort init used by the per-session retry loop when the
   * background `ensureInitialized` already finished (or failed) and we need
   * to pick up a project that appeared *after* the engine started.
   */
  retryInitializeSync(searchFrom: string): void {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultSolidKG()) return;
    this.toolHandler.setDefaultProjectHint(searchFrom);
    const resolvedRoot = findNearestSolidKGRoot(searchFrom, { dataDir: this.opts.dataDir });
    if (!resolvedRoot) return;
    this.projectPath = resolvedRoot;
    try {
      // Close any previously failed instance to avoid leaking resources.
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      this.preflightProjectSchema(resolvedRoot);
      this.cg = SolidKG.openSync(resolvedRoot, { dataDir: this.opts.dataDir });
      this.projectPath = resolvedRoot;
      this.toolHandler.setSchemaUpgradeError(null);
      this.toolHandler.setDefaultSolidKG(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch (error) {
      if (error instanceof SchemaUpgradeRequiredError) {
        this.toolHandler.setSchemaUpgradeError(error);
      }
      // Still failing — caller will try again on the next tool call.
    }
  }

  /**
   * Close everything. Used on graceful daemon shutdown (SIGTERM/idle timeout)
   * and on direct-mode stop. Idempotent.
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.toolHandler.closeAll();
    if (this.cg) {
      try { this.cg.close(); } catch { /* ignore */ }
      this.cg = null;
    }
  }

  async stopAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.toolHandler.closeAll();
    if (this.cg) {
      const cg = this.cg;
      this.cg = null;
      try { await cg.closeAsync(); } catch { /* ignore */ }
    }
  }

  private async doInitialize(searchFrom: string): Promise<void> {
    this.toolHandler.setDefaultProjectHint(searchFrom);

    const resolvedRoot = findNearestSolidKGRoot(searchFrom, { dataDir: this.opts.dataDir });
    if (!resolvedRoot) {
      // No .solidkg/ above searchFrom — that's not an error, sessions may
      // still discover one later via roots/list.
      this.projectPath = searchFrom;
      return;
    }

    this.projectPath = resolvedRoot;
    try {
      this.preflightProjectSchema(resolvedRoot);
      this.cg = await SolidKG.open(resolvedRoot, { dataDir: this.opts.dataDir });
      this.toolHandler.setSchemaUpgradeError(null);
      this.toolHandler.setDefaultSolidKG(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch (err) {
      if (err instanceof SchemaUpgradeRequiredError) {
        this.toolHandler.setSchemaUpgradeError(err);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[SolidKG MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
    }
  }

  private preflightProjectSchema(resolvedRoot: string): void {
    const preflight = SolidKG.openSync(resolvedRoot, { dataDir: this.opts.dataDir, readOnly: true });
    preflight.close();
  }

  /**
   * Start file watching on the active SolidKG instance. Idempotent — the
   * watcher is per-engine, not per-session, which is why the daemon path
   * collapses N inotify sets to one. The wording of the disabled-reason log
   * exactly matches the prior in-tree implementation so log-driven dashboards
   * keep working.
   */
  private startWatching(): void {
    if (!this.cg || this.watcherStarted || !this.opts.watch) return;

    const disabledReason = watchDisabledReason(this.projectPath ?? process.cwd());
    if (disabledReason) {
      process.stderr.write(
        `[SolidKG MCP] File watcher disabled — ${disabledReason}. ` +
        `The graph will not auto-update; run \`solidkg sync\` (or install the git sync hooks via \`solidkg init\`) to refresh.\n`
      );
      this.watcherStarted = true;
      return;
    }

    // Optional override for the debounce window via env var (issue #403).
    // Useful for workspaces with bursty writes (formatter-on-save chains,
    // large generated outputs) where the 2s default fires too often. Clamped
    // to [100ms, 60s]; out-of-range / non-numeric values fall back to the
    // FileWatcher default. We log the active value so it's discoverable.
    const debounceMs = parseDebounceEnv(process.env.SOLIDKG_WATCH_DEBOUNCE_MS);
    if (debounceMs !== undefined) {
      process.stderr.write(`[SolidKG MCP] File watcher debounce: ${debounceMs}ms (SOLIDKG_WATCH_DEBOUNCE_MS)\n`);
    }

    const started = this.cg.watch({
      debounceMs,
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[SolidKG MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[SolidKG MCP] Auto-sync error: ${err.message}\n`);
      },
    });

    this.watcherStarted = true;
    if (started) {
      process.stderr.write('[SolidKG MCP] File watcher active — graph will auto-sync on changes\n');
    } else {
      process.stderr.write(
        '[SolidKG MCP] File watcher unavailable on this platform — run `solidkg sync` to refresh the graph after changes.\n'
      );
    }
  }

  /**
   * Reconcile the index with the current filesystem once the MCP surface is
   * idle, so startup catch-up work cannot contend with an answer-producing
   * tool call. A fallback timer still runs it when no tools are ever called.
   */
  private catchUpSync(): void {
    this.scheduleCatchUpSync(CATCH_UP_FALLBACK_DELAY_MS);
  }

  private scheduleCatchUpSync(delayMs: number): void {
    if (this.closed || this.catchUpStarted || !this.cg) return;
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      if (this.activeToolCalls > 0) {
        this.scheduleCatchUpSync(CATCH_UP_IDLE_DELAY_MS);
        return;
      }
      const cg = this.cg;
      if (!cg || this.closed) return;
      this.catchUpStarted = true;
      void cg
        .sync()
        .then((result) => {
          const changed = result.filesAdded + result.filesModified + result.filesRemoved;
          if (changed > 0) {
            process.stderr.write(`[SolidKG MCP] Caught up ${changed} file(s) changed since last run\n`);
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[SolidKG MCP] Catch-up sync failed: ${msg}\n`);
        });
    }, delayMs);
    this.catchUpTimer.unref?.();
  }
}

/**
 * Parse and clamp the SOLIDKG_WATCH_DEBOUNCE_MS env override.
 *
 * Issue #403: workspaces with bursty writes (formatter-on-save, multi-file
 * refactors) sometimes want a longer quiet window before sync. Returns
 * `undefined` for unset / empty / non-numeric / out-of-range values so the
 * FileWatcher default (2000ms) takes over — never throws.
 *
 * Clamp range: 100ms (faster would mean a sync per keystroke) to 60s (longer
 * and the watcher feels broken). Out-of-range values are treated as "ignore
 * this misconfiguration" rather than capped, since silently capping a 0 or
 * a typoed value would mask a real config bug.
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60000) return undefined;
  return n;
}
