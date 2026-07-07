/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the SolidKG MCP server.
 */

import SolidKG, { findNearestSolidKGRoot } from '../index';
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type {
  Node,
  Edge,
  EdgeKind,
  SearchResult,
  Subgraph,
  TaskContext,
  NodeKind,
  HyperedgeRelation,
  SemanticRelationProvenance,
  ScipDocumentRecord,
  ScipOccurrenceRecord,
  ScipRelationshipRecord,
  ReturnedEvidenceFreshness,
  UncertaintyLabel,
  RankingReason,
  SearchRankingReason,
} from '../types';
import { buildFailureAnswerPacket, buildNodeAnswerPacket, formatAnswerPacketMarkdown } from '../evidence/packets';
import { buildGraphTraversalPacket, formatGraphTraversalPacketMarkdown, type GraphTraversalDirection, type GraphTraversalLimit, type GraphTraversalResult } from '../graph';
import { mergeTraversalResults, relationCountsForEdges } from '../graph/traversal-results';
import { extractSearchTerms } from '../search/query-utils';
import { createHash } from 'crypto';
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'fs';
import { clamp, pathMatchesRootAwarePrefix, validatePathWithinRoot, validateProjectPath } from '../utils';
import { redactSensitiveText } from '../context/redaction';
import { buildContextBudget, type ContextBudget } from '../context/budget';
import { tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { buildExploreGraphRankedFileScores } from './explore-graph-rank';
import { getExploreBudget, getExploreOutputBudget, type ExploreOutputBudget } from './explore-budget';
import { tools, withDataDirSchemas, type ToolDefinition, type ToolResult } from './tool-definitions';
import {
  formatArchitecturePackageLookup,
  formatArchitectureReport,
  formatFilesFlat,
  formatFilesGrouped,
  formatFilesTree,
  formatSnapshotDiff,
  formatSnapshotList,
  globToRegex,
  parseLayerRules,
} from './formatters';
import { formatNodeCapabilityFootprint, formatTraceCapabilityFootprint } from './capability-footprint';
import { findAllSymbols, findSymbol, normalizeLookupPath } from './symbol-resolution';

export { getExploreBudget, getExploreOutputBudget, type ExploreOutputBudget } from './explore-budget';
export { tools, type ToolDefinition, type ToolResult } from './tool-definitions';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;
const MAX_OVERVIEW_EXPAND_PATHS = 50;

/**
 * Node kinds that contain other symbols. For these, `solidkg_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

const CALLABLE_NODE_KINDS = new Set<string>(['method', 'function', 'component', 'constructor']);

const SEMANTIC_RELATION_MEMBER_CAP = 8;
const SCIP_FACT_SAMPLE_LIMIT = 5;

type ExploreSourceCompleteness = 'complete' | 'partial' | 'truncated' | 'omitted';
type ExploreFileSourceStatus = 'included' | 'partial' | 'omitted' | 'skipped' | 'unreadable';

interface ExploreSourceStatusSummary {
  included: number;
  partial: number;
  omitted: number;
  skipped: number;
  unreadable: number;
  hardTruncated: boolean;
}

const EXPLORE_SOURCE_COMPLETENESS_PLACEHOLDER = '__SOLIDKG_EXPLORE_SOURCE_COMPLETENESS__';
const EXPLORE_SOURCE_COMPLETENESS_NOTE_PLACEHOLDER = '__SOLIDKG_EXPLORE_SOURCE_COMPLETENESS_NOTE__';
const EXPLORE_ANSWER_PACKET_PLACEHOLDER = '__SOLIDKG_EXPLORE_ANSWER_PACKET__';

function formatExploreFileStatusLabel(status: ExploreFileSourceStatus): string {
  if (status === 'included') return 'complete';
  if (status === 'partial') return 'partial';
  if (status === 'omitted') return 'omitted';
  if (status === 'skipped') return 'skipped';
  return 'unreadable';
}

function trimExploreSourceMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const fallbackMarker = '\n... (trimmed) ...';
  const middleMarker = '\n... (trimmed middle; showing head and tail) ...\n';
  const available = maxChars - middleMarker.length;
  if (available < 200) {
    return text.slice(0, Math.max(0, maxChars - fallbackMarker.length)) + fallbackMarker;
  }

  const headBudget = Math.floor(available * 0.55);
  const tailBudget = available - headBudget;
  const headPrefix = text.slice(0, headBudget);
  const tailSuffix = text.slice(text.length - tailBudget);
  const headCut = headPrefix.lastIndexOf('\n');
  const tailCut = tailSuffix.indexOf('\n');
  const head = headCut > 0 ? headPrefix.slice(0, headCut) : headPrefix;
  const tail = tailCut >= 0 ? tailSuffix.slice(tailCut + 1) : tailSuffix;

  return `${head.trimEnd()}${middleMarker}${tail.trimStart()}`;
}

function normalizeExplorePathToken(value: string): string {
  return value
    .trim()
    .replace(/^[`'"(<[{]+/, '')
    .replace(/[`'"\])>}.,;:]+$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function basenameOfPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function exactExploreFileQueryTokens(query: string): Map<string, number> {
  const tokens = new Map<string, number>();
  let index = 0;
  for (const raw of query.split(/\s+/)) {
    const token = normalizeExplorePathToken(raw);
    if (!token || token.endsWith('/')) continue;

    const basename = basenameOfPath(token);
    if (!/^[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(basename)) continue;

    if (!tokens.has(token)) tokens.set(token, index);
    if (!tokens.has(basename.toLowerCase())) tokens.set(basename.toLowerCase(), index);
    index++;
  }
  return tokens;
}

function exactExploreSymbolQueryTokens(query: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const token = normalizeExplorePathToken(raw);
    if (!token) continue;

    const normalized = token.replace(/^#/, '');
    if (/^[a-z_$][a-z0-9_$]*$/i.test(token)) {
      tokens.add(token);
    }
    if (normalized !== token && /^[a-z_$][a-z0-9_$]*$/i.test(normalized)) {
      tokens.add(normalized);
    }
  }
  return tokens;
}

/**
 * Whether `solidkg_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `SOLIDKG_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.SOLIDKG_EXPLORE_LINENUMS !== '0';
}

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 *
 * Why the explicit openSync + O_NOFOLLOW dance instead of plain writeFileSync:
 * tmpdir() is world-writable on Linux (mode 1777), so on a shared multi-user
 * machine any other local user can pre-create `solidkg-consulted-<hash>` as
 * a symlink pointing at a file the victim owns. The old `writeFileSync` would
 * happily follow that link and overwrite the target's contents with the ISO
 * timestamp string (CWE-59). The session-id hash provides the predictability
 * gate, but it's defense-in-depth: if a session id ever surfaces in logs,
 * argv, or telemetry the attack becomes trivial, and the right fix is to not
 * follow links from /tmp paths in the first place.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `solidkg-consulted-${hash}`);
    // Refuse to follow a pre-planted symlink at the marker path (CWE-59).
    // O_NOFOLLOW (below) is the atomic, TOCTOU-free guard on POSIX, but it is
    // `undefined` on Windows (libuv ignores it), so the bitwise-OR silently
    // drops it and openSync would follow the link. This lstat check closes that
    // gap cross-platform; ENOENT (path is free) falls through to create it.
    try {
      if (lstatSync(markerPath).isSymbolicLink()) return;
    } catch {
      // No existing entry (or stat failed) — nothing to refuse; proceed.
    }
    // O_NOFOLLOW makes openSync throw ELOOP if markerPath is already a symlink.
    // O_CREAT + O_TRUNC keep the original "create-or-overwrite" semantics, and
    // mode 0o600 prevents readback by other local users (the marker payload is
    // benign, but narrowing the exposure costs nothing).
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
    const fd = openSync(markerPath, flags, 0o600);
    try {
      writeSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silently fail - don't break MCP on marker write failure. ELOOP from a
    // planted symlink lands here too, which is the intended behavior: refuse
    // to write rather than overwrite an attacker-chosen target.
  }
}

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their solidkg entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

function parseBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  fieldName: string
): number | string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `Invalid ${fieldName}. Expected a finite number between ${min} and ${max}.`;
  }
  if (value < min) {
    return `Invalid ${fieldName}. Expected a number between ${min} and ${max}.`;
  }
  return clamp(value, min, max);
}

function parseStrictBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  fieldName: string
): number | string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `Invalid ${fieldName}. Expected a finite number between ${min} and ${max}.`;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    return `Invalid ${fieldName}. Expected an integer between ${min} and ${max}.`;
  }
  return value;
}

/**
 * Tool handler that executes tools against a SolidKG instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened SolidKG instances for cross-project queries
  private projectCache: Map<string, SolidKG> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .solidkg/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();

  constructor(private cg: SolidKG | null, private defaultDataDir?: string) {}

  /**
   * Update the default SolidKG instance (e.g. after lazy initialization)
   */
  setDefaultSolidKG(cg: SolidKG): void {
    this.cg = cg;
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Whether a default SolidKG instance is available
   */
  hasDefaultSolidKG(): boolean {
    return this.cg !== null;
  }

  /**
   * Optional allowlist of exposed tools, parsed from the SOLIDKG_MCP_TOOLS
   * env var (comma-separated short names, e.g. "trace,search,node,context").
   * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
   * trim the tool surface without rebuilding the client config; the ablated
   * tool is then truly absent from ListTools rather than merely denied on call.
   * Matching is on the short form, so "trace" and "solidkg_trace" both work.
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.SOLIDKG_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const short = (s: string) => s.trim().replace(/^solidkg_/, '');
    const entries = raw.split(',').map(short).filter((entry) => entry.length > 0);
    const set = new Set<string>(entries);
    return set.size ? set : null;
  }

  /** Whether a tool name passes the SOLIDKG_MCP_TOOLS allowlist (if any). */
  private isToolAllowed(name: string): boolean {
    const allow = this.toolAllowlist();
    return !allow || allow.has(name.replace(/^solidkg_/, ''));
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The solidkg_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the SOLIDKG_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    const visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^solidkg_/, '')))
      : tools;
    const visibleWithDataDir = withDataDirSchemas(visible);
    if (!this.cg) return visibleWithDataDir;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      return visibleWithDataDir.map(tool => {
        if (tool.name === 'solidkg_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return visibleWithDataDir;
    }
  }

  /**
   * Get SolidKG instance for a project
   *
   * If projectPath is provided, opens that project's SolidKG (cached).
   * Otherwise returns the default SolidKG instance.
   *
   * Walks up parent directories to find the nearest .solidkg/ folder,
   * similar to how git finds .git/ directories.
   */
  private getSolidKG(projectPath?: string, dataDirArg?: string): SolidKG {
    const dataDir = dataDirArg ? resolvePath(dataDirArg) : this.defaultDataDir;
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new Error(
          'No SolidKG project is loaded for this session.\n' +
          `Searched for a .solidkg/ directory starting from: ${searched}\n` +
          'The index is likely fine — this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]'
        );
      }
      return this.cg;
    }

    const cacheKey = `${resolvePath(projectPath)}\0${dataDir ?? ''}`;

    // Check cache first (using original path as key)
    if (this.projectCache.has(cacheKey)) {
      return this.projectCache.get(cacheKey)!;
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .solidkg/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new Error(pathError);
      }
    }

    // Walk up parent directories to find nearest .solidkg/
    const resolvedRoot = findNearestSolidKGRoot(projectPath, { dataDir });

    if (!resolvedRoot) {
      throw new Error(`SolidKG not initialized in ${projectPath}. Run 'solidkg init' in that project first.`);
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; on the wasm backend (no WAL) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. Deliberately
    // not cached under projectPath — the server owns and closes the default
    // instance, so routing it through projectCache.closeAll() would double-close it.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot && this.cg.getDataDir() === (dataDir ?? this.cg.getDataDir())) {
      return this.cg;
    }

    // Check if we already have this resolved root cached (different path, same project)
    const resolvedCacheKey = `${resolvePath(resolvedRoot)}\0${dataDir ?? ''}`;
    if (this.projectCache.has(resolvedCacheKey)) {
      const cg = this.projectCache.get(resolvedCacheKey)!;
      // Cache under original path too for faster future lookups
      this.projectCache.set(cacheKey, cg);
      return cg;
    }

    // Open and cache under both paths
    const cg = SolidKG.openSync(resolvedRoot, { dataDir });
    this.projectCache.set(resolvedCacheKey, cg);
    if (cacheKey !== resolvedCacheKey) {
      this.projectCache.set(cacheKey, cg);
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  private parseOverviewExpandPaths(value: unknown): string[] | ToolResult {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return this.errorResult('expandPaths must be an array of strings');
    if (value.length > MAX_OVERVIEW_EXPAND_PATHS) {
      return this.errorResult(`expandPaths must contain at most ${MAX_OVERVIEW_EXPAND_PATHS} paths`);
    }
    const paths: string[] = [];
    for (const [index, entry] of value.entries()) {
      const checked = this.validateOptionalPath(entry, `expandPaths[${index}]`);
      if (typeof checked === 'object' && checked !== undefined) return checked;
      if (checked !== undefined) paths.push(checked);
    }
    return paths;
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();
    const cached = this.worktreeMismatchCache.get(startPath);
    if (cached !== undefined) return cached;

    let mismatch: WorktreeIndexMismatch | null = null;
    try {
      mismatch = detectWorktreeIndexMismatch(startPath, this.getSolidKG(projectPath).getProjectRoot());
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      mismatch = null;
    }
    this.worktreeMismatchCache.set(startPath, mismatch);
    return mismatch;
  }

  /**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's (issue #155). Without this, an agent in a nested worktree
   * silently trusts main-branch results. No-op on error results and when there
   * is no mismatch. `solidkg_status` is excluded — it embeds its own verbose
   * warning — so it stays out of this path.
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * it sees per path; here we intersect "files referenced in this response"
   * against that pending set and prepend a compact banner so the agent can
   * fall back to Read for those *specific* files without waiting for the
   * debounced sync to fire. Other pending files in the project (not
   * referenced by this response) get a small footer so the agent has a
   * complete picture without bloating the banner.
   *
   * Cost when nothing is pending — the common case — is one boolean check.
   * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
   */
  private withStalenessNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;

    let cg: SolidKG;
    try {
      cg = this.getSolidKG(projectPath);
    } catch {
      return result; // no default project — leave as is
    }

    // Cross-project `projectPath` calls open a cached SolidKG WITHOUT a
    // watcher (watchers are only attached to the default session project).
    // When the cross-project path happens to be the same project as the
    // default cg, the cached instance is the wrong one — its pendingFiles is
    // permanently empty. Detect the equal-path case and prefer the default
    // cg so the staleness signal still fires when an agent passes the
    // explicit projectPath form of its own project.
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot may throw on a closed instance — leave cg as is */
      }
    }

    // Defensive: some test fakes inject a partial SolidKG stub without the
    // newer pending-files API. Treat missing/throwing as "no pending files."
    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    const elsewhere: PendingFile[] = [];
    for (const p of pending) {
      // Substring match against the project-relative POSIX path — that's
      // exactly the format both the watcher and every solidkg response
      // emit, so a plain includes() is sufficient and avoids regex pitfalls.
      if (text.includes(p.path)) inResponse.push(p);
      else elsewhere.push(p);
    }

    let banner = '';
    if (inResponse.length > 0) {
      banner = formatStaleBanner(inResponse);
    }
    let footer = '';
    if (elsewhere.length > 0) {
      footer = formatStaleFooter(elsewhere);
    }
    if (!banner && !footer) return result;

    const composed = [banner, text, footer].filter(Boolean).join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Honor the optional tool allowlist (SOLIDKG_MCP_TOOLS): a trimmed
      // surface rejects ablated tools defensively even if a client cached them.
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via SOLIDKG_MCP_TOOLS`);
      }
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      const dataDirCheck = this.validateOptionalPath(args.dataDir, 'dataDir');
      if (typeof dataDirCheck === 'object' && dataDirCheck !== undefined) {
        return dataDirCheck;
      }
      // The `path` and `pattern` properties used by solidkg_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      // Read tools resolve through a single result variable so cross-cutting
      // notices — worktree-index mismatch (issue #155) and per-file
      // staleness (issue #403) — can be applied in one place. status embeds
      // its own verbose worktree warning but still flows through the
      // staleness wrapper so its pending-files section stays consistent
      // with what the read tools surface.
      let result: ToolResult;
      switch (toolName) {
        case 'solidkg_search':
          result = await this.handleSearch(args); break;
        case 'solidkg_context':
          result = await this.handleContext(args); break;
        case 'solidkg_callers':
          result = await this.handleCallers(args); break;
        case 'solidkg_callees':
          result = await this.handleCallees(args); break;
        case 'solidkg_impact':
          result = await this.handleImpact(args); break;
        case 'solidkg_explore':
          result = await this.handleExplore(args); break;
        case 'solidkg_node':
          result = await this.handleNode(args); break;
        case 'solidkg_precise_refs':
          result = await this.handlePreciseRefs(args); break;
        case 'solidkg_status':
          // status embeds the pending-files list as a first-class section
          // (see handleStatus), so we skip the auto-banner wrapper here to
          // avoid duplicating the same info at the top of the response.
          return await this.handleStatus(args);
        case 'solidkg_files':
          result = await this.handleFiles(args); break;
        case 'solidkg_snapshot':
          result = await this.handleSnapshot(args); break;
        case 'solidkg_architecture':
          result = await this.handleArchitecture(args); break;
        case 'solidkg_trace':
          result = await this.handleTrace(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      result = this.redactToolResult(result);
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      return this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle solidkg_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const kind = args.kind as string | undefined;
    const limit = parseBoundedNumber(args.limit, 10, 1, 100, 'limit');
    if (typeof limit === 'string') return this.errorResult(limit);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(this.withAnswerPacket(
        `No results found for "${query}"`,
        buildFailureAnswerPacket({
          query,
          tool: 'solidkg_search',
          uncertaintyLabels: ['bounded_no_results'],
          message: `No results found for "${query}"`,
          suggestedNextTools: ['solidkg_context'],
        })
      ));
    }

    const exactSameName = results.filter((result) => result.node.name === query);
    const uncertaintyLabels: UncertaintyLabel[] = exactSameName.length > 1 ? ['ambiguous_symbol'] : [];
    const formatted = this.withAnswerPacket(
      this.formatSearchResults(query, results),
      buildNodeAnswerPacket({
        query,
        tool: 'solidkg_search',
        nodes: results.map((result) => result.node),
        uncertaintyLabels,
        rankingReasons: this.searchRankingReasonsForPacket(results),
        suggestedNextTools: this.searchSuggestedNextTools(query, results),
      })
    );
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle solidkg_context
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const task = this.validateString(args.task, 'task');
    if (typeof task !== 'string') return task;

    // Mark session as consulted (enables Grep/Glob/Bash)
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      markSessionConsulted(sessionId);
    }

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const maxNodes = parseStrictBoundedNumber(args.maxNodes, 20, 1, 200, 'maxNodes');
    if (typeof maxNodes === 'string') return this.errorResult(maxNodes);
    const includeCode = args.includeCode !== false;
    const rawDetailLevel = args.detailLevel === undefined ? 'standard' : args.detailLevel;
    if (rawDetailLevel !== 'standard' && rawDetailLevel !== 'minimal') {
      return this.errorResult('Invalid detailLevel. Expected standard or minimal.');
    }
    const detailLevel: 'standard' | 'minimal' = rawDetailLevel;
    const maxCodeBlocks = args.maxCodeBlocks === undefined ? undefined : parseStrictBoundedNumber(args.maxCodeBlocks, 5, 0, 50, 'maxCodeBlocks');
    if (typeof maxCodeBlocks === 'string') return this.errorResult(maxCodeBlocks);

    const contextOptions = {
      maxNodes,
      includeCode,
      detailLevel,
      format: 'markdown' as const,
      ...(maxCodeBlocks !== undefined ? { maxCodeBlocks } : {}),
    };

    const context = await cg.buildContext(task, contextOptions);

    // Detect if this looks like a feature request (vs bug fix or exploration)
    const isFeatureQuery = this.looksLikeFeatureRequest(task);
    const reminder = isFeatureQuery
      ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria'
      : '';

    // buildContext returns string when format is 'markdown'
    if (typeof context === 'string') {
      return this.textResult(this.truncateOutput(context + reminder));
    }

    // If it returns TaskContext, format it
    return this.textResult(this.truncateOutput(this.formatTaskContext(context) + reminder));
  }

  /**
   * Heuristic to detect if a query looks like a feature request
   */
  private looksLikeFeatureRequest(task: string): boolean {
    const featureKeywords = [
      'add', 'create', 'implement', 'build', 'enable', 'allow',
      'new feature', 'support for', 'ability to', 'want to',
      'should be able', 'need to add', 'swap', 'edit', 'modify'
    ];
    const bugKeywords = [
      'fix', 'bug', 'error', 'broken', 'crash', 'issue', 'problem',
      'not working', 'fails', 'undefined', 'null'
    ];
    const explorationKeywords = [
      'how does', 'where is', 'what is', 'find', 'show me',
      'explain', 'understand', 'explore'
    ];

    const lowerTask = task.toLowerCase();

    // If it's clearly a bug or exploration, not a feature
    if (bugKeywords.some(k => lowerTask.includes(k))) return false;
    if (explorationKeywords.some(k => lowerTask.includes(k))) return false;

    // If it matches feature keywords, it's likely a feature request
    return featureKeywords.some(k => lowerTask.includes(k));
  }

  private redactToolResult(result: ToolResult): ToolResult {
    if (result.isError) return result;
    return {
      ...result,
      content: result.content.map((entry) => ({
        ...entry,
        text: redactSensitiveText(entry.text),
      })),
    };
  }

  /**
   * Handle solidkg_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const limit = parseBoundedNumber(args.limit, 20, 1, 100, 'limit');
    if (typeof limit === 'string') return this.errorResult(limit);

    const allMatches = findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate callers across all matching symbols
    const seen = new Set<string>();
    const edgeSeen = new Set<string>();
    const allCallers: Node[] = [];
    const allEdges: Edge[] = [];
    const detailedResults = [];
    for (const node of allMatches.nodes) {
      const detailed = cg.getCallersDetailed(node.id);
      detailedResults.push(detailed);
      for (const c of detailed.entries) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          allCallers.push(c.node);
        }
        const edgeKey = `${c.edge.source}->${c.edge.target}:${c.edge.kind}:${c.edge.line ?? ''}:${c.edge.column ?? ''}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          allEdges.push(c.edge);
        }
      }
    }

    const displayed = allCallers.slice(0, limit);
    const packet = this.formatGraphTraversalPacket('direct_callers', allMatches.nodes.map((node) => node.id), 'reverse', ['calls'], 1, allCallers.map((node) => node.id), allEdges, detailedResults.map((entry) => entry.traversal), relationCountsForEdges(allEdges), allCallers.length > limit);
    if (allCallers.length === 0) {
      return this.textResult(`No callers found for "${symbol}"\n\n${packet}${allMatches.note}`);
    }

    const formatted = [
      this.formatNodeList(displayed, `Callers of ${symbol}`, allCallers.length),
      packet,
    ].join('\n\n') + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle solidkg_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const limit = parseBoundedNumber(args.limit, 20, 1, 100, 'limit');
    if (typeof limit === 'string') return this.errorResult(limit);

    const allMatches = findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate callees across all matching symbols
    const seen = new Set<string>();
    const edgeSeen = new Set<string>();
    const allCallees: Node[] = [];
    const allEdges: Edge[] = [];
    const detailedResults = [];
    for (const node of allMatches.nodes) {
      const detailed = cg.getCalleesDetailed(node.id);
      detailedResults.push(detailed);
      for (const c of detailed.entries) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          allCallees.push(c.node);
        }
        const edgeKey = `${c.edge.source}->${c.edge.target}:${c.edge.kind}:${c.edge.line ?? ''}:${c.edge.column ?? ''}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          allEdges.push(c.edge);
        }
      }
    }

    const displayed = allCallees.slice(0, limit);
    const packet = this.formatGraphTraversalPacket('direct_callees', allMatches.nodes.map((node) => node.id), 'forward', ['calls'], 1, allCallees.map((node) => node.id), allEdges, detailedResults.map((entry) => entry.traversal), relationCountsForEdges(allEdges), allCallees.length > limit);
    if (allCallees.length === 0) {
      return this.textResult(`No callees found for "${symbol}"\n\n${packet}${allMatches.note}`);
    }

    const formatted = [
      this.formatNodeList(displayed, `Callees of ${symbol}`, allCallees.length),
      packet,
    ].join('\n\n') + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle solidkg_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const depth = parseBoundedNumber(args.depth, 2, 1, 10, 'depth');
    if (typeof depth === 'string') return this.errorResult(depth);

    const allMatches = findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate impact across all matching symbols
    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();
    const impactTraversals: GraphTraversalResult[] = [];

    for (const node of allMatches.nodes) {
      const impact = cg.getImpactRadius(node.id, depth);
      impactTraversals.push(cg.getImpactTraversal(node.id, depth));
      for (const [id, n] of impact.nodes) {
        mergedNodes.set(id, n);
      }
      for (const e of impact.edges) {
        const key = `${e.source}->${e.target}:${e.kind}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          mergedEdges.push(e);
        }
      }
    }

    const mergedImpact = {
      nodes: mergedNodes,
      edges: mergedEdges,
      roots: allMatches.nodes.map(n => n.id),
    };

    const traversalPacketResult = mergeTraversalResults(allMatches.nodes.map((node) => node.id), impactTraversals);
    const relationCounts = relationCountsForEdges(traversalPacketResult.edges);
    const formattedImpact = [
      this.formatImpact(symbol, mergedImpact),
      this.formatGraphTraversalPacket('impact', allMatches.nodes.map((node) => node.id), 'reverse', Object.keys(relationCounts) as EdgeKind[], depth, traversalPacketResult.nodeIds, traversalPacketResult.edges, [traversalPacketResult], relationCounts, false),
    ].join('\n\n');
    const formatted = this.appendImpactContextBudget(formattedImpact) + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  private async handlePreciseRefs(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 50;
    const limit = clamp(requestedLimit, 1, 500);
    const filter = {
      includeDefinitions: args.includeDefinitions !== false,
      includeReferences: args.includeReferences !== false,
      includeImplementations: args.includeImplementations !== false,
      includeTypeDefinitions: args.includeTypeDefinitions !== false,
      limit,
    };

    const nodeIdArg = args.nodeId;
    const symbolArg = args.symbol;
    if (nodeIdArg !== undefined) {
      const nodeId = this.validateString(nodeIdArg, 'nodeId');
      if (typeof nodeId !== 'string') return nodeId;
      const node = cg.getNode(nodeId);
      if (!node) return this.textResult(`Node "${nodeId}" not found`);
      const symbol = node.scipSymbol ?? node.name;
      const lines = this.formatPreciseRefs(
        cg,
        symbol,
        node,
        filter
      );
      return this.textResult(this.truncateOutput(lines));
    }

    if (symbolArg === undefined) {
      return this.textResult('Provide either `nodeId` or `symbol`.');
    }
    const symbol = this.validateString(symbolArg, 'symbol');
    if (typeof symbol !== 'string') return symbol;
    const matches = cg.findPreciseSymbols(symbol, 10);
    if (matches.length === 0) {
      const lines = ['## Precise references', '', `No SCIP symbol or linked node found for "${symbol}".`];
      return this.textResult(lines.join('\n'));
    }

    const sections: string[] = ['## Precise references', ''];
    for (const match of matches.slice(0, 10)) {
      sections.push(this.formatPreciseRefs(cg, match.symbol.symbol, match.node, filter, true));
      sections.push('');
    }
    if (matches.length > 10) {
      sections.push(`_+${matches.length - 10} more SCIP symbol matches omitted._`);
    }
    return this.textResult(this.truncateOutput(sections.join('\n')));
  }

  private formatPreciseRefs(
    cg: SolidKG,
    symbol: string,
    node: Node | undefined,
    filter: {
      includeDefinitions: boolean;
      includeReferences: boolean;
      includeImplementations: boolean;
      includeTypeDefinitions: boolean;
      limit: number;
    },
    nested = false
  ): string {
    const definitions = filter.includeDefinitions
      ? cg.getPreciseOccurrencesForSymbol(symbol, 'definition', filter.limit)
      : [];
    const references = filter.includeReferences
      ? cg.getPreciseOccurrencesForSymbol(symbol, 'reference', filter.limit)
      : [];
    const implementations = filter.includeImplementations
      ? cg.getPreciseRelationshipsForSymbol(symbol, filter.limit, 'implementation')
      : [];
    const typeDefinitions = filter.includeTypeDefinitions
      ? cg.getPreciseRelationshipsForSymbol(symbol, filter.limit, 'typeDefinition')
      : [];
    const lines = nested
      ? [`### ${node?.name ?? symbol}`, '', `**Symbol:** ${symbol}`]
      : ['## Precise references', '', `**Symbol:** ${symbol}`];
    lines.push('**Provenance:** scip');
    if (node) lines.push(`**Node:** ${node.name} (${node.kind})`, `**Node ID:** ${node.id}`);
    lines.push('');
    if (definitions.length === 0 && references.length === 0 && implementations.length === 0 && typeDefinitions.length === 0) {
      lines.push('No SCIP references linked for this symbol.');
      return lines.join('\n');
    }

    if (filter.includeDefinitions) {
      lines.push('#### Definitions');
      this.pushOccurrenceLines(lines, definitions, filter.limit);
    }

    if (filter.includeReferences) {
      lines.push('', '#### References');
      this.pushOccurrenceLines(lines, references, filter.limit);
    }

    if (filter.includeImplementations) {
      lines.push('', '#### Implementations');
      this.pushRelationshipLines(lines, implementations, symbol, filter.limit);
    }

    if (filter.includeTypeDefinitions) {
      lines.push('', '#### Type definitions');
      this.pushRelationshipLines(lines, typeDefinitions, symbol, filter.limit);
    }

    return lines.join('\n');
  }

  private pushOccurrenceLines(
    lines: string[],
    occurrences: Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }>,
    limit: number
  ): void {
    if (occurrences.length === 0) {
      lines.push('- None');
      return;
    }
    for (const occurrence of occurrences.slice(0, limit)) {
      lines.push(`- ${occurrence.document.repoRelativePath}:${occurrence.startLine}:${occurrence.startCharacter}`);
    }
    if (occurrences.length > limit) lines.push(`- +${occurrences.length - limit} more`);
  }

  private pushRelationshipLines(lines: string[], relationships: ScipRelationshipRecord[], symbol: string, limit: number): void {
    if (relationships.length === 0) {
      lines.push('- None');
      return;
    }
    for (const relationship of relationships.slice(0, limit)) {
      const direction = relationship.sourceSymbol === symbol ? 'to' : 'from';
      const other = relationship.sourceSymbol === symbol ? relationship.targetSymbol : relationship.sourceSymbol;
      lines.push(`- ${direction} ${other}`);
    }
    if (relationships.length > limit) lines.push(`- +${relationships.length - limit} more`);
  }

  private formatCompactScipFacts(cg: SolidKG, node: Node): string {
    if (!node.scipSymbol) return '';
    const definitions = cg.getPreciseOccurrencesForSymbol(node.scipSymbol, 'definition', SCIP_FACT_SAMPLE_LIMIT);
    const references = cg.getPreciseOccurrencesForSymbol(node.scipSymbol, 'reference', SCIP_FACT_SAMPLE_LIMIT);
    const implementations = cg.getPreciseRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'implementation');
    const typeDefinitions = cg.getPreciseRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'typeDefinition');
    if (definitions.length === 0 && references.length === 0 && implementations.length === 0 && typeDefinitions.length === 0) return '';
    return `**SCIP precise refs available:** ${node.scipSymbol}. Provenance: scip. Use \`solidkg_precise_refs\` with \`nodeId: "${node.id}"\` for exact bounded locations.`;
  }

  /**
   * Handle solidkg_trace — shortest CALL PATH between two symbols.
   *
   * Exposes GraphTraverser.findPath: the chain of functions from `from` to `to`,
   * each hop annotated with file:line and the call-site line. This is the
   * capability grep/Read structurally cannot provide. When no static path
   * exists, the chain has almost certainly broken at dynamic dispatch
   * (callbacks, descriptors, metaclasses) — we say so and surface the start
   * symbol's outgoing calls so the agent bridges the one missing hop with
   * solidkg_node rather than blindly reading.
   */
  private async handleTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const from = this.validateString(args.from, 'from');
    if (typeof from !== 'string') return from;
    const to = this.validateString(args.to, 'to');
    if (typeof to !== 'string') return to;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const fromMatches = findAllSymbols(cg, from, { exactQualified: true });
    if (fromMatches.nodes.length === 0) return this.textResult(this.withAnswerPacket(
      `Symbol "${from}" not found in the codebase`,
      buildFailureAnswerPacket({
        query: `${from} -> ${to}`,
        tool: 'solidkg_trace',
        uncertaintyLabels: ['bounded_no_results'],
        message: `Symbol "${from}" not found in the codebase`,
        suggestedNextTools: ['solidkg_search'],
        includeReturnedEvidenceActionability: true,
      })
    ));
    const toMatches = findAllSymbols(cg, to, { exactQualified: true });
    if (toMatches.nodes.length === 0) return this.textResult(this.withAnswerPacket(
      `Symbol "${to}" not found in the codebase`,
      buildFailureAnswerPacket({
        query: `${from} -> ${to}`,
        tool: 'solidkg_trace',
        uncertaintyLabels: ['bounded_no_results'],
        message: `Symbol "${to}" not found in the codebase`,
        suggestedNextTools: ['solidkg_search'],
        includeReturnedEvidenceActionability: true,
      })
    ));

    const fromAmbiguity = this.ambiguousUnqualifiedCallableEndpoint(from, fromMatches.nodes);
    if (fromAmbiguity) return this.textResult(this.formatTraceAmbiguity(from, fromAmbiguity));
    const toAmbiguity = this.ambiguousUnqualifiedCallableEndpoint(to, toMatches.nodes);
    if (toAmbiguity) return this.textResult(this.formatTraceAmbiguity(to, toAmbiguity));

    // Trace along call edges only — a true call path. Names can map to several
    // nodes, so try a few from×to candidate pairs until a usable path turns up.
    //
    // MAX_HOPS guard: a BFS shortest path longer than this on a dense call graph
    // is almost always a spurious wander through unrelated code (django's
    // `_fetch_all → … → execute_sql` BFS detours through prefetch/filter), not
    // the real execution flow — and a confident-but-wrong 15-hop trace is worse
    // than none. Over-cap paths are rejected and reported as "no direct path"
    // (which, on real code, means the flow breaks at dynamic dispatch).
    const edgeKinds: Edge['kind'][] = ['calls'];
    const MAX_HOPS = 7;
    const fromTry = fromMatches.nodes.slice(0, 3);
    const toTry = toMatches.nodes.slice(0, 3);
    let path: Array<{ node: Node; edge: Edge | null }> | null = null;
    let overCap: Array<{ node: Node; edge: Edge | null }> | null = null;
    for (const f of fromTry) {
      for (const t of toTry) {
        const p = cg.findPath(f.id, t.id, edgeKinds);
        if (!p || p.length <= 1) continue;
        if (p.length <= MAX_HOPS) { path = p; break; }
        if (!overCap || p.length < overCap.length) overCap = p;
      }
      if (path) break;
    }

    if (!path) {
      // No static path — almost always a dynamic-dispatch break. Surface the
      // start symbol's outgoing calls so the agent can bridge the gap.
      const start = fromTry[0]!;
      const callees = cg.getCallees(start.id).slice(0, 10)
        .map(c => `${c.node.name} (${c.node.filePath}:${c.node.startLine})`);
      const lines = [
        `No static path found from "${from}" to "${to}". This is not proof of absence.`,
        '',
        `Frontier: ${start.name} (${start.filePath}:${start.startLine})`,
        '',
        (overCap
          ? `(Only a ${overCap.length}-hop indirect chain connects them — almost certainly a BFS wander through unrelated code, not the real flow.) `
          : '') +
        'The direct chain most likely breaks at **dynamic dispatch** (a callback, descriptor, ' +
        'metaclass, or attribute-as-callable) that static parsing cannot resolve into an edge. ' +
        `Inspect \`${start.name}\` (${start.filePath}:${start.startLine}) with solidkg_node ` +
        '(includeCode=true) — its body usually shows the dynamic call to follow next.',
      ];
      if (callees.length > 0) {
        lines.push('', `**${start.name} statically calls:** ${callees.join(', ')}`);
      }
      return this.textResult(this.withAnswerPacket(
        lines.join('\n') + fromMatches.note + toMatches.note,
        buildNodeAnswerPacket({
          query: `${from} -> ${to}`,
          tool: 'solidkg_trace',
          nodes: [start],
          canAnswerFromReturnedContext: false,
          uncertaintyLabels: ['bounded_no_static_path'],
          actionabilityInput: {
            noStaticPath: true,
            sourceCoverage: 'complete',
            freshness: this.traceFreshness(cg, [start]),
            capState: 'uncapped',
            evidenceProvenance: ['static'],
            nextAction: {
              action: 'inspect_frontier',
              reason: 'Follow the named frontier; no static path is not proof of absence.',
            },
          },
          suggestedNextTools: ['solidkg_node', 'solidkg_explore'],
          includeReturnedEvidenceActionability: true,
        })
      ));
    }

    const fileCache = new Map<string, string[]>();
    const pathBodies = path.map((step) => ({
      nodeId: step.node.id,
      body: this.sourceRangeAt(cg, step.node.filePath, step.node.startLine, step.node.endLine, fileCache, 60, 1800),
    }));
    const dest = path[path.length - 1]!.node;
    const destCallees = cg.getCallees(dest.id)
      .filter(c => !path.some(p => p.node.id === c.node.id))
      .slice(0, 6);
    const destBodies = destCallees.map((c) => ({
      nodeId: c.node.id,
      body: this.sourceRangeAt(cg, c.node.filePath, c.node.startLine, c.node.endLine, fileCache, 16, 600),
    }));
    const hasCappedReturnedSource = [...pathBodies, ...destBodies].some((entry) => entry.body?.truncated);
    const hasMissingReturnedSource = [...pathBodies, ...destBodies].some((entry) => entry.body === null);
    let sourceCoverage: 'complete' | 'truncated' | 'omitted' = hasMissingReturnedSource ? 'omitted' : hasCappedReturnedSource ? 'truncated' : 'complete';
    const hasHeuristicEvidence = path.some((step) => step.edge?.provenance === 'heuristic');
    const capabilityFootprint = formatTraceCapabilityFootprint(cg, path.map((step) => step.node));

    const traceBodyLines: string[] = [];
    // Inline what each hop needs so the agent doesn't Read/Grep to get it: the
    // call-site source line, the registration site for dynamic-dispatch hops, AND
    // the hop's own body (capped per hop so the trace stays path-scoped). Earlier
    // versions inlined only the call-site line, which left agents calling explore
    // or Read for the bodies — the exact follow-up the ablation experiment measured.
    for (let i = 0; i < path.length; i++) {
      const step = path[i]!;
      if (step.edge) {
        const synth = this.synthEdgeNote(step.edge);
        if (synth) {
          traceBodyLines.push(`   ↓ ${synth.label}`);
          if (synth.registeredAt) {
            const regSrc = this.sourceLineAt(cg, synth.registeredAt, fileCache);
            traceBodyLines.push(`     ↳ registered at ${synth.registeredAt}${regSrc ? `   ${regSrc}` : ''}`);
          }
        } else {
          // The call happens in the PREVIOUS hop's file at edge.line.
          const prev = path[i - 1];
          const ref = prev && step.edge.line ? `${prev.node.filePath}:${step.edge.line}` : undefined;
          const callSrc = this.sourceLineAt(cg, ref, fileCache);
          traceBodyLines.push(`   ↓ ${step.edge.kind}${step.edge.line ? `@${step.edge.line}` : ''}${callSrc ? `   ${callSrc}` : ''}`);
        }
      }
      traceBodyLines.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine}-${step.node.endLine})`);
      const scipFacts = this.formatCompactScipFacts(cg, step.node);
      if (scipFacts) traceBodyLines.push(`   ${scipFacts}`);
      const body = pathBodies[i]?.body;
      if (body) traceBodyLines.push(body.text);
    }
    // The "last mile": what the destination does next. Agents otherwise explore/Read
    // for exactly this (e.g. renderStaticScene → _renderStaticScene → the canvas draw),
    // so inlining the destination's callees is what actually stops the investigation —
    // sufficiency, not a "don't explore" instruction.
    if (destCallees.length > 0) {
      traceBodyLines.push('', `### \`${dest.name}\` then calls (the destination's immediate work):`);
      for (let i = 0; i < destCallees.length; i++) {
        const c = destCallees[i]!;
        traceBodyLines.push('', `- ${c.node.name} (${c.node.filePath}:${c.node.startLine}-${c.node.endLine})`);
        const body = destBodies[i]?.body;
        if (body) traceBodyLines.push(body.text);
      }
    }
    const renderTracePacket = (): string => {
      const uncertaintyLabels: UncertaintyLabel[] = [
        ...(hasHeuristicEvidence ? ['heuristic_edge' as const] : []),
        ...(sourceCoverage === 'complete' ? [] : ['source_partial' as const]),
      ];
      return formatAnswerPacketMarkdown(buildNodeAnswerPacket({
        query: `${from} -> ${to}`,
        tool: 'solidkg_trace',
        nodes: path.map((step) => step.node),
        uncertaintyLabels,
        actionabilityInput: {
          sourceCoverage,
          freshness: this.traceFreshness(cg, path.map((step) => step.node)),
          capState: sourceCoverage === 'truncated' ? 'capped' : 'uncapped',
          evidenceProvenance: hasHeuristicEvidence ? ['heuristic'] : ['static'],
          hasHeuristicEvidence,
          hasCappedRequiredFacts: sourceCoverage === 'truncated',
        },
        rankingReasons: [
          { kind: 'graph_relationship', label: `${path.length} trace hop(s) returned with source bodies`, weight: 100 },
          { kind: 'source_returned', label: 'Trace inlined each hop body and destination callees', weight: 90 },
        ],
        suggestedNextTools: [],
        includeReturnedEvidenceActionability: true,
      })).trimEnd();
    };
    const renderTraceOutput = (): string => [
      `## Trace: ${from} → ${to}`,
      '',
      sourceCoverage !== 'complete'
        ? `Execution path below — ${path.length} hops, with incomplete returned source for one or more bodies. Use focused follow-up before treating omitted lines as covered.`
        : `Full execution path below — ${path.length} hops, each with its body, plus what the destination calls. This is the complete returned flow for explanation/localization.`,
      '',
      `${path.length} hops:`,
      '',
      renderTracePacket(),
      ...(capabilityFootprint ? ['', capabilityFootprint] : []),
      '',
      ...traceBodyLines,
      '',
      sourceCoverage !== 'complete'
        ? '> Path nodes and destination calls are inlined above, but at least one expected returned body is incomplete; run focused SolidKG follow-up before relying on omitted lines.'
        : '> Full path + every hop body + the destination\'s calls are inlined above for explanation/localization; a Read is only needed to chase a specific local variable\'s data-flow.',
    ].join('\n');
    let output = renderTraceOutput();
    if (sourceCoverage === 'complete' && output.length > MAX_OUTPUT_LENGTH) {
      sourceCoverage = 'truncated';
      output = renderTraceOutput();
    }
    return this.textResult(this.truncateOutput(output));
  }

  /**
   * Describe a synthesized (dynamic-dispatch) edge for human output: how the
   * callback was wired up — the bridge static parsing can't see. Returns null
   * for ordinary static edges. Used by trace + the node trail so a synthesized
   * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
   */
  private synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
    if (!edge || edge.provenance !== 'heuristic') return null;
    const m = edge.metadata as Record<string, unknown> | undefined;
    const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
    const at = registeredAt ? ` @${registeredAt}` : '';
    if (m?.synthesizedBy === 'callback') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
      const field = m.field ? ` on .${String(m.field)}` : '';
      return {
        label: `callback (heuristic) — registered via ${via}${field}${at} (dynamic dispatch)`,
        compact: `dynamic: callback via ${via} (heuristic)${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'event-emitter') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
      return {
        label: `event-emitter (heuristic) — event ${ev}${at} emit → handler (dynamic dispatch)`,
        compact: `dynamic: event-emitter (heuristic) event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'react-render') {
      const via = m.via ? String(m.via) : 'setState';
      return {
        label: `React re-render (heuristic) — \`${via}\` re-runs render()${at} (dynamic dispatch)`,
        compact: `dynamic: React re-render via ${via} (heuristic)${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'jsx-render') {
      const child = m.via ? `<${String(m.via)}>` : 'a child component';
      const localFlow = this.localFlowNote(m);
      const localFlowText = localFlow ? `; ${localFlow}` : '';
      return {
        label: `jsx-render (heuristic) — renders ${child}${at}${localFlowText} (dynamic dispatch)`,
        compact: `dynamic: jsx-render (heuristic) ${child}${at}${localFlowText}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'vue-handler') {
      const ev = m.event ? `@${String(m.event)}` : 'a template event';
      return {
        label: `vue-handler (heuristic) — Vue template handler bound to ${ev}${at} (dynamic dispatch)`,
        compact: `dynamic: vue-handler (heuristic) ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'interface-impl') {
      const via = m.via ? ` via \`${String(m.via)}\`` : '';
      return {
        label: `interface-impl (heuristic) — interface/abstract dispatch${via}${at} runs the implementation override (dynamic dispatch)`,
        compact: `dynamic: interface-impl (heuristic)${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'rn-event-channel') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'a native event';
      return {
        label: `rn-event-channel (heuristic) — React Native event ${ev}${at} crosses native → JS handler (dynamic dispatch)`,
        compact: `dynamic: rn-event-channel (heuristic) event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'fabric-native-impl') {
      const component = m.componentName ? `\`${String(m.componentName)}\`` : 'a Fabric component';
      return {
        label: `fabric-native-impl (heuristic) — Fabric component ${component}${at} reaches native implementation (dynamic dispatch)`,
        compact: `dynamic: fabric-native-impl (heuristic) ${component}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'flutter-build') {
      const via = m.via ? `\`${String(m.via)}\`` : '`setState`';
      return {
        label: `flutter-build (heuristic) — ${via} schedules build()${at} (dynamic dispatch)`,
        compact: `dynamic: flutter-build (heuristic) via ${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'cpp-override') {
      const via = m.via ? ` via \`${String(m.via)}\`` : '';
      return {
        label: `cpp-override (heuristic) — virtual dispatch${via}${at} runs the override implementation (dynamic dispatch)`,
        compact: `dynamic: cpp-override (heuristic)${via}${at}`,
        registeredAt,
      };
    }
    return null;
  }

  private localFlowNote(metadata: Record<string, unknown> | undefined): string | null {
    const localFlow = metadata?.localFlow;
    if (!localFlow || typeof localFlow !== 'object') return null;
    const candidate = localFlow as Record<string, unknown>;
    if (candidate.kind !== 'jsx-prop-handoff') return null;
    const props = Array.isArray(candidate.props)
      ? candidate.props.filter((prop): prop is string => typeof prop === 'string' && prop.length > 0)
      : [];
    if (props.length === 0) return null;
    const confidence = typeof candidate.confidence === 'number'
      ? `, confidence ${candidate.confidence.toFixed(2)}`
      : '';
    const capped = candidate.capped === true ? ', capped' : '';
    return `local prop handoff ${props.map((prop) => `\`${prop}\``).join(', ')} (heuristic incomplete${confidence}${capped})`;
  }

  /**
   * Read one trimmed source line at "relpath:line" (relative to the project
   * root). `cache` holds split file contents so a multi-hop trace reads each
   * file at most once. Returns null if the file/line can't be resolved.
   */
  private sourceLineAt(cg: SolidKG, ref: string | undefined, cache: Map<string, string[]>): string | null {
    if (!ref) return null;
    const i = ref.lastIndexOf(':');
    if (i < 0) return null;
    const filePath = ref.slice(0, i);
    const line = parseInt(ref.slice(i + 1), 10);
    if (!Number.isFinite(line) || line < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = this.resolveIndexedSourcePath(cg, filePath);
      if (!abs || !existsSync(abs)) return null;
      let loaded: string[];
      try { loaded = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, loaded);
      fileLines = loaded;
    }
    const raw = fileLines[line - 1];
    if (raw == null) return null;
    const t = raw.trim();
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
  }

  /**
   * Read a hop's body — filePath lines [startLine..endLine] — for inlining into
   * a trace, capped (lines + chars) so the whole path stays path-scoped even on
   * a 7-hop chain. Dedents to the body's own indentation and marks truncation.
   * Shares `cache` with sourceLineAt so each file is read at most once per trace.
   */
  private sourceRangeAt(
    cg: SolidKG,
    filePath: string,
    startLine: number,
    endLine: number,
    cache: Map<string, string[]>,
    maxLines = 28,
    maxChars = 1200
  ): { text: string; truncated: boolean } | null {
    if (!Number.isFinite(startLine) || startLine < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = this.resolveIndexedSourcePath(cg, filePath);
      if (!abs || !existsSync(abs)) return null;
      let loaded: string[];
      try { loaded = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, loaded);
      fileLines = loaded;
    }
    const end = Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine;
    let slice = fileLines.slice(startLine - 1, end);
    if (slice.length === 0) return null;
    let omitted = 0;
    if (slice.length > maxLines) { omitted = slice.length - maxLines; slice = slice.slice(0, maxLines); }
    const nonBlank = slice.filter(l => l.trim().length > 0);
    const dedent = nonBlank.length ? Math.min(...nonBlank.map(l => l.length - l.trimStart().length)) : 0;
    let text = slice.map((l, i) => `      ${startLine + i}\t${l.slice(dedent)}`).join('\n');
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).replace(/\n[^\n]*$/, '');
      omitted = Math.max(omitted, 1);
    }
    if (omitted > 0) text += `\n      … (+${omitted} more line${omitted === 1 ? '' : 's'})`;
    return { text, truncated: omitted > 0 };
  }

  private symbolIdentitySegments(node: Node): Set<string> {
    const segments = new Set<string>();
    const add = (value: string): void => {
      const normalized = value.replace(/\.[^.]+$/, '').toLowerCase();
      if (normalized.length >= 3) segments.add(normalized);
    };

    for (const part of (node.qualifiedName || '').split(/::|\./)) {
      if (part) add(part);
    }
    for (const part of node.filePath.split(/[\\/]/)) {
      if (part) add(part);
    }
    add(node.name);
    return segments;
  }

  private queryTokenSegments(token: string): string[] {
    return token
      .toLowerCase()
      .split(/::|[./]/)
      .map((part) => part.replace(/\.[^.]+$/, ''))
      .filter((part) => part.length >= 3);
  }

  private isAnchoredByOtherQueryToken(node: Node, token: string, tokens: string[]): boolean {
    const tokenLower = token.toLowerCase();
    const identitySegments = this.symbolIdentitySegments(node);
    for (const other of tokens) {
      const otherLower = other.toLowerCase();
      if (otherLower === tokenLower) continue;
      const parts = this.queryTokenSegments(other).filter((part) => part !== tokenLower);
      if (parts.some((part) => identitySegments.has(part))) return true;
    }
    return false;
  }

  private flowDisplayName(node: Node, nameCounts: Map<string, number>): string {
    if ((nameCounts.get(node.name) ?? 0) <= 1) return node.name;
    return `${node.name} [${node.filePath}:${node.startLine}]`;
  }

  private formatExploreFlowAmbiguity(symbol: string, nodes: Node[]): string {
    const candidates = nodes
      .slice(0, 8)
      .map((node) => `- ${node.name} (${node.kind}) at ${node.filePath}:${node.startLine}`);
    if (nodes.length > candidates.length) candidates.push(`- +${nodes.length - candidates.length} more`);
    return [
      `Ambiguous symbol "${symbol}": multiple callable endpoints match this unqualified name.`,
      'solidkg_explore omitted the Flow section rather than stitching a misleading same-name path.',
      'Use a qualified or path-qualified symbol so solidkg_explore can anchor the intended endpoint.',
      '',
      'Candidates:',
      ...candidates,
      '',
      '',
    ].join('\n');
  }

  /**
   * Flow-from-named-symbols: an agent's solidkg_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
  private buildFlowFromNamedSymbols(cg: SolidKG, query: string): string {
    try {
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$.:/$]*$/.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return '';
      // Pool of name SEGMENTS (Class + method from every token) used to
      // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
      // CONTAINER class is itself named in the query.
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      for (const t of tokens) {
        const cands = findAllSymbols(cg, t, { exactQualified: true }).nodes.filter((n) => CALLABLE_NODE_KINDS.has(n.kind));
        const isQualified = this.isQualifiedSymbol(t);
        if (isQualified && cands.length === 0) return '';
        let pick: Node[];
        if (!isQualified && cands.length > 1) {
          pick = cands.filter((n) => this.isAnchoredByOtherQueryToken(n, t, tokens));
          if (pick.length !== 1) return this.formatExploreFlowAmbiguity(t, cands);
        } else if (isQualified || cands.length <= 3) {
          pick = cands;
        } else {
          pick = cands.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        }
        for (const n of pick.slice(0, 6)) named.set(n.id, n);
        if (named.size > 40) break;
      }
      if (named.size < 2) return '';
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // BFS the full call graph (incl. synth edges) from each named seed, but
      // only ACCEPT a sink that is also named — both ends anchored to symbols the
      // agent named, so the chain stays on-topic while bridging intermediates
      // (e.g. the exact interface overload) that the token resolution missed.
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      if (!best || best.length < 3) return '';
      const nameCounts = new Map<string, number>();
      for (const step of best) nameCounts.set(step.node.name, (nameCounts.get(step.node.name) ?? 0) + 1);
      const out = ['## Flow (call path among the symbols you queried)', ''];
      for (let i = 0; i < best.length; i++) {
        const step = best[i]!;
        if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
        out.push(`${i + 1}. ${this.flowDisplayName(step.node, nameCounts)} (${step.node.filePath}:${step.node.startLine})`);
      }
      out.push('', '> Full source for these symbols is below; solidkg_trace(from,to) for the exact path between two endpoints.', '');
      return out.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Handle solidkg_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple solidkg_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    const queryRootLabel = this.extractQueryRootLabel(query);
    const failClosedAmbiguousUnlabeled = !queryRootLabel && query.includes('/') && !query.includes('@');
    const ambiguousTailPaths = failClosedAmbiguousUnlabeled
      ? this.ambiguousUnlabeledDuplicateFilePaths(subgraph.nodes.values())
      : new Set<string>();

    if (queryRootLabel) {
      for (const [id, node] of subgraph.nodes.entries()) {
        if (this.nodeRootLabel(node.filePath) !== queryRootLabel) {
          subgraph.nodes.delete(id);
        }
      }
      subgraph.edges = subgraph.edges.filter((edge) => subgraph.nodes.has(edge.source) && subgraph.nodes.has(edge.target));
      subgraph.roots = subgraph.roots.filter((id) => subgraph.nodes.has(id));
    }

    if (failClosedAmbiguousUnlabeled && ambiguousTailPaths.size > 0) {
      for (const [id, node] of subgraph.nodes.entries()) {
        if (ambiguousTailPaths.has(this.stripRootLabel(node.filePath))) {
          subgraph.nodes.delete(id);
        }
      }
      subgraph.edges = subgraph.edges.filter((edge) => subgraph.nodes.has(edge.source) && subgraph.nodes.has(edge.target));
      subgraph.roots = subgraph.roots.filter((id) => subgraph.nodes.has(id));
    }

    if (subgraph.nodes.size === 0) {
      return this.textResult(this.withAnswerPacket(
        `No relevant code found for "${query}"`,
        buildFailureAnswerPacket({
          query,
          tool: 'solidkg_explore',
          uncertaintyLabels: ['bounded_no_results'],
          message: `No relevant code found for "${query}"`,
          suggestedNextTools: ['solidkg_search'],
          includeReturnedEvidenceActionability: false,
        })
      ));
    }

    // Graph-aware glue: findRelevantContext builds the subgraph from name/text
    // search, so a method that BRIDGES named symbols — e.g. App.tsx's
    // triggerRender, which calls the named triggerUpdate — is never a search hit
    // and gets missed, forcing the agent to Read the file to trace it. Pull in
    // the callers/callees of the entry (root) nodes, but ONLY those that live in
    // files the subgraph already surfaces (where the agent reads to fill gaps),
    // so we add wiring without dragging in unrelated files. These get an
    // importance boost below so they survive the per-file cluster budget.
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const exactFileTokens = exactExploreFileQueryTokens(query);
    const exactSymbolTokens = exactExploreSymbolQueryTokens(query);
    const exactSymbolOrder = new Map([...exactSymbolTokens].map((token, index) => [token, index]));
    const hasSourcePathIntent = [...exactFileTokens.keys()].some(token => token.startsWith('source/') || token.startsWith('src/'));
    const isExactFilePathIntent = (filePath: string): boolean => {
      const normalizedPath = normalizeExplorePathToken(filePath);
      return exactFileTokens.has(normalizedPath) || exactFileTokens.has(basenameOfPath(normalizedPath));
    };
    const isExplicitFileHit = (node: Node): boolean => {
      if (node.kind !== 'file') return false;
      const filePath = normalizeExplorePathToken(node.filePath);
      const qualifiedName = normalizeExplorePathToken(node.qualifiedName ?? '');
      const name = normalizeExplorePathToken(node.name);
      return exactFileTokens.has(filePath) || exactFileTokens.has(qualifiedName) || exactFileTokens.has(name) || exactFileTokens.has(basenameOfPath(filePath));
    };
    const exactFileQueryOrder = (node: Node): number => {
      if (node.kind !== 'file') return Number.POSITIVE_INFINITY;
      const candidates = [
        normalizeExplorePathToken(node.filePath),
        normalizeExplorePathToken(node.qualifiedName ?? ''),
        normalizeExplorePathToken(node.name),
        basenameOfPath(normalizeExplorePathToken(node.filePath)),
      ];
      return Math.min(...candidates.map(token => exactFileTokens.get(token) ?? Number.POSITIVE_INFINITY));
    };

    for (const token of exactFileTokens.keys()) {
      for (const hit of cg.searchNodes(token, { limit: 20 })) {
        if (!isExplicitFileHit(hit.node)) continue;
        if (!subgraph.nodes.has(hit.node.id)) {
          subgraph.nodes.set(hit.node.id, hit.node);
        }
        if (!subgraph.roots.includes(hit.node.id)) {
          subgraph.roots.push(hit.node.id);
        }
      }
    }

    for (const token of exactSymbolTokens) {
      const exactSymbolHits = cg.searchNodes(token, { limit: 50 })
        .map(hit => hit.node)
        .filter(node => node.kind !== 'import' && node.kind !== 'export')
        .filter(node => node.name.toLowerCase().replace(/^#/, '') === token);
      const exactFileHits = exactSymbolHits.filter(node => isExactFilePathIntent(node.filePath));
      const selectedHits = exactFileHits.length > 0 ? exactFileHits : exactSymbolHits;
      for (const node of selectedHits.slice(0, 20)) {
        if (!subgraph.nodes.has(node.id)) {
          subgraph.nodes.set(node.id, node);
        }
        if (!subgraph.roots.includes(node.id)) {
          subgraph.roots.push(node.id);
        }
      }
    }

    const isLowValueExploreFile = (p: string) =>
      /\/(tests?|__tests?__|spec)\//i.test(p) ||
      /\bicons?\b/i.test(p) ||
      /\bi18n\b/i.test(p);

    const isSourceExploreFile = (filePath: string): boolean => {
      const normalizedPath = normalizeExplorePathToken(filePath);
      return (normalizedPath.startsWith('source/') || normalizedPath.startsWith('src/')) && !isLowValueExploreFile(normalizedPath);
    };

    const sourceQueryTermNodeIds = new Set<string>();
    const sourceImportNodeIds = new Set<string>();
    const sourceImportFileOrder = new Map<string, number>();
    const sourceAdjacentNodeIds = new Set<string>();
    const SOURCE_IMPORT_FILE_CAP = 20;
    if (hasSourcePathIntent) {
      const sourceQueryTerms = new Set([
        ...extractSearchTerms(query),
        ...exactSymbolTokens,
      ]);
      for (const term of sourceQueryTerms) {
        for (const hit of cg.searchNodes(term, { limit: 30 })) {
          const node = hit.node;
          if (node.kind === 'import' || node.kind === 'export') continue;
          if (!isSourceExploreFile(node.filePath)) continue;
          if (!node.name.toLowerCase().includes(term) && !node.filePath.toLowerCase().includes(term)) continue;

          if (!subgraph.nodes.has(node.id)) {
            subgraph.nodes.set(node.id, node);
          }
          sourceQueryTermNodeIds.add(node.id);
        }
      }

      const resolveRelativeImport = (fromFile: string, specifier: string): string | null => {
        if (!specifier.startsWith('.')) return null;
        const fromParts = fromFile.replace(/\\/g, '/').split('/');
        fromParts.pop();
        for (const part of specifier.split('/')) {
          if (!part || part === '.') continue;
          if (part === '..') fromParts.pop();
          else fromParts.push(part);
        }
        const base = fromParts.join('/');
        const candidates = /\.[A-Za-z0-9]+$/.test(base)
          ? [base]
          : [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`];
        return candidates.find(candidate => cg.getNodesInFile(candidate).length > 0 && isSourceExploreFile(candidate)) ?? null;
      };

      const importSeedFiles = new Set(
        [...subgraph.nodes.values()]
          .filter(node => isSourceExploreFile(node.filePath) && (subgraph.roots.includes(node.id) || isExactFilePathIntent(node.filePath) || sourceQueryTermNodeIds.has(node.id)))
          .map(node => node.filePath)
      );
      const importQueue = [...importSeedFiles].map(filePath => ({ filePath, depth: 0 }));
      const seenImportFiles = new Set(importSeedFiles);
      let sourceImportOrder = 0;
      while (importQueue.length > 0 && sourceImportFileOrder.size < SOURCE_IMPORT_FILE_CAP) {
        const current = importQueue.shift()!;
        const absPath = this.resolveIndexedSourcePath(cg, current.filePath);
        if (!absPath || !existsSync(absPath)) continue;
        let fileContent: string;
        try {
          fileContent = readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }

        const importSpecifiers = fileContent.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g);
        for (const match of importSpecifiers) {
          const importedFile = resolveRelativeImport(current.filePath, match[1] ?? '');
          if (!importedFile) continue;
          const isNewImportFile = !seenImportFiles.has(importedFile);
          if (isNewImportFile) {
            seenImportFiles.add(importedFile);
          }
          const importedFileKey = normalizeExplorePathToken(importedFile);
          if (!sourceImportFileOrder.has(importedFileKey)) {
            sourceImportFileOrder.set(importedFileKey, sourceImportOrder++);
          }
          for (const node of cg.getNodesInFile(importedFile)) {
            if (node.kind === 'import' || node.kind === 'export') continue;
            if (!subgraph.nodes.has(node.id)) {
              subgraph.nodes.set(node.id, node);
            }
            sourceImportNodeIds.add(node.id);
          }
          if (isNewImportFile && current.depth < 1) {
            importQueue.push({ filePath: importedFile, depth: current.depth + 1 });
          }
        }
      }

      const seedIds = [...subgraph.nodes.values()]
        .filter(node => isSourceExploreFile(node.filePath) && (subgraph.roots.includes(node.id) || isExactFilePathIntent(node.filePath) || sourceQueryTermNodeIds.has(node.id) || sourceImportNodeIds.has(node.id)))
        .map(node => node.id);
      const queue = seedIds.map(id => ({ id, depth: 0 }));
      const seen = new Set(seedIds);
      const SOURCE_ADJACENT_NODE_CAP = 40;

      while (queue.length > 0 && sourceAdjacentNodeIds.size < SOURCE_ADJACENT_NODE_CAP) {
        const current = queue.shift()!;
        const edges: Edge[] = [
          ...cg.getOutgoingEdges(current.id),
          ...cg.getIncomingEdges(current.id),
        ].filter(edge => edge.kind !== 'contains');

        for (const edge of edges) {
          if (sourceAdjacentNodeIds.size >= SOURCE_ADJACENT_NODE_CAP) break;
          const neighborId = edge.source === current.id ? edge.target : edge.source;
          if (seen.has(neighborId)) continue;
          const neighbor = cg.getNode(neighborId);
          if (!neighbor || neighbor.kind === 'import' || neighbor.kind === 'export') continue;
          if (!isSourceExploreFile(neighbor.filePath)) continue;

          seen.add(neighborId);
          if (!subgraph.nodes.has(neighbor.id)) {
            subgraph.nodes.set(neighbor.id, neighbor);
          }
          sourceAdjacentNodeIds.add(neighbor.id);
          if (current.depth < 1) {
            queue.push({ id: neighbor.id, depth: current.depth + 1 });
          }
        }
      }
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set(subgraph.roots);
    const sourceBodyEvidenceNodeIds = new Set(subgraph.chunkEvidenceNodeIds ?? []);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: entry point nodes worth 10, directly connected worth 3, others worth 1
      if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (sourceBodyEvidenceNodeIds.has(node.id)) {
        group.score += 9;
      } else if (sourceQueryTermNodeIds.has(node.id)) {
        group.score += 8;
      } else if (sourceImportNodeIds.has(node.id)) {
        group.score += 7;
      } else if (sourceAdjacentNodeIds.has(node.id)) {
        group.score += 6;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // Only include files that have entry points or nodes directly connected to entry points
    const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);
    const graphRankedFileScores = buildExploreGraphRankedFileScores(cg, fileGroups);

    // Sort files: highest relevance first, deprioritize low-value files
    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      const exactExploreFileTier = (filePath: string, nodes: Node[]): number => {
        const exactPath = isExactFilePathIntent(filePath);
        const exactPathOrder = exactPath
          ? Math.min(...nodes.map(exactFileQueryOrder))
          : Number.POSITIVE_INFINITY;
        if (exactPathOrder === 0) return 0;
        const lowValue = isLowValueExploreFile(filePath.toLowerCase());
        const sourceImportCount = nodes.filter(node => sourceImportNodeIds.has(node.id)).length;
        if (hasSourcePathIntent && sourceImportCount > 0 && !lowValue) return 1;
        const exactSymbolCount = nodes.filter(node => exactSymbolTokens.has(node.name.toLowerCase().replace(/^#/, ''))).length;
        if (exactSymbolCount > 0 && !lowValue) return 2;
        if (exactPath) return 3;
        if (exactSymbolCount > 0) return 4;
        return 5;
      };

      const aTier = exactExploreFileTier(a[0], a[1].nodes);
      const bTier = exactExploreFileTier(b[0], b[1].nodes);
      if (aTier !== bTier) return aTier - bTier;

      if (aTier >= 5) {
        const aGraphRank = graphRankedFileScores.get(a[0]) ?? 0;
        const bGraphRank = graphRankedFileScores.get(b[0]) ?? 0;
        if (Math.abs(aGraphRank - bGraphRank) > 0.000001) return bGraphRank - aGraphRank;
      }

      const intentScore = (filePath: string, nodes: Node[]): number => {
        const exactPath = isExactFilePathIntent(filePath);
        const exactPathOrder = exactPath
          ? Math.min(...nodes.map(exactFileQueryOrder))
          : Number.POSITIVE_INFINITY;
        const exactPathOrderScore = Number.isFinite(exactPathOrder)
          ? (exactPathOrder === 0 ? 900_000 : Math.max(0, 400_000 - exactPathOrder * 100_000))
          : 0;
        const exactSymbolCount = nodes.filter(node => exactSymbolTokens.has(node.name.toLowerCase().replace(/^#/, ''))).length;
        const exactSymbolOrderValue = exactSymbolCount > 0
          ? Math.min(...nodes.map(node => exactSymbolOrder.get(node.name.toLowerCase().replace(/^#/, '')) ?? Number.POSITIVE_INFINITY))
          : Number.POSITIVE_INFINITY;
        const exactSymbolOrderScore = Number.isFinite(exactSymbolOrderValue)
          ? Math.max(0, 800_000 - exactSymbolOrderValue * 100_000)
          : 0;
        const sourceBodyEvidenceCount = nodes.filter(node => sourceBodyEvidenceNodeIds.has(node.id)).length;
        const explicitFileNode = nodes.some(isExplicitFileHit);
        const sourceQueryTermCount = nodes.filter(node => sourceQueryTermNodeIds.has(node.id)).length;
        const sourceImportCount = nodes.filter(node => sourceImportNodeIds.has(node.id)).length;
        const sourceAdjacentCount = nodes.filter(node => sourceAdjacentNodeIds.has(node.id)).length;
        const sourceImportFileKey = normalizeExplorePathToken(filePath);
        const sourceImportOrderScore = sourceImportFileOrder.has(sourceImportFileKey) ? (SOURCE_IMPORT_FILE_CAP - sourceImportFileOrder.get(sourceImportFileKey)!) * 500_000 : 0;
        const lowValue = isLowValueExploreFile(filePath.toLowerCase());
        const exactSymbolWeight = lowValue && hasSourcePathIntent ? 20_000 : 200_000;
        const sourceBodyEvidenceScore = exactSymbolCount > 0 ? 0 : sourceBodyEvidenceCount * 260_000;
        const lowValuePenalty = lowValue ? (hasSourcePathIntent ? -250_000 : -5_000) : 0;
        return exactSymbolCount * exactSymbolWeight + exactSymbolOrderScore + exactPathOrderScore + sourceBodyEvidenceScore + sourceQueryTermCount * 250_000 + sourceImportCount * 220_000 + sourceImportOrderScore + sourceAdjacentCount * 150_000 + (exactPath ? 100_000 : 0) + (explicitFileNode ? 50_000 : 0) + lowValuePenalty;
      };

      const aIntent = intentScore(a[0], a[1].nodes);
      const bIntent = intentScore(b[0], b[1].nodes);
      if (aIntent !== bIntent) return bIntent - aIntent;

      const aExactFile = a[1].nodes.some(isExplicitFileHit);
      const bExactFile = b[1].nodes.some(isExplicitFileHit);
      if (aExactFile !== bExactFile) return aExactFile ? -1 : 1;
      if (aExactFile && bExactFile) {
        const aOrder = Math.min(...a[1].nodes.map(exactFileQueryOrder));
        const bOrder = Math.min(...b[1].nodes.map(exactFileQueryOrder));
        if (aOrder !== bOrder) return aOrder - bOrder;
      }

      // Check if any node name or file path relates to query terms
      const hasQueryRelevance = (filePath: string, nodes: Node[]) => {
        const fp = filePath.toLowerCase();
        if (queryTerms.some(t => fp.includes(t))) return true;
        return nodes.some(n => queryTerms.some(t => n.name.toLowerCase().includes(t)));
      };

      const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
      const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
      if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

      // Deprioritize test files, icon files, and i18n files
      const aLow = isLowValueExploreFile(aPath);
      const bLow = isLowValueExploreFile(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      `Source completeness: ${EXPLORE_SOURCE_COMPLETENESS_PLACEHOLDER}`,
      EXPLORE_ANSWER_PACKET_PLACEHOLDER,
      sourceBodyEvidenceNodeIds.size > 0 ? `Source body evidence: ${sourceBodyEvidenceNodeIds.size} chunk-seeded symbol(s) boosted file/source ranking.` : '',
      graphRankedFileScores.size > 0 ? 'Graph-ranked file allocation: personalized file-graph ranking was used after exact file/symbol tiers.' : '',
      '',
    ];

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
      lines.push('');

      const relationshipNameCounts = new Map<string, number>();
      for (const node of subgraph.nodes.values()) {
        if (node.kind === 'import' || node.kind === 'export') continue;
        relationshipNameCounts.set(node.name, (relationshipNameCounts.get(node.name) ?? 0) + 1);
      }

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({
          source: this.flowDisplayName(sourceNode, relationshipNameCounts),
          target: this.flowDisplayName(targetNode, relationshipNameCounts),
        });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code lines shown below are the **verbatim, current on-disk source** re-read from disk on this call and line-numbered. They are NOT a summary, outline, or stale cache. Check `Source completeness` above before treating the shown files as complete.');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    const shownFilePaths = new Set<string>();
    let hardOutputTruncated = false;
    const fileSourceStatuses = new Map<string, ExploreFileSourceStatus>();

    const applyFileSourceStatus = (filePath: string, status: ExploreFileSourceStatus): void => {
      const prev = fileSourceStatuses.get(filePath);
      if (!prev) {
        fileSourceStatuses.set(filePath, status);
        return;
      }
      const rank: Record<ExploreFileSourceStatus, number> = {
        unreadable: 5,
        skipped: 4,
        partial: 3,
        omitted: 2,
        included: 1,
      };
      if (rank[status] >= rank[prev]) {
        fileSourceStatuses.set(filePath, status);
      }
    };

    const classifyNonIncludedFile = (filePath: string): ExploreFileSourceStatus => {
      const absPath = this.resolveIndexedSourcePath(cg, filePath);
      if (!absPath || !existsSync(absPath)) return 'skipped';
      try {
        readFileSync(absPath, 'utf-8');
        return 'omitted';
      } catch {
        return 'unreadable';
      }
    };

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      if (totalChars > budget.maxOutputChars * 0.9) break;

      const absPath = this.resolveIndexedSourcePath(cg, filePath);
      if (!absPath || !existsSync(absPath)) {
        applyFileSourceStatus(filePath, 'skipped');
        continue;
      }

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        applyFileSourceStatus(filePath, 'unreadable');
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // Whole-small-file rule: if a relevant file is small enough to afford,
      // return it ENTIRELY instead of clustering. Clustering exists to tame
      // god-files (App.tsx ~13k lines); on a ~134-line component a cluster is a
      // lossy subset of a file the agent will just Read in full anyway — costing
      // a round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      const WHOLE_FILE_MAX_LINES = 220;
      const WHOLE_FILE_MAX_CHARS = budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;

        if (totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          const remaining = budget.maxOutputChars - totalChars - 200;
          if (remaining < 500) {
            applyFileSourceStatus(filePath, 'omitted');
            break;
          }
          wholeSection = wholeSection.slice(0, remaining) + '\n... (trimmed) ...';
          applyFileSourceStatus(filePath, 'partial');
        }
        const wholeStatus = fileSourceStatuses.get(filePath) ?? 'included';
        const wholeHeader = `#### ${filePath} [${formatExploreFileStatusLabel(wholeStatus)}] — ${omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')}`;
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        filesIncluded++;
        shownFilePaths.add(filePath);
        if (!fileSourceStatuses.has(filePath)) applyFileSourceStatus(filePath, 'included');
        continue;
      }

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope. Exact
      // file-node hits are preserved for pure filename queries, but not when
      // the same query also names specific symbols/terms in that file.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      const normalizedIntentName = (name: string): string => name.toLowerCase().replace(/^#/, '');
      const hasSpecificNonFileIntentInFile = group.nodes.some(n => {
        if (n.kind === 'file') return false;
        const name = normalizedIntentName(n.name);
        return exactSymbolTokens.has(name) || queryTerms.some(term => name === term || name.includes(term));
      });
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number; isExactQuerySymbol: boolean }> = group.nodes
        .filter(n => n.startLine > 0 && n.endLine > 0)
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5 && (!isExplicitFileHit(n) || hasSpecificNonFileIntentInFile)))
        .map(n => {
          let importance = 1;
          const intentName = normalizedIntentName(n.name);
          const isExactQuerySymbol = exactSymbolTokens.has(intentName);
          if (isExactQuerySymbol) importance = 25;
          else if (sourceBodyEvidenceNodeIds.has(n.id)) importance = 12;
          else if (entryNodeIds.has(n.id)) importance = 10;
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance, isExactQuerySymbol };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2, isExactQuerySymbol: false });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number; hasExactQuerySymbol: boolean }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
        hasExactQuerySymbol: ranges[0]!.isExactQuerySymbol,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
          current.hasExactQuerySymbol ||= r.isExactQuerySymbol;
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
            hasExactQuerySymbol: r.isExactQuerySymbol,
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      let fileTrimmed = false;
      const priorityRangesRaw = ranges
        .filter(r => r.isExactQuerySymbol || r.importance >= 3)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      const priorityRanges: Array<{ start: number; end: number; name: string; kind: string; isExactQuerySymbol: boolean }> = [];
      for (const r of priorityRangesRaw) {
        const previous = priorityRanges[priorityRanges.length - 1];
        if (previous && r.start <= previous.end + gapThreshold) {
          previous.end = Math.max(previous.end, r.end);
          previous.name += `, ${r.name}`;
          previous.kind = previous.isExactQuerySymbol || r.isExactQuerySymbol ? 'exact' : 'priority';
          previous.isExactQuerySymbol ||= r.isExactQuerySymbol;
        } else {
          priorityRanges.push({ start: r.start, end: r.end, name: r.name, kind: r.kind, isExactQuerySymbol: r.isExactQuerySymbol });
        }
      }
      const prioritySliceBudget = priorityRanges.length > 0
        ? Math.max(700, Math.floor((budget.maxCharsPerFile - Math.max(0, priorityRanges.length - 1) * GAP_MARKER.length) / priorityRanges.length))
        : 0;
      const buildPrioritySection = (r: { start: number; end: number }): string => {
        const section = buildSection(r);
        if (prioritySliceBudget > 0 && section.length > prioritySliceBudget) {
          fileTrimmed = true;
          return trimExploreSourceMiddle(section, prioritySliceBudget);
        }
        return section;
      };

      const selectedPieces: Array<{ start: number; end: number; section: string; symbols: string[]; source: 'exact' | 'cluster' }> = [];
      const exactReservedRanges: Array<{ start: number; end: number }> = [];
      let projectedChars = 0;
      for (const priorityRange of priorityRanges) {
        let section = buildPrioritySection(priorityRange);
        const gapLen = selectedPieces.length > 0 ? GAP_MARKER.length : 0;
        if (projectedChars + section.length + gapLen > budget.maxCharsPerFile) {
          const remaining = budget.maxCharsPerFile - projectedChars - gapLen;
          if (remaining < 500) continue;
          section = trimExploreSourceMiddle(section, remaining);
          fileTrimmed = true;
        }
        selectedPieces.push({
          start: priorityRange.start,
          end: priorityRange.end,
          section,
          symbols: [`${priorityRange.name}(${priorityRange.kind})`],
          source: 'exact',
        });
        exactReservedRanges.push({ start: priorityRange.start, end: priorityRange.end });
        projectedChars += section.length + gapLen;
      }

      const overlapsExactReservedRange = (cluster: { start: number; end: number }): boolean =>
        exactReservedRanges.some(range => cluster.start <= range.end && range.start <= cluster.end);

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      const chosenIndices = new Set<number>();
      for (const rc of rankedClusters) {
        if (overlapsExactReservedRange(rc.c)) continue;
        const sectionLen = buildSection(rc.c).length + (selectedPieces.length + chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (selectedPieces.length === 0 && chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > budget.maxCharsPerFile) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      const allSymbols: string[] = [];
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        selectedPieces.push({ start: cluster.start, end: cluster.end, section, symbols: cluster.symbols, source: 'cluster' });
      }

      selectedPieces.sort((a, b) => a.start - b.start || a.end - b.end || (a.source === 'exact' ? -1 : 1));
      let fileSection = '';
      for (const piece of selectedPieces) {
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += piece.section;
        allSymbols.push(...piece.symbols);
      }

      if (fileSection.length > budget.maxCharsPerFile) {
        fileSection = trimExploreSourceMiddle(fileSection, budget.maxCharsPerFile);
        fileTrimmed = true;
      }
      if (chosenIndices.size < clusters.length || fileTrimmed) {
        applyFileSourceStatus(filePath, 'partial');
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const effectiveStatus = fileSourceStatuses.get(filePath) ?? (fileTrimmed ? 'partial' : 'included');
      const fileHeader = `#### ${filePath} [${formatExploreFileStatusLabel(effectiveStatus)}] — ${headerSuffix}`;

      // Respect the total output cap on a file-by-file basis.
      if (totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        const remaining = budget.maxOutputChars - totalChars - 200;
        if (remaining < 500) {
          applyFileSourceStatus(filePath, 'omitted');
          break;
        }
        const trimmed = fileSection.slice(0, remaining) + '\n... (trimmed) ...';

        lines.push(fileHeader);
        lines.push('');
        lines.push('```' + lang);
        lines.push(trimmed);
        lines.push('```');
        lines.push('');
        totalChars += trimmed.length + 200;
        filesIncluded++;
        shownFilePaths.add(filePath);
        applyFileSourceStatus(filePath, 'partial');
        break;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
      shownFilePaths.add(filePath);
      if (!fileSourceStatuses.has(filePath)) applyFileSourceStatus(filePath, 'included');
    }

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    const directQueryFileGroups = new Map<string, { nodes: Node[]; score: number }>();
    for (const term of queryTerms.slice(0, 12)) {
      const directHits = cg.searchNodes(term, { limit: 20 });
      for (const hit of directHits) {
        const node = hit.node;
        if (node.kind === 'import' || node.kind === 'export') continue;
        const group = directQueryFileGroups.get(node.filePath) || { nodes: [], score: 0 };
        if (!group.nodes.some((existing) => existing.id === node.id)) {
          group.nodes.push(node);
        }
        group.score += 1;
        directQueryFileGroups.set(node.filePath, group);
      }
    }

    const remainingRelevant = sortedFiles.filter(([filePath]) => !shownFilePaths.has(filePath));
    const peripheralFiles = [...fileGroups.entries()]
      .filter(([, group]) => group.score < 3)
      .sort((a, b) => b[1].score - a[1].score);
    const knownRemaining = new Set<string>([
      ...remainingRelevant.map(([filePath]) => filePath),
      ...peripheralFiles.map(([filePath]) => filePath),
    ]);
    const directOnlyRemaining = [...directQueryFileGroups.entries()]
      .filter(([filePath]) => !shownFilePaths.has(filePath) && !knownRemaining.has(filePath));
    const remainingRelevantForCompleteness = [...remainingRelevant, ...directOnlyRemaining];
    const remainingFiles = [...remainingRelevantForCompleteness, ...peripheralFiles];
    for (const [filePath] of remainingRelevantForCompleteness) {
      if (!fileSourceStatuses.has(filePath)) {
        applyFileSourceStatus(filePath, classifyNonIncludedFile(filePath));
      }
    }

    const remainingWithDirectQueryMatch = remainingFiles.filter(([, group]) =>
      group.nodes.some((n) => queryTerms.some((t) => n.name.toLowerCase().includes(t)))
    );
    const remainingWithExactIntentMatch = remainingFiles.filter(([filePath, group]) =>
      isExactFilePathIntent(filePath) ||
      group.nodes.some((n) => exactSymbolTokens.has(n.name.toLowerCase().replace(/^#/, '')))
    );
    const completenessFocusPaths = new Set<string>(shownFilePaths);
    for (const [filePath] of remainingWithExactIntentMatch) {
      completenessFocusPaths.add(filePath);
    }
    if (budget.includeAdditionalFiles) {
      for (const [filePath] of remainingWithDirectQueryMatch) {
        completenessFocusPaths.add(filePath);
      }
    }

    if (budget.includeAdditionalFiles) {
      if (remainingFiles.length > 0) {
        const seenRemainingPaths = new Set<string>();
        const rankedRemainingFiles = [
          ...remainingWithDirectQueryMatch,
          ...remainingFiles,
        ].filter(([filePath]) => {
          if (seenRemainingPaths.has(filePath)) return false;
          seenRemainingPaths.add(filePath);
          return true;
        });

        lines.push('### Not shown above — explore these names for their source');
        lines.push('');
        lines.push('> Run another focused `solidkg_explore` (or `solidkg_node`/`solidkg_trace` for specific symbols) for these items before falling back to Read.');
        lines.push('');
        for (const [filePath, group] of rankedRemainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          const status = fileSourceStatuses.get(filePath);
          const statusHint = status ? ` [${formatExploreFileStatusLabel(status)}]` : '';
          lines.push(`- ${filePath}${statusHint}: ${symbols}`);
        }
        if (rankedRemainingFiles.length > 10) {
          lines.push(`- ... and ${rankedRemainingFiles.length - 10} more files`);
        }
      }
    }

    lines.push('');
    lines.push('---');
    lines.push(EXPLORE_SOURCE_COMPLETENESS_NOTE_PLACEHOLDER);

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Hard-cap to the adaptive budget. The per-file loop bounds the source
    // sections, but the relationship map, additional-files list, and
    // completeness/budget notes can still push the assembled output past
    // maxOutputChars (observed 30k against a 28k tier cap). A fat explore
    // payload persists in the agent's context and is re-read as cache-input
    // on every subsequent turn, so the overrun is paid many times over.
    const summarizeExploreSourceStatuses = (): ExploreSourceStatusSummary => {
      const summary: ExploreSourceStatusSummary = {
        included: 0,
        partial: 0,
        omitted: 0,
        skipped: 0,
        unreadable: 0,
        hardTruncated: hardOutputTruncated,
      };
      for (const [filePath, status] of fileSourceStatuses.entries()) {
        if (completenessFocusPaths.size > 0 && !completenessFocusPaths.has(filePath)) continue;
        if (status === 'included') summary.included++;
        else if (status === 'partial') summary.partial++;
        else if (status === 'omitted') summary.omitted++;
        else if (status === 'skipped') summary.skipped++;
        else if (status === 'unreadable') summary.unreadable++;
      }
      return summary;
    };

    const deriveExploreSourceCompleteness = (summary: ExploreSourceStatusSummary): ExploreSourceCompleteness => {
      if (summary.hardTruncated || summary.partial > 0) return 'truncated';
      if (summary.skipped > 0 || summary.unreadable > 0) return 'partial';
      if (summary.omitted > 0) return 'omitted';
      return 'complete';
    };

    const sourceSummary = summarizeExploreSourceStatuses();
    const sourceCompleteness = deriveExploreSourceCompleteness(sourceSummary);
    const renderExploreOutput = (status: ExploreSourceCompleteness, summary: ExploreSourceStatusSummary): string => {
      const statusLabel = this.formatExploreSourceCompletenessLabel(status, summary);
      const note = this.formatExploreSourceCompletenessNote(status, summary);
      const shownNodes = [...subgraph.nodes.values()].filter((node) => shownFilePaths.has(node.filePath));
      const flowOutput = this.buildFlowFromNamedSymbols(cg, query);
      const uncertaintyLabels: UncertaintyLabel[] = status === 'complete' ? [] : ['source_partial'];
      if (flowOutput.startsWith('Ambiguous symbol ')) uncertaintyLabels.push('ambiguous_symbol');
      if (subgraph.edges.some((edge) => edge.provenance === 'heuristic')) uncertaintyLabels.push('heuristic_edge');
      const packet = formatAnswerPacketMarkdown(buildNodeAnswerPacket({
        query,
        tool: 'solidkg_explore',
        nodes: shownNodes,
        canAnswerFromReturnedContext: shownNodes.length > 0 && status === 'complete' && !uncertaintyLabels.includes('ambiguous_symbol'),
        uncertaintyLabels,
        rankingReasons: [
          { kind: 'entry_point', label: `${subgraph.roots.length} query root(s) surfaced`, weight: 100 },
          ...(sourceBodyEvidenceNodeIds.size > 0 ? [{ kind: 'source_body_chunk', label: `${sourceBodyEvidenceNodeIds.size} source chunk body/code-token match(es) boosted exploration`, weight: 95 } as const] : []),
          { kind: 'source_returned', label: `${summary.included} file(s) included with source`, weight: 90 },
          { kind: 'graph_relationship', label: `${significantEdges.length} relationship(s) included`, weight: 70 },
        ],
        suggestedNextTools: status === 'complete' ? [] : ['solidkg_explore', 'solidkg_node'],
        includeReturnedEvidenceActionability: false,
      })).trimEnd();
      return (flowOutput + lines.join('\n'))
        .replace(EXPLORE_SOURCE_COMPLETENESS_PLACEHOLDER, statusLabel)
        .replace(EXPLORE_ANSWER_PACKET_PLACEHOLDER, packet)
        .replace(EXPLORE_SOURCE_COMPLETENESS_NOTE_PLACEHOLDER, note);
    };

    const output = renderExploreOutput(sourceCompleteness, sourceSummary);
    if (output.length > budget.maxOutputChars) {
      hardOutputTruncated = true;
      const truncatedSummary = summarizeExploreSourceStatuses();
      return this.textResult(this.truncateExploreOutputAtBoundary(renderExploreOutput('truncated', truncatedSummary), budget.maxOutputChars));
    }
    return this.textResult(output);
  }

  private formatExploreSourceCompletenessLabel(status: ExploreSourceCompleteness, summary: ExploreSourceStatusSummary): string {
    if (status !== 'partial') return status;
    const parts: string[] = [];
    if (summary.included > 0) parts.push(`${summary.included} included`);
    const skippedUnreadable = summary.skipped + summary.unreadable;
    if (skippedUnreadable > 0) parts.push(`${skippedUnreadable} skipped/unreadable`);
    if (summary.omitted > 0) parts.push(`${summary.omitted} omitted`);
    if (summary.partial > 0 || summary.hardTruncated) {
      parts.push(`${summary.partial + (summary.hardTruncated ? 1 : 0)} truncated/partial`);
    }
    if (parts.length === 0) return 'partial';
    return `partial (${parts.join(', ')})`;
  }

  private formatExploreSourceCompletenessNote(status: ExploreSourceCompleteness, summary: ExploreSourceStatusSummary): string {
    if (status === 'complete') {
      return `> Complete source is shown for ${summary.included} file${summary.included === 1 ? '' : 's'} above. Treat those source blocks as already Read; use another focused solidkg_explore only if your question needs a different symbol or file.`;
    }
    if (status === 'partial') {
      return '> Some relevant files were skipped or unreadable. Use the `Not shown above` list in another focused solidkg_explore call, then continue with solidkg_node/solidkg_trace for any remaining symbols before falling back to Read.';
    }
    if (status === 'omitted') {
      return '> Some relevant files were omitted from the source blocks. Use the `Not shown above` list (or a narrower symbol/file query) in another solidkg_explore call before falling back to Read.';
    }
    return '> Some source was truncated for size. Use another focused solidkg_explore or solidkg_node call for the specific missing symbol or line range before falling back to Read.';
  }

  private truncateExploreOutputAtBoundary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    const marker = '... (output truncated to budget; Source completeness: truncated. The response was cut at a markdown boundary; run another solidkg_explore with specific names for omitted areas.)';
    const prefix = text.slice(0, maxChars);
    const completePrefix = prefix.endsWith('\n') ? prefix : prefix.slice(0, prefix.lastIndexOf('\n'));
    const lines = completePrefix.split('\n');
    let offset = 0;
    let fenceCount = 0;
    let bestCut = -1;

    for (const line of lines) {
      const nextOffset = offset + line.length + 1;
      if (/^```/.test(line)) fenceCount++;
      if (fenceCount % 2 === 0 && this.isExploreMarkdownBoundary(line) && nextOffset <= maxChars) {
        bestCut = nextOffset;
      }
      offset = nextOffset;
    }

    let safe = bestCut > 0 ? text.slice(0, bestCut) : completePrefix;
    const openFenceCount = safe.match(/^```/gm)?.length ?? 0;
    if (openFenceCount % 2 !== 0) {
      safe = safe.trimEnd() + '\n```\n';
    }

    const lastLine = safe.trimEnd().split('\n').pop() ?? '';
    if (!this.isExploreMarkdownBoundary(lastLine)) {
      safe = safe.trimEnd() + '\n---\n';
    }

    return `${safe.trimEnd()}\n\n${marker}`;
  }

  private isExploreMarkdownBoundary(line: string): boolean {
    return (
      line === '```' ||
      line === '---' ||
      line === '... (trimmed) ...' ||
      /^\.\.\. \(trimmed middle/.test(line) ||
      /^#{2,4} /.test(line) ||
      /^> /.test(line) ||
      /^- /.test(line)
    );
  }

  /**
   * Handle solidkg_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;

    const match = findSymbol(cg, symbol);
    if (!match) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    let code: string | null = null;
    let outline: string | null = null;

    if (includeCode) {
      // For container symbols (class/interface/struct/…), the full body is the
      // sum of every method body — a wall of source (e.g. a 10k-char class)
      // that bloats context and is rarely needed in full. Return a structural
      // outline (members + signatures + line numbers) instead; the agent can
      // Read or solidkg_node a specific method for its body. Leaf symbols
      // (function/method/etc.) return their full body as before.
      if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
        outline = this.buildContainerOutline(cg, match.node);
      }
      if (!outline) {
        code = await cg.getCode(match.node.id);
      }
    }

    const trail = this.formatTrail(cg, match.node);
    const capabilityFootprint = formatNodeCapabilityFootprint(cg, match.node);
    const semanticRelations = this.formatSemanticRelations(cg, match.node);
    const scipFacts = this.formatNodeScipFacts(cg, match.node);
    const formatted = this.formatNodeDetails(match.node, code, outline) + scipFacts + capabilityFootprint + semanticRelations + trail + match.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  private isQualifiedSymbol(symbol: string): boolean {
    return /[.\/]|::/.test(symbol);
  }

  private ambiguousUnqualifiedCallableEndpoint(symbol: string, nodes: Node[]): Node[] | null {
    if (this.isQualifiedSymbol(symbol)) return null;
    const exactCallables = nodes.filter((node) => node.name === symbol && CALLABLE_NODE_KINDS.has(node.kind));
    return exactCallables.length > 1 ? exactCallables : null;
  }

  private traceFreshness(cg: SolidKG, nodes: Node[]): ReturnedEvidenceFreshness {
    if (nodes.length === 0) return 'unknown';
    const pending = cg.getPendingFiles();
    if (pending.length === 0) return 'fresh';
    const nodeFiles = new Set(nodes.map((node) => normalizeLookupPath(node.filePath)));
    return pending.some((pendingFile) => nodeFiles.has(normalizeLookupPath(pendingFile.path))) ? 'stale' : 'fresh';
  }

  private formatTraceAmbiguity(symbol: string, nodes: Node[]): string {
    const candidates = nodes
      .slice(0, 8)
      .map((node) => `- ${node.name} (${node.kind}) at ${node.filePath}:${node.startLine}`);
    if (nodes.length > candidates.length) candidates.push(`- +${nodes.length - candidates.length} more`);
    return this.withAnswerPacket([
      `Ambiguous symbol "${symbol}": multiple callable endpoints match this unqualified name.`,
      'Use a qualified or path-qualified symbol so solidkg_trace does not choose an arbitrary endpoint.',
      '',
      'Candidates:',
      ...candidates,
    ].join('\n'), buildFailureAnswerPacket({
      query: symbol,
      tool: 'solidkg_trace',
      uncertaintyLabels: ['ambiguous_symbol'],
      message: `Ambiguous symbol "${symbol}"`,
      actionabilityInput: {
        hasAmbiguity: true,
        sourceCoverage: 'complete',
        freshness: 'unknown',
        evidenceProvenance: ['static'],
        nextAction: {
          action: 'qualify_symbol',
          reason: 'Resolve the ambiguous endpoint before relying on this result.',
        },
      },
      suggestedNextTools: ['solidkg_trace', 'solidkg_search'],
      includeReturnedEvidenceActionability: true,
    }));
  }

  private withAnswerPacket(text: string, packet: ReturnType<typeof buildFailureAnswerPacket>): string {
    return `${text}\n\n${formatAnswerPacketMarkdown(packet).trimEnd()}`;
  }

  private formatNodeScipFacts(cg: SolidKG, node: Node): string {
    if (!node.scipSymbol) return '';
    const definitions = cg.getPreciseOccurrencesForSymbol(node.scipSymbol, 'definition', SCIP_FACT_SAMPLE_LIMIT);
    const references = cg.getPreciseOccurrencesForSymbol(node.scipSymbol, 'reference', SCIP_FACT_SAMPLE_LIMIT);
    const implementations = cg.getPreciseRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'implementation');
    const typeDefinitions = cg.getPreciseRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'typeDefinition');
    if (definitions.length === 0 && references.length === 0 && implementations.length === 0 && typeDefinitions.length === 0) return '';
    const lines = ['', '### Precise references (SCIP)', `**Symbol:** ${node.scipSymbol}`, `**Node ID:** ${node.id}`];
    lines.push('- Provenance: scip');
    lines.push(`- Definitions: ${definitions.slice(0, 3).map((occurrence) => `${occurrence.document.repoRelativePath}:${occurrence.startLine}:${occurrence.startCharacter}`).join(', ') || 'none'}`);
    lines.push(`- References: ${references.slice(0, 5).map((occurrence) => `${occurrence.document.repoRelativePath}:${occurrence.startLine}:${occurrence.startCharacter}`).join(', ') || 'none'}`);
    if (implementations.length > 0) lines.push(`- Implementations: ${implementations.map((relationship) => relationship.targetSymbol).join(', ')}`);
    if (typeDefinitions.length > 0) lines.push(`- Type definitions: ${typeDefinitions.map((relationship) => relationship.targetSymbol).join(', ')}`);
    return lines.join('\n');
  }

  private formatSemanticRelations(cg: SolidKG, node: Node): string {
    const relations = cg.getHyperedgesByNode(node.id).sort((a, b) =>
      a.hyperedge.kind.localeCompare(b.hyperedge.kind) ||
      a.hyperedge.id.localeCompare(b.hyperedge.id)
    );
    if (relations.length === 0) return '';

    const lines: string[] = ['', '### Semantic relations'];
    for (const relation of relations) {
      const selectedRoles = this.selectedNodeRoles(relation, node.id);
      const label = this.semanticRelationLabel(relation);
      const roleText = selectedRoles.length === 1 ? 'role' : 'roles';
      const provenance = this.semanticRelationProvenance(relation);
      const provenanceText = provenance ? ` — provenance: ${provenance}` : '';
      lines.push(`- **${relation.hyperedge.kind}** \`${label}\`${provenanceText} — this node ${roleText}: ${selectedRoles.join(', ')}`);

      const members = this.sortSemanticRelationMembers(relation);
      const displayedMembers = members.slice(0, SEMANTIC_RELATION_MEMBER_CAP);
      for (const member of displayedMembers) {
        const location = member.node.startLine ? `${member.node.filePath}:${member.node.startLine}` : member.node.filePath;
        lines.push(`  - ${member.role}: ${member.node.name} (${member.node.kind}, ${location})`);
      }
      if (members.length > SEMANTIC_RELATION_MEMBER_CAP) {
        lines.push(`  - +${members.length - SEMANTIC_RELATION_MEMBER_CAP} more members`);
      }
    }
    return lines.join('\n');
  }

  private selectedNodeRoles(relation: HyperedgeRelation, nodeId: string): string[] {
    return Array.from(new Set(this.sortSemanticRelationMembers(relation)
      .filter((member) => member.nodeId === nodeId)
      .map((member) => member.role)))
      .sort((a, b) => a.localeCompare(b));
  }

  private sortSemanticRelationMembers(relation: HyperedgeRelation): HyperedgeRelation['members'] {
    return [...relation.members].sort((a, b) =>
      a.ordinal - b.ordinal ||
      a.role.localeCompare(b.role) ||
      a.node.name.localeCompare(b.node.name) ||
      a.nodeId.localeCompare(b.nodeId)
    );
  }

  private semanticRelationLabel(relation: HyperedgeRelation): string {
    const metadata = relation.hyperedge.metadata ?? {};
    for (const key of ['channel', 'event', 'eventName', 'route', 'method', 'name', 'synthesizedBy']) {
      const value = metadata[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    if (relation.hyperedge.sourceFile) {
      return relation.hyperedge.line
        ? `${relation.hyperedge.sourceFile}:${relation.hyperedge.line}`
        : relation.hyperedge.sourceFile;
    }
    return relation.hyperedge.id;
  }

  private semanticRelationProvenance(relation: HyperedgeRelation): SemanticRelationProvenance | undefined {
    switch (relation.hyperedge.provenance) {
      case 'scip':
        return 'scip';
      case 'tree-sitter':
        return 'ast_static';
      case 'heuristic':
        return 'semantic_synthesis';
      default:
        return undefined;
    }
  }

  /**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:line — so solidkg_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling solidkg_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
  private formatTrail(cg: SolidKG, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
      const synth = this.synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    if (callees.length === 0 && callers.length === 0) return '';
    const lines: string[] = ['', '### Trail — use only for a specific missing hop'];
    lines.push('_For several related symbols, prefer one focused solidkg_explore instead of repeated solidkg_node calls._');
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * Handle solidkg_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    let cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    // Same trick as withStalenessNotice — when an explicit projectPath
    // resolves to the same project as the default session cg, prefer the
    // default so getPendingFiles() (only populated by the default's watcher)
    // is non-empty when there are pending edits.
    if (this.cg && cg !== this.cg) {
      try {
        if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
          cg = this.cg;
        }
      } catch { /* closed instance — leave as is */ }
    }
    const stats = cg.getStats();

    // Warn when this index actually belongs to a different git working tree
    // (e.g. the server resolved up from a nested worktree to the main checkout).
    // Queries then reflect that tree's branch, not the worktree being edited.
    // status shows the verbose, multi-line form; the read tools get the compact
    // one-liner via withWorktreeNotice. Both share the cached detection.
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '## SolidKG Status',
      '',
    ];
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Project root:** ${cg.getProjectRoot()}`,
      `**Data directory:** ${cg.getDataDir()}`,
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
    );
    if (typeof stats.hyperedgeCount === 'number') {
      lines.push(`**Total hyperedges:** ${stats.hyperedgeCount}`);
    }
    if (typeof stats.capabilityAssertionCount === 'number') {
      lines.push(`**Capability assertions:** ${stats.capabilityAssertionCount}`);
      lines.push(`**Capability producer runs:** ${stats.capabilityAnalysisRunCount ?? 0}`);
    }
    if (stats.scip && (stats.scip.indexes > 0 || stats.scip.symbols > 0 || stats.scip.occurrences > 0)) {
      lines.push(`**SCIP:** ${stats.scip.indexes} index(es), ${stats.scip.symbols} symbols, ${stats.scip.occurrences} occurrences, ${stats.scip.linkedNodes} linked nodes`);
    }
    const scipGeneration = stats.scip?.generation;
    if (scipGeneration && Object.keys(scipGeneration.languages).length > 0) {
      lines.push('', '### SCIP generation:');
      for (const status of Object.values(scipGeneration.languages).sort((left, right) => left.language.localeCompare(right.language))) {
        const detail = status.message ? ` (${status.message})` : '';
        lines.push(`- ${status.language}: ${status.state}${detail}`);
      }
    }
    lines.push(`**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    lines.push(`**SolidKG version:** ${stats.solidkgVersion ?? 'unknown'}`);

    // Surface the active SQLite backend (node:sqlite, Node's built-in real
    // SQLite — full WAL + FTS5, no native build).
    lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite supports WAL
    // everywhere, so a non-wal mode means the filesystem can't (network/
    // virtualized mounts, WSL2 /mnt). See issue #238.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    const hyperedgesByKind = stats.hyperedgesByKind
      ? Object.entries(stats.hyperedgesByKind)
        .filter(([, count]) => (count as number) > 0)
        .sort(([left], [right]) => left.localeCompare(right))
      : [];
    if (hyperedgesByKind.length > 0) {
      lines.push('', '### Hyperedges by Kind:');
      for (const [kind, count] of hyperedgesByKind) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Per-file freshness — the inverse of the auto-prepended staleness banner
    // (issue #403). Surfacing it inside `status` gives the agent a single
    // place to ask "is the index caught up?" rather than inferring from
    // banners on other tool calls.
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '### Pending sync:');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle solidkg_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const rawFormat = typeof args.format === 'string' ? args.format : 'tree';
    if (rawFormat !== 'tree' && rawFormat !== 'flat' && rawFormat !== 'grouped' && rawFormat !== 'overview') {
      return this.errorResult('Invalid format. Expected tree, flat, grouped, or overview.');
    }
    const format = rawFormat;
    const includeMetadata = args.includeMetadata !== false;
    const parsedMaxDepth = parseBoundedNumber(args.maxDepth, 1, 1, 20, 'maxDepth');
    if (typeof parsedMaxDepth === 'string') return this.errorResult(parsedMaxDepth);
    const maxDepth = args.maxDepth != null ? parsedMaxDepth : undefined;
    const parsedMaxEntries = parseStrictBoundedNumber(args.maxEntries, 160, 1, 1000, 'maxEntries');
    if (typeof parsedMaxEntries === 'string') return this.errorResult(parsedMaxEntries);
    const expandPaths = this.parseOverviewExpandPaths(args.expandPaths);
    if (!Array.isArray(expandPaths)) return expandPaths;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `solidkg index` first.');
    }

    // Filter by path prefix
    let files = pathFilter
      ? allFiles.filter(f => pathMatchesRootAwarePrefix(f.path, pathFilter))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // Format output
    let output: string;
    switch (format) {
      case 'overview':
        output = cg.getOverviewText({
          ...(pathFilter ? { path: pathFilter } : {}),
          ...(pattern ? { pattern } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          expandPaths,
          includeMetadata,
          maxEntries: parsedMaxEntries,
        });
        break;
      case 'flat':
        output = formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  private async handleSnapshot(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const action = typeof args.action === 'string' ? args.action : 'list';

    if (action === 'list') {
      const snapshots = await cg.listSnapshots();
      return this.textResult(formatSnapshotList(snapshots));
    }

    const label = this.validateString(args.label, 'label');
    if (typeof label !== 'string') return label;

    if (action === 'create') {
      let metadata: Record<string, unknown> | undefined;
      if (typeof args.metadataJson === 'string' && args.metadataJson.length > 0) {
        try {
          const parsed = JSON.parse(args.metadataJson) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return this.errorResult('metadataJson must be a JSON object');
          }
          metadata = parsed as Record<string, unknown>;
        } catch (err) {
          return this.errorResult(`metadataJson is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const snapshot = await cg.createSnapshot(label, {
        description: typeof args.description === 'string' ? args.description : undefined,
        metadata,
      });
      return this.textResult(JSON.stringify(snapshot, null, 2));
    }

    if (action === 'delete') {
      const deleted = await cg.deleteSnapshot(label);
      return this.textResult(deleted ? `Deleted snapshot "${label}".` : `Snapshot "${label}" not found.`);
    }

    if (action === 'diff') {
      const diff = await cg.diffSnapshot(label);
      return this.textResult(this.truncateOutput(formatSnapshotDiff(label, diff)));
    }

    return this.errorResult(`Unknown snapshot action: ${action}`);
  }

  private async handleArchitecture(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSolidKG(args.projectPath as string | undefined, args.dataDir as string | undefined);
    const action = typeof args.action === 'string' ? args.action : 'get';
    const layers = parseLayerRules(args.layersJson);
    if (typeof layers === 'string') return this.errorResult(layers);

    if (action === 'analyze') {
      const report = cg.analyzeArchitecture({ layers });
      return this.textResult(this.truncateOutput(formatArchitectureReport(report)));
    }

    if (action === 'get') {
      return this.textResult(this.truncateOutput(formatArchitectureReport(cg.getArchitecture())));
    }

    if (action === 'coupling') {
      return this.textResult(JSON.stringify(cg.getCoupling(), null, 2));
    }

    if (action === 'package') {
      const packageName = this.validateString(args.package, 'package');
      if (typeof packageName !== 'string') return packageName;
      return this.textResult(formatArchitecturePackageLookup(cg.getPackageLookup(packageName)));
    }

    return this.errorResult(`Unknown architecture action: ${action}`);
  }

  private getIndexedRootLabels(cg: SolidKG): Set<string> {
    const labels = new Set<string>();
    for (const file of cg.getFiles()) {
      const match = file.path.match(/^@([^/]+)\//);
      if (match?.[1]) labels.add(match[1]);
    }
    return labels;
  }

  private extractQueryRootLabel(query: string): string | null {
    const match = query.match(/@([^/\s]+)\//);
    return match?.[1] ?? null;
  }

  private stripRootLabel(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^@[^/]+\//, '');
  }

  private nodeRootLabel(filePath: string): string | null {
    const match = filePath.replace(/\\/g, '/').match(/^@([^/]+)\//);
    return match?.[1] ?? null;
  }

  private ambiguousUnlabeledDuplicateFilePaths(nodes: Iterable<Node>): Set<string> {
    const tailToRoots = new Map<string, Set<string>>();
    for (const node of nodes) {
      const tail = this.stripRootLabel(node.filePath);
      const roots = tailToRoots.get(tail) ?? new Set<string>();
      roots.add(this.nodeRootLabel(node.filePath) ?? '__unlabeled__');
      tailToRoots.set(tail, roots);
    }
    const ambiguous = new Set<string>();
    for (const [tail, roots] of tailToRoots.entries()) {
      if (roots.size > 1) ambiguous.add(tail);
    }
    return ambiguous;
  }

  private resolveIndexedSourcePath(cg: SolidKG, filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    const rootQualified = normalized.match(/^@([^/]+)\/(.*)$/);
    const sourceRoots = cg.getSourceRoots();

    if (rootQualified) {
      const [, label, relativePath] = rootQualified;
      const root = sourceRoots.find((entry) => entry.label === label);
      return root ? validatePathWithinRoot(root.rootDir, relativePath ?? '') : null;
    }

    if (sourceRoots.length === 1 && this.getIndexedRootLabels(cg).size === 0) {
      return validatePathWithinRoot(sourceRoots[0]!.rootDir, normalized);
    }

    return null;
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  private searchRankingReasonsForPacket(results: readonly SearchResult[]): RankingReason[] {
    const reasons = this.searchRankingReasons(results);
    const hasSourceBody = reasons.some((reason) => reason.kind === 'source_body_chunk');
    const packetReasons: RankingReason[] = [
      { kind: 'entry_point', label: `${results.length} relevant symbol anchor(s) returned`, weight: 100 },
    ];
    if (hasSourceBody) {
      packetReasons.push({
        kind: 'source_body_chunk',
        label: `${reasons.filter((reason) => reason.kind === 'source_body_chunk').length} source chunk body/code-token match(es) surfaced`,
        weight: 95,
      });
    }
    return packetReasons;
  }

  private searchRankingReasons(results: readonly SearchResult[]): SearchRankingReason[] {
    const byKey = new Map<string, SearchRankingReason>();
    for (const result of results) {
      for (const reason of result.rankingReasons ?? []) {
        const key = `${reason.kind}:${reason.evidence ?? reason.label}`;
        const existing = byKey.get(key);
        if (!existing || reason.weight > existing.weight) byKey.set(key, reason);
      }
    }
    return [...byKey.values()].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
  }

  private formatSearchResults(query: string, results: SearchResult[]): string {
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(`Node ID: ${node.id}`);
      lines.push(`${node.filePath}${location}`);
      if (node.scipSymbol) lines.push(`SCIP symbol: ${node.scipSymbol}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      if (result.rankingReasons && result.rankingReasons.length > 0) {
        lines.push(`Ranking evidence: ${result.rankingReasons.slice(0, 4).map((reason) => `${reason.kind}${reason.evidence ? ` (${reason.evidence})` : ''}`).join(', ')}`);
      }
      lines.push('');
    }

    lines.push(...this.formatSearchGuidance(query, results));

    return lines.join('\n');
  }

  private formatSearchGuidance(query: string, results: readonly SearchResult[]): string[] {
    const lines = ['### Search guidance:'];
    const exactSameName = results.filter((result) => result.node.name === query);
    const languages = [...new Set(results.map((result) => result.node.language))];
    const kinds = [...new Set(results.map((result) => result.node.kind))];
    const hasDampenedResult = results.some((result) => result.rankingReasons?.some((reason) => reason.kind === 'generated_or_test_dampening'));

    if (exactSameName.length > 1) {
      lines.push(`- Ambiguous name: ${exactSameName.length} exact "${query}" matches. Qualify before tracing or deep inspection.`);
    }
    if (languages.length > 1 || kinds.length > 1 || exactSameName.length > 1) {
      const languageHint = languages[0] ? `lang:${languages[0]}` : 'lang:<language>';
      const kindHint = kinds[0] ? `kind:${kinds[0]}` : 'kind:<kind>';
      const pathHint = results[0]?.node.filePath.split('/').slice(0, 3).join('/') || '<path-fragment>';
      lines.push(`- Use filters: ${languageHint} path:${pathHint} ${kindHint} name:${query}`);
    }
    if (hasDampenedResult) {
      lines.push('- Test/generated results were demoted; include test/generated terms only when those files are intended.');
    }
    lines.push('- Next: solidkg_context for task context; solidkg_explore for grouped source; solidkg_node for one symbol; solidkg_trace for known endpoints; solidkg_impact for blast radius.');

    return [...lines, ''];
  }

  private searchSuggestedNextTools(query: string, results: readonly SearchResult[]): string[] {
    const exactSameName = results.filter((result) => result.node.name === query);
    return exactSameName.length > 1
      ? ['solidkg_context', 'solidkg_explore', 'solidkg_node', 'solidkg_trace', 'solidkg_impact']
      : ['solidkg_context', 'solidkg_explore', 'solidkg_node'];
  }

  private formatNodeList(nodes: Node[], title: string, totalFound: number = nodes.length): string {
    const countLabel = totalFound === nodes.length ? `${nodes.length} found` : `${nodes.length} shown, ${totalFound} found`;
    const lines: string[] = [`## ${title} (${countLabel})`, ''];

    for (const node of nodes) {
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact: just name, kind, location
      lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}`);
    }

    return lines.join('\n');
  }

  private formatGraphTraversalPacket(
    queryKind: string,
    startNodeIds: readonly string[],
    direction: GraphTraversalDirection,
    edgeKinds: readonly EdgeKind[],
    maxDepth: number,
    resultNodeIds: readonly string[],
    edges: readonly Edge[],
    traversals: readonly GraphTraversalResult[],
    relationCounts: Partial<Record<EdgeKind, number>>,
    resultLimitHit: boolean,
  ): string {
    const limits = new Set<GraphTraversalLimit>();
    const ignoreDepthLimit = queryKind === 'direct_callers' || queryKind === 'direct_callees';
    for (const traversal of traversals) {
      for (const limit of traversal.coverage.limitsHit) {
        if (ignoreDepthLimit && limit === 'maxDepth') continue;
        limits.add(limit);
      }
    }
    if (resultLimitHit) limits.add('result_limit');
    const nodeIds = [...new Set([...startNodeIds, ...resultNodeIds])];
    const coverageStatus = limits.size > 0 ? 'partial' : resultNodeIds.length > 0 ? 'complete' : 'absent';
    const result: GraphTraversalResult = {
      nodeIds,
      edges: [...edges],
      paths: [],
      depthByNode: new Map(nodeIds.map((nodeId) => [nodeId, startNodeIds.includes(nodeId) ? 0 : 1])),
      coverage: {
        status: coverageStatus,
        limitsHit: [...limits].sort((left, right) => left.localeCompare(right)),
        staleInputs: [],
      },
    };
    return formatGraphTraversalPacketMarkdown(buildGraphTraversalPacket({
      queryKind,
      startNodeIds,
      direction,
      edgeKinds,
      maxDepth,
      limits: {
        maxNodes: 1000,
        maxEdges: 5000,
        budgetMs: 100,
      },
      result,
      relationCounts,
    })).trimEnd();
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `## Impact: "${symbol}" affects ${nodeCount} symbols`,
      '',
    ];

    // Group by file
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      // Compact: inline list
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(nodeList);
      lines.push('');
    }

    return lines.join('\n');
  }

  private appendImpactContextBudget(formattedImpact: string): string {
    try {
      const budget = buildContextBudget({
        baselineKind: 'not_available',
        outputChars: formattedImpact.length,
        notes: ['No changed-file or candidate-file baseline is available in this impact call.'],
      });
      return `${formattedImpact}\n\n${this.formatImpactContextBudget(budget)}`;
    } catch {
      return formattedImpact;
    }
  }

  private formatImpactContextBudget(budget: ContextBudget): string {
    return [
      '### Context Budget',
      `- estimated: ${budget.estimated}`,
      `- baselineKind: ${budget.baselineKind}`,
      `- baselineChars: ${budget.baselineChars}`,
      `- baselineTokens: ${budget.baselineTokens}`,
      `- outputChars: ${budget.outputChars}`,
      `- outputTokens: ${budget.outputTokens}`,
      `- savedTokens: ${budget.savedTokens}`,
      `- savedPercent: ${budget.savedPercent}`,
      `- estimatorVersion: ${budget.estimatorVersion}`,
      `- notes: ${budget.notes.join(' ')}`,
    ].join('\n');
  }

  /**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
  private buildContainerOutline(cg: SolidKG, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of children) {
      const loc = c.startLine ? `:${c.startLine}` : '';
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `## ${node.name} (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call solidkg_node on a specific member for its body.`);
    } else if (code) {
      // Line-numbered (cat -n style, like solidkg_explore and Read) so the
      // agent can cite/edit exact lines without re-Reading the file for them.
      const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
      lines.push('', '```' + node.language, numbered, '```');
    }

    return lines.join('\n');
  }

  private formatTaskContext(context: TaskContext): string {
    return context.summary || 'No context found';
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
