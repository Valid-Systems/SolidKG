/**
 * SolidKG Interactive Installer
 *
 * Multi-target: writes MCP server config + instructions for the
 * agents the user picks (Claude Code, Cursor, Codex CLI, opencode,
 * Hermes Agent).
 * Defaults to the Claude-only behavior for backwards compatibility
 * when no targets are explicitly chosen and nothing else is detected.
 *
 * Uses the terminal presenter for the interactive UI; `runInstallerWithOptions`
 * is the non-interactive entry point used by the `--target` /
 * `--print-config` CLI flags.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  ALL_TARGETS,
  detectAll,
  getTarget,
  resolveTargetFlag,
} from './targets/registry';
import type { AgentTarget, Location, TargetId, WriteResult } from './targets/types';
import { createTerminalPresenter, type TerminalPresenter } from '../ui/terminal';
// Import the lightweight submodules directly (not the ../sync barrel, which
// re-exports FileWatcher and would transitively pull in ../extraction — the
// installer must stay importable even when native modules can't load).
import { watchDisabledReason } from '../sync/watch-policy';
import { isGitRepo, isSyncHookInstalled, installGitSyncHook } from '../sync/git-hooks';

// Backwards-compat: keep these named exports — downstream code may
// import them. The shim in `config-writer.ts` continues to re-export
// them too.
export {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
} from './config-writer';
export type { InstallLocation } from './config-writer';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function cancelInstall(presenter: TerminalPresenter, message: string): never {
  presenter.warn(message);
  process.exit(0);
}

function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

export interface RunInstallerOptions {
  /** Comma-separated target list, or `auto` / `all` / `none`. */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Skip the auto-allow prompt; use this value directly. */
  autoAllow?: boolean;
  /**
   * Skip every confirm and use defaults: location=global,
   * autoAllow=true, target=auto. For scripting / CI.
   */
  yes?: boolean;
}

/**
 * Interactive entry point — preserves the historical UX (`solidkg
 * install` with no args goes through the prompts), but now starts
 * the targets multi-select pre-populated with detected agents.
 */
export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const presenter = createTerminalPresenter();

  presenter.intro(`SolidKG v${getVersion()}`);

  // --yes implies all defaults; explicit flags still win.
  const useDefaults = opts.yes === true;

  // Step 1: which agent targets? Asked FIRST so the user knows what
  // they're committing to before we touch npm or disk. Detection
  // probes the user-provided location if known, else 'global' as the
  // most common default — labels are a hint, not load-bearing.
  const detectionLocation: Location = opts.location ?? 'global';
  const targets = await resolveTargets(presenter, opts, detectionLocation, useDefaults);
  if (targets.length === 0) {
    presenter.outro('No agent targets selected — nothing to do.');
    return;
  }

  // Step 2: install the solidkg npm package on PATH (always offered;
  // matches existing behavior). Skipped when --yes (assume present).
  if (!useDefaults) {
    const shouldInstallGlobally = await presenter.confirm({
      message: 'Install the solidkg CLI on your PATH? (Required so agents can launch the MCP server)',
      initialValue: true,
    });
    if (shouldInstallGlobally === undefined) {
      cancelInstall(presenter, 'Installation cancelled.');
    }
    if (shouldInstallGlobally) {
      const spinner = presenter.spinner('Installing solidkg CLI...');
      spinner.start();
      try {
        execSync('npm install -g solidkg', { stdio: 'pipe' });
        await spinner.stop('Installed solidkg CLI on PATH');
      } catch {
        await spinner.stop('Could not install (permission denied)');
        presenter.warn('Try: sudo npm install -g solidkg');
      }
    } else {
      presenter.status('Skipped CLI install — agents will not be able to launch the MCP server without it');
    }
  }

  // Step 3: where the per-agent config files should land.
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    // If every selected target is global-only (e.g. Codex), skip the
    // prompt and force user-wide — project-local would just produce
    // skip warnings.
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));
    if (allGlobalOnly) {
      location = 'global';
      presenter.status('Writing user-wide configs (selected agents have no project-local config).');
    } else {
      const sel = await presenter.select({
        message: 'Apply agent configs to your personal/user scope, or to this project/team scope?',
        options: [
          { value: 'global' as const, label: 'Personal/user scope', hint: 'user-owned config for projects opened by this account' },
          { value: 'local'  as const, label: 'Project/team scope', hint: 'files in this project that may be shared with teammates' },
        ],
        initialValue: 'global' as const,
      });
      if (sel === undefined) {
        cancelInstall(presenter, 'Installation cancelled.');
      }
      location = sel;
    }
  }

  // Step 4: auto-allow permissions (only meaningful for Claude;
  // skipped silently by other targets).
  let autoAllow: boolean;
  if (opts.autoAllow !== undefined) {
    autoAllow = opts.autoAllow;
  } else if (useDefaults) {
    autoAllow = true;
  } else if (targets.some((t) => t.id === 'claude')) {
    const ans = await presenter.confirm({
      message: 'Auto-allow SolidKG commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });
    if (ans === undefined) {
      cancelInstall(presenter, 'Installation cancelled.');
    }
    autoAllow = ans;
  } else {
    autoAllow = false;
  }

  // Step 5: per-target install loop.
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      presenter.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    for (const file of result.files) {
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created' : 'Updated';
      presenter.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      presenter.status(`${target.displayName}: ${note}`);
    }
  }

  // Step 6: for local install, initialize the project.
  if (location === 'local') {
    await initializeLocalProject(presenter, useDefaults);
  }

  if (location === 'global') {
    presenter.note('cd your-project\nsolidkg init -i', 'Quick start');
  }

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use SolidKG.`
    : 'Done!';
  presenter.outro(finalNote);
}

export interface RunUninstallerOptions {
  /**
   * Comma-separated target list, or `auto` / `all` / `none`. Defaults
   * to `all` — uninstall sweeps every known agent and reports which
   * ones it actually touched, so the user doesn't have to know where
   * they configured it.
   */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Non-interactive: location=global, target=all, no prompts. */
  yes?: boolean;
}

export type UninstallStatus = 'removed' | 'not-configured' | 'unsupported';

/**
 * Per-target outcome of an uninstall sweep. `removed` means we deleted
 * at least one thing; `not-configured` means the agent had no solidkg
 * config at this location (nothing to do); `unsupported` means the
 * agent has no config concept for this location (e.g. Codex is
 * global-only, so a `local` uninstall skips it).
 */
export interface UninstallReport {
  id: TargetId;
  displayName: string;
  status: UninstallStatus;
  /** Absolute paths we actually edited/removed (action === 'removed'). */
  removedPaths: string[];
  /** Verbatim notes from the target (rare for uninstall). */
  notes: string[];
}

/**
 * Pure uninstall sweep — no prompts, no I/O beyond the targets' own
 * file edits. Exposed (and unit-tested) separately from the clack UI in
 * `runUninstaller` so the aggregation logic can be asserted directly.
 *
 * Each target's `uninstall()` is already safe to call when nothing was
 * installed (it returns `not-found` actions), so this is safe to run
 * across every target unconditionally.
 */
export function uninstallTargets(
  targets: readonly AgentTarget[],
  location: Location,
): UninstallReport[] {
  return targets.map((target) => {
    if (!target.supportsLocation(location)) {
      const only: Location = location === 'local' ? 'global' : 'local';
      return {
        id: target.id,
        displayName: target.displayName,
        status: 'unsupported' as const,
        removedPaths: [],
        notes: [`no ${location} config — this agent is ${only}-only`],
      };
    }
    const result = target.uninstall(location);
    const removedPaths = result.files
      .filter((f) => f.action === 'removed')
      .map((f) => f.path);
    return {
      id: target.id,
      displayName: target.displayName,
      status: removedPaths.length > 0 ? ('removed' as const) : ('not-configured' as const),
      removedPaths,
      notes: result.notes ?? [],
    };
  });
}

/**
 * Interactive uninstaller — the inverse of `runInstallerWithOptions`.
 * Asks global-vs-local first (unless `--location`/`--yes` is given),
 * then sweeps every agent target (or the `--target` subset) and prints
 * one block per agent so the user sees exactly which providers it hit.
 *
 * Removes only what install wrote (MCP server entry, instructions
 * block, permissions) — never the `.solidkg/` index, which `solidkg
 * uninit` owns.
 */
export async function runUninstaller(opts: RunUninstallerOptions): Promise<void> {
  const presenter = createTerminalPresenter();

  presenter.intro(`SolidKG v${getVersion()} — uninstall`);

  const useDefaults = opts.yes === true;

  // Step 1: which location — asked FIRST, the one decision the user
  // must make. Global sweeps ~/.claude, ~/.codex, etc.; local sweeps
  // the configs in this project directory.
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    const sel = await presenter.select({
      message: 'Remove SolidKG from your personal/user scope, or from this project/team scope?',
      options: [
        { value: 'global' as const, label: 'Personal/user scope', hint: 'user-owned config for projects opened by this account' },
        { value: 'local'  as const, label: 'Project/team scope', hint: 'files in this project that may be shared with teammates' },
      ],
      initialValue: 'global' as const,
    });
    if (sel === undefined) {
      cancelInstall(presenter, 'Uninstall cancelled.');
    }
    location = sel;
  }

  // Step 2: which agents. Default is every agent, so the user doesn't
  // have to remember where they installed it — unconfigured agents are
  // reported as "nothing to remove" and left untouched. An explicit
  // --target subsets this.
  let targets: AgentTarget[];
  if (opts.target !== undefined) {
    targets = resolveTargetFlag(opts.target, location);
  } else {
    targets = [...ALL_TARGETS];
  }
  if (targets.length === 0) {
    presenter.outro('No agent targets selected — nothing to do.');
    return;
  }

  // Step 3: sweep + per-agent feedback.
  const reports = uninstallTargets(targets, location);
  const removed = reports.filter((r) => r.status === 'removed');

  for (const r of reports) {
    if (r.status === 'removed') {
      for (const p of r.removedPaths) {
        presenter.success(`${r.displayName}: removed ${tildify(p)}`);
      }
    } else if (r.status === 'not-configured') {
      presenter.status(`${r.displayName}: not configured — nothing to remove`);
    } else {
      presenter.status(`${r.displayName}: skipped — ${r.notes[0] ?? 'unsupported location'}`);
    }
  }

  // Step 4: for local uninstall, the index dir is separate — point at
  // `uninit` so the user knows it's still there (and how to remove it).
  if (location === 'local' && fs.existsSync(path.join(process.cwd(), '.solidkg'))) {
    presenter.status('The .solidkg/ index for this project is still here. Run `solidkg uninit` to delete it.');
  }

  // Step 5: summary.
  if (removed.length > 0) {
    const names = removed.map((r) => r.displayName).join(', ');
    presenter.outro(
      `Removed SolidKG from ${removed.length} agent${removed.length > 1 ? 's' : ''}: ${names}. ` +
      `Restart ${removed.length > 1 ? 'them' : 'it'} to apply.`,
    );
  } else {
    presenter.outro(`SolidKG was not configured in any ${location} agent — nothing to remove.`);
  }
}

/**
 * For every target that has a global config and exposes
 * `wireProjectSurfaces`, write its project-local surfaces (e.g.
 * Cursor's `.cursor/rules/solidkg.mdc`). Idempotent — runs
 * silently when there's nothing to write.
 *
 * Called by `solidkg init` so that a user who ran
 * `solidkg install` once globally doesn't have to re-run it per
 * project to get full agent support.
 *
 * Returns the list of `(target, file)` pairs that were created or
 * updated — caller decides how to surface them.
 */
export function wireProjectSurfacesForGlobalAgents(): Array<{
  target: AgentTarget;
  file: WriteResult['files'][number];
}> {
  const written: Array<{ target: AgentTarget; file: WriteResult['files'][number] }> = [];
  for (const target of ALL_TARGETS) {
    if (typeof target.wireProjectSurfaces !== 'function') continue;
    const detection = target.detect('global');
    if (!detection.alreadyConfigured) continue;
    const result = target.wireProjectSurfaces();
    for (const file of result.files) {
      if (file.action === 'created' || file.action === 'updated') {
        written.push({ target, file });
      }
    }
  }
  return written;
}

/**
 * Replace home-directory prefix in a path with `~/` for cleaner log
 * lines. Pure cosmetic.
 */
function tildify(p: string): string {
  const home = require('os').homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

async function resolveTargets(
  presenter: TerminalPresenter,
  opts: RunInstallerOptions,
  location: Location,
  useDefaults: boolean,
): Promise<AgentTarget[]> {
  // Explicit --target flag wins.
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  // --yes implies auto-detect.
  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  // Interactive multi-select.
  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);
  // If nothing detected, default to Claude alone (matches the
  // historical default and the smallest-surprise outcome).
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = await presenter.multiSelect<string>({
    message: 'Which agents should SolidKG configure?',
    options: ALL_TARGETS.map((t) => {
      const det = detected.find(({ target }) => target.id === t.id)!.detection;
      const flag = det.installed ? '(detected)' : '(not found)';
      const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
      return {
        value: t.id,
        label: `${t.displayName} ${flag}${globalOnly}`,
      };
    }),
    initialValues: initial,
    required: false,
  });

  if (choice === undefined) {
    cancelInstall(presenter, 'Installation cancelled.');
  }

  return choice
    .map((id) => getTarget(id))
    .filter((t): t is AgentTarget => t !== undefined);
}

/**
 * Initialize SolidKG in the current project (for local installs), then
 * offer the watch fallback when the live watcher won't run here (see
 * offerWatchFallback). Agent-agnostic by nature.
 */
async function initializeLocalProject(
  presenter: TerminalPresenter,
  useDefaults = false,
): Promise<void> {
  const projectPath = process.cwd();

  let SolidKG: typeof import('../index').default;
  try {
    SolidKG = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    presenter.error(`Could not load native modules: ${msg}`);
    presenter.status('Skipping project initialization. Run "solidkg init -i" later.');
    return;
  }

  // Check if already initialized
  if (SolidKG.isInitialized(projectPath)) {
    presenter.status('SolidKG already initialized in this project');
    await offerWatchFallback(presenter, projectPath, { yes: useDefaults });
    return;
  }

  // Initialize
  const cg = await SolidKG.init(projectPath);
  presenter.success('Created .solidkg/ directory');

  const progress = presenter.progress();

  const result = await cg.indexAll({
    onProgress: progress.onProgress,
    scip: 'auto',
  });

  await progress.stop();

  const unprocessedCount = result.filesSkipped + result.filesErrored;
  if (unprocessedCount > 0) {
    presenter.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(unprocessedCount)} skipped/unprocessed, ${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    presenter.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  }

  cg.close();

  await offerWatchFallback(presenter, projectPath, { yes: useDefaults });
}

/**
 * When the live file watcher will be disabled for this project (e.g. WSL2
 * /mnt drives, or SOLIDKG_NO_WATCH), the index would silently go stale.
 * Explain that, and offer to keep it fresh automatically via git hooks
 * (commit / pull / checkout) instead of manual `solidkg sync`.
 *
 * No-op on environments where the watcher runs normally, so it's safe to
 * call unconditionally after init.
 */
export async function offerWatchFallback(
  presenter: TerminalPresenter,
  projectPath: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  const reason = watchDisabledReason(projectPath);
  if (!reason) return; // Watcher runs normally — nothing to set up.

  presenter.warn(`Live file watching is disabled here — ${reason}.`);
  presenter.status('Until you re-sync, the SolidKG index stays frozen — it will not pick up edits on its own.');

  // No git repo → the commit-hook path doesn't apply; point at manual sync.
  if (!isGitRepo(projectPath)) {
    presenter.status('Run `solidkg sync` after changing files to refresh the index.');
    return;
  }

  // Already wired up on a previous run — confirm and move on without nagging.
  if (isSyncHookInstalled(projectPath)) {
    presenter.status('Git sync hooks are already installed — the index refreshes after commit / pull / checkout.');
    return;
  }

  let choice: 'hook' | 'manual';
  if (opts.yes) {
    choice = 'hook';
  } else {
    const sel = await presenter.select({
      message: 'How should SolidKG keep its index fresh?',
      options: [
        { value: 'hook' as const, label: 'Sync on git commit / pull / checkout', hint: 'installs git hooks (recommended)' },
        { value: 'manual' as const, label: 'I\'ll run `solidkg sync` myself', hint: 'fully manual' },
      ],
      initialValue: 'hook' as const,
    });
    if (sel === undefined) {
      presenter.status('Skipped — run `solidkg sync` after changes to refresh the index.');
      return;
    }
    choice = sel;
  }

  if (choice === 'manual') {
    presenter.status('Run `solidkg sync` after changing files to refresh the index.');
    return;
  }

  const result = installGitSyncHook(projectPath);
  if (result.installed.length > 0) {
    presenter.success(
      `Installed git ${result.installed.join(', ')} hook${result.installed.length > 1 ? 's' : ''} — ` +
      'the index refreshes in the background after each.',
    );
    presenter.status('Run `solidkg sync` anytime to refresh immediately.');
  } else {
    presenter.warn(
      `Could not install git hooks${result.skipped ? ` (${result.skipped})` : ''}. ` +
      'Run `solidkg sync` after changes instead.',
    );
  }
}
