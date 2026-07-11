#!/usr/bin/env node
/**
 * SolidKG CLI
 *
 * Command-line interface for SolidKG code intelligence.
 *
 * Usage:
 *   solidkg                    Run interactive installer (when no args)
 *   solidkg install            Run interactive installer
 *   solidkg uninstall          Remove SolidKG from your agents
 *   solidkg init [path]        Initialize SolidKG in a project
 *   solidkg uninit [path]      Remove SolidKG from a project
 *   solidkg index [path]       Index all files in the project
 *   solidkg sync [path]        Sync changes since last index
 *   solidkg status [path]      Show index status
 *   solidkg query <search>     Search for symbols
 *   solidkg files [options]    Show project file structure
 *   solidkg overview [path]    Show indexed repository overview tree
 *   solidkg context <task>     Build context for a task
 *   solidkg callers <symbol>   Find what calls a function/method
 *   solidkg callees <symbol>   Find what a function/method calls
 *   solidkg impact <symbol>    Analyze what code is affected by changing a symbol
 *   solidkg affected [files]   Find test files affected by changes
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getSolidKGDir, isInitialized } from '../directory';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { createTerminalPresenter, PROGRESS_PHASE_LABELS, type ProgressCompletionSummary, type ProgressPresenter, type TerminalPresenter } from '../ui/terminal';
import { getGlyphs } from '../ui/glyphs';
import { getProductIdentity } from '../branding';
import { normalizePath, pathMatchesRootAwarePrefix } from '../utils';
import { NODE_KINDS, type Edge, type EdgeKind, type NodeKind } from '../types';
import type { OverviewTreeOptions } from '../overview';
import { buildGraphTraversalPacket, formatGraphTraversalPacketMarkdown, type GraphTraversalDirection, type GraphTraversalLimit, type GraphTraversalResult } from '../graph';
import { mergeTraversalResults, relationCountsForEdges } from '../graph/traversal-results';
import { IndexLifecycleDiagnostics } from '../index-lifecycle-diagnostics';
import type SolidKG from '../index';
import type { IndexProgress } from '../extraction';
import { logWarn } from '../errors';

import { buildNode25BlockBanner, buildNodeTooOldBanner, MIN_NODE_MAJOR } from './node-version-check';
import { relaunchWithWasmRuntimeFlagsIfNeeded } from '../extraction/wasm-runtime-flags';

const STATUS_JSON_SCHEMA_VERSION = 'solidkg.status.v1';
const OVERVIEW_EXPAND_PATH_LIMIT = 50;
const productIdentity = getProductIdentity();

function parseBoundedIntegerOption(value: string, optionName: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${optionName} "${value}". Expected an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${optionName} "${value}". Expected an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseOptionalBoundedIntegerOption(value: string | undefined, optionName: string, fallback: number, min: number, max: number): number {
  return value === undefined ? fallback : parseBoundedIntegerOption(value, optionName, min, max);
}

function formatCliGraphTraversalPacket(args: {
  readonly queryKind: string;
  readonly startNodeIds: readonly string[];
  readonly direction: GraphTraversalDirection;
  readonly edgeKinds: readonly EdgeKind[];
  readonly maxDepth: number;
  readonly resultNodeIds: readonly string[];
  readonly edges: readonly Edge[];
  readonly traversals: readonly GraphTraversalResult[];
  readonly relationCounts: Partial<Record<EdgeKind, number>>;
  readonly resultLimitHit: boolean;
}): { readonly markdown: string; readonly packet: ReturnType<typeof buildGraphTraversalPacket> } {
  const limits = new Set<GraphTraversalLimit>();
  const ignoreDepthLimit = args.queryKind === 'direct_callers' || args.queryKind === 'direct_callees';
  for (const traversal of args.traversals) {
    for (const limit of traversal.coverage.limitsHit) {
      if (ignoreDepthLimit && limit === 'maxDepth') continue;
      limits.add(limit);
    }
  }
  if (args.resultLimitHit) limits.add('result_limit');
  const nodeIds = [...new Set([...args.startNodeIds, ...args.resultNodeIds])];
  const result: GraphTraversalResult = {
    nodeIds,
    edges: [...args.edges],
    paths: [],
    depthByNode: new Map(nodeIds.map((nodeId) => [nodeId, args.startNodeIds.includes(nodeId) ? 0 : 1])),
    coverage: {
      status: limits.size > 0 ? 'partial' : args.resultNodeIds.length > 0 ? 'complete' : 'absent',
      limitsHit: [...limits].sort((left, right) => left.localeCompare(right)),
      staleInputs: [],
    },
  };
  const packet = buildGraphTraversalPacket({
    queryKind: args.queryKind,
    startNodeIds: args.startNodeIds,
    direction: args.direction,
    edgeKinds: args.edgeKinds,
    maxDepth: args.maxDepth,
    limits: { maxNodes: 1000, maxEdges: 5000, budgetMs: 100 },
    result,
    relationCounts: args.relationCounts,
  });
  return { markdown: formatGraphTraversalPacketMarkdown(packet).trimEnd(), packet };
}

function normalizeAffectedFileInput(filePath: string, projectPath: string): string {
  const relativePath = path.isAbsolute(filePath) ? path.relative(projectPath, filePath) : filePath;
  return normalizePath(relativePath).replace(/^\.\//, '').replace(/\/+$/, '');
}

// Lazy-load heavy modules (SolidKG, runInstaller) to keep CLI startup fast.
async function loadSolidKG(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m${getGlyphs().err}\x1b[0m Failed to load SolidKG modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g solidkg\n');
    process.exit(1);
  }
}

// Block SolidKG on Node.js 25.x — V8's turboshaft WASM JIT has a Zone
// allocator bug that reliably crashes when compiling tree-sitter
// grammars (see #54, #81, #140). The previous behaviour was a soft
// console.warn that scrolls off-screen before the OOM crash 30 seconds
// later, leading to a steady stream of "what is this OOM" reports.
// Hard-exit before any WASM work; allow override via env var for users
// who patched V8 themselves or want to test a future fix.
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 25) {
  process.stderr.write(buildNode25BlockBanner(nodeVersion) + '\n');
  if (!process.env.SOLIDKG_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}
// Enforce the supported Node floor. `engines` in package.json only *warns* on
// install (unless engine-strict), so hard-block here to actually keep users off
// unsupported versions. Mirrors the 25+ block above. See package.json `engines`.
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  if (!process.env.SOLIDKG_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}

// Re-exec with V8's `--liftoff-only` if it isn't already set, so tree-sitter's
// large WASM grammars never hit the turboshaft Zone OOM (`Fatal process out of
// memory: Zone`) on Node >= 22. No-op under the bundled launcher, which already
// passes the flag. Must run before any grammar (in the parse worker, which
// inherits this process's flags) is compiled. See ../extraction/wasm-runtime-flags.
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

process.on('uncaughtException', (error) => {
  console.error('[SolidKG] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SolidKG] Unhandled rejection:', reason);
  process.exit(1);
});

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

function shouldUseAnsiColor(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true
    && process.env.NO_COLOR === undefined
    && process.env.TERM?.toLowerCase() !== 'dumb'
    && !isTruthyEnvFlag(process.env.CI);
}

function colorize(code: string, s: string): string {
  if (!shouldUseAnsiColor(process.stdout)) return s;
  return `${code}${s}${colors.reset}`;
}

const chalk = {
  bold: (s: string) => colorize(colors.bold, s),
  dim: (s: string) => colorize(colors.dim, s),
  red: (s: string) => colorize(colors.red, s),
  green: (s: string) => colorize(colors.green, s),
  yellow: (s: string) => colorize(colors.yellow, s),
  blue: (s: string) => colorize(colors.blue, s),
  cyan: (s: string) => colorize(colors.cyan, s),
  white: (s: string) => colorize(colors.white, s),
  gray: (s: string) => colorize(colors.gray, s),
};

program
  .name(productIdentity.commandName)
  .description(productIdentity.description)
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized SolidKG project
 * (must have .solidkg/solidkg.db, not just .solidkg/lessons.db)
 */
function resolveDataDir(dataDir?: string): string | undefined {
  return dataDir ? path.resolve(dataDir) : undefined;
}

function resolveProjectPath(pathArg?: string, dataDir?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  if (dataDir) {
    return absolutePath;
  }

  // If exact path is initialized (has solidkg.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with SolidKG initialized
  // Note: findNearestSolidKGRoot finds any .solidkg folder, but we need one with solidkg.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

function formatDataDirHint(dataDir?: string): string {
  return dataDir
    ? `Run "solidkg init --data-dir ${dataDir}" for this project, or pass the data directory used when it was initialized.`
    : 'Run "solidkg init" first';
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

const terminal = createTerminalPresenter();

interface OverviewCliOptions {
  path?: string;
  dataDir?: string;
  filter?: string;
  pattern?: string;
  maxDepth?: string;
  expand?: string[];
  maxEntries?: string;
  metadata?: boolean;
}

function parseOverviewOptions(options: OverviewCliOptions): OverviewTreeOptions {
  const maxDepth = options.maxDepth ? parseBoundedIntegerOption(options.maxDepth, '--max-depth', 1, 20) : undefined;
  const expandPaths = options.expand ?? [];
  if (expandPaths.length > OVERVIEW_EXPAND_PATH_LIMIT) {
    throw new Error(`Too many --expand paths. Expected at most ${OVERVIEW_EXPAND_PATH_LIMIT}.`);
  }

  return {
    ...(options.filter ? { path: options.filter } : {}),
    ...(options.pattern ? { pattern: options.pattern } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    expandPaths,
    includeMetadata: options.metadata !== false,
    maxEntries: parseOptionalBoundedIntegerOption(options.maxEntries, '--max-entries', 160, 1, 1000),
  };
}

async function printRepositoryOverview(pathArg: string | undefined, options: OverviewCliOptions): Promise<void> {
  const dataDir = resolveDataDir(options.dataDir);
  const projectPath = resolveProjectPath(pathArg, dataDir);

  if (!isInitialized(projectPath, { dataDir })) {
    error(`SolidKG not initialized in ${projectPath}`);
    info(formatDataDirHint(dataDir));
    process.exit(1);
  }

  const cg = await openSolidKGReadOnly(projectPath, dataDir);
  try {
    console.log(cg.getOverviewText(parseOverviewOptions(options)));
    console.log();
  } finally {
    cg.destroy();
  }
}

async function openSolidKGReadOnly(projectPath: string, dataDir: string | undefined) {
  const { default: SolidKG } = await loadSolidKG();
  return SolidKG.open(projectPath, { dataDir, readOnly: true });
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function parseScipMode(value: string): 'auto' | 'off' | 'required' {
  if (value === 'auto' || value === 'off' || value === 'required') return value;
  throw new Error(`Invalid SCIP mode "${value}". Expected auto, off, or required.`);
}

function parseContextDetail(value: string): 'standard' | 'minimal' {
  if (value === 'standard' || value === 'minimal') return value;
  throw new Error(`Invalid context detail "${value}". Expected standard or minimal.`);
}

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines through the presenter.
 */
function createVerboseProgress(presenter: TerminalPresenter): (progress: IndexProgress) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const progressLabel = progress.detail ?? progress.phase;

    if (progressLabel !== lastPhase) {
      lastPhase = progressLabel;
      lastPct = -1;
      presenter.status(`[${elapsed}s] ${PROGRESS_PHASE_LABELS[progressLabel] ?? progressLabel}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        presenter.status(`[${elapsed}s] ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        presenter.status(`[${elapsed}s] ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

/**
 * Print success message
 */
function success(message: string): void {
  terminal.success(message);
}

/**
 * Print error message
 */
function error(message: string): void {
  terminal.error(message);
}

/**
 * Print info message
 */
function info(message: string): void {
  terminal.status(message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  terminal.warn(message);
}

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
  skippedFiles?: Array<{ path: string; reason: string; message: string; pattern?: string; size?: number; limit?: number }>;
};

type PrintIndexResultOptions = {
  terseSuccess?: boolean;
  successPrefix?: string;
  suppressPrimary?: boolean;
};

type IndexingControlOptions = {
  include?: string[];
  exclude?: string[];
  includeVendored?: boolean;
  maxFileSize?: string;
};

function lifecycleCounts(result: IndexResult): {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
} {
  return {
    filesScanned: result.filesIndexed + result.filesSkipped + result.filesErrored,
    filesIndexed: result.filesIndexed,
    filesSkipped: result.filesSkipped,
    filesErrored: result.filesErrored,
    nodesCreated: result.nodesCreated,
    edgesCreated: result.edgesCreated,
  };
}

function resultFailure(result: IndexResult): Error {
  const cause = result.errors[0];
  const causeError = cause ? new Error(cause.message) : undefined;
  return new Error('Indexing completed with a failure result', causeError ? { cause: causeError } : undefined);
}

function trackIndexProgress(
  diagnostics: IndexLifecycleDiagnostics,
  onProgress?: (progress: IndexProgress) => void,
): (progress: IndexProgress) => void {
  return (progress) => {
    diagnostics.transition(progress);
    onProgress?.(progress);
  };
}

function destroyIndexGraph(cg: SolidKG | undefined): void {
  try {
    cg?.destroy();
  } catch {
    const warning = 'Graph cleanup failed; continuing after the primary result.';
    try {
      logWarn(warning);
    } catch {
      try {
        process.stderr.write(`${warning}\n`);
      } catch {
        return;
      }
    }
  }
}

function parseByteSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(?:\s*)(b|kb|kib|mb|mib|gb|gib)?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid size "${value}". Use bytes, kb, mb, or gb, for example 500kb or 2mb.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 * 1024,
    mib: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    gib: 1024 * 1024 * 1024,
  };
  return Math.floor(amount * multipliers[unit]!);
}

function indexingControls(options: IndexingControlOptions): { includePatterns?: string[]; excludePatterns?: string[]; includeVendored?: boolean; maxFileSizeBytes?: number } {
  return {
    includePatterns: options.include,
    excludePatterns: options.exclude,
    includeVendored: options.includeVendored,
    maxFileSizeBytes: parseByteSize(options.maxFileSize),
  };
}

function createInteractiveProgress(presenter: TerminalPresenter): ProgressPresenter | undefined {
  return presenter.environment.mode === 'interactive-tty' ? presenter.progress() : undefined;
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : pluralForm}`;
}

function skippedFileBreakdown(skippedFiles: NonNullable<IndexResult['skippedFiles']>): string {
  const skippedByReason = new Map<string, number>();
  for (const skipped of skippedFiles) {
    skippedByReason.set(skipped.reason, (skippedByReason.get(skipped.reason) || 0) + 1);
  }

  const labels: Record<string, string> = {
    excluded: 'excluded by rules',
    max_size: 'over max size',
    parse_timeout: 'skipped after parser timeout',
  };

  return Array.from(skippedByReason)
    .map(([reason, count]) => `${plural(count, 'file')} ${labels[reason] || reason}`)
    .join(', ');
}

function formatIndexSuccessLine(result: IndexResult, prefix = 'SolidKG indexed'): string {
  return `${prefix} ${plural(result.filesIndexed, 'file')} (${plural(result.nodesCreated, 'node')}, ${plural(result.edgesCreated, 'edge')}, ${formatDuration(result.durationMs)})`;
}

function isSkippedFileDiagnostic(item: { code?: string; severity: string }): boolean {
  return item.severity === 'warning' && (item.code === 'size_exceeded' || item.code === 'parse_timeout');
}

function issueCounts(result: IndexResult): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;

  for (const item of result.errors) {
    if (isSkippedFileDiagnostic(item)) continue;
    if (item.severity === 'error') errors += 1;
    if (item.severity === 'warning') warnings += 1;
  }

  return {
    errors: Math.max(errors, result.filesErrored),
    warnings,
  };
}

function errorLogReference(projectPath: string | undefined, dataDir: string | undefined): string {
  if (!projectPath || !dataDir) return path.join('.solidkg', 'errors.log');
  return path.join(getSolidKGDir(projectPath, { dataDir }), 'errors.log');
}

function formatIndexCompletionSummary(result: IndexResult, prefix = 'SolidKG indexed', projectPath?: string, dataDir?: string): ProgressCompletionSummary | undefined {
  if (result.filesIndexed <= 0) return undefined;

  const { errors, warnings } = issueCounts(result);
  const action = prefix.replace(/^SolidKG\s+/, '');
  const totalFiles = result.filesIndexed + result.filesErrored;
  const fileSegment = errors > 0 && totalFiles > result.filesIndexed
    ? `${formatNumber(result.filesIndexed)}/${formatNumber(totalFiles)} files`
    : plural(result.filesIndexed, 'file');
  const issueSegments = errors > 0 || warnings > 0
    ? [`${plural(errors, 'error')}`, `${plural(warnings, 'warning')} saved to ${errorLogReference(projectPath, dataDir)}`]
    : ['0 errors', '0 warnings'];

  return {
    status: errors > 0 || warnings > 0 ? 'warning' : 'success',
    title: 'complete',
    segments: [
      `${action} ${fileSegment}`,
      plural(result.nodesCreated, 'node'),
      plural(result.edgesCreated, 'edge'),
      formatDuration(result.durationMs),
      ...issueSegments,
    ],
  };
}

function formatSyncSuccessLine(result: { filesAdded: number; filesModified: number; filesRemoved: number; nodesUpdated: number; durationMs: number }): string {
  const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

  if (totalChanges === 0) {
    return 'SolidKG synced: already up to date';
  }

  const details: string[] = [];
  if (result.filesAdded > 0) details.push(`${plural(result.filesAdded, 'added file')}`);
  if (result.filesModified > 0) details.push(`${plural(result.filesModified, 'modified file')}`);
  if (result.filesRemoved > 0) details.push(`${plural(result.filesRemoved, 'removed file')}`);
  details.push(`${plural(result.nodesUpdated, 'node')}`);
  details.push(formatDuration(result.durationMs));
  return `SolidKG synced: ${plural(totalChanges, 'changed file')} (${details.join(', ')})`;
}

function formatSyncCompletionSummary(result: { filesAdded: number; filesModified: number; filesRemoved: number; nodesUpdated: number; durationMs: number }): ProgressCompletionSummary {
  const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;
  const segments = totalChanges === 0
    ? ['synced: already up to date']
    : [
      `synced ${plural(totalChanges, 'changed file')}`,
      ...(result.filesAdded > 0 ? [`${plural(result.filesAdded, 'added file')}`] : []),
      ...(result.filesModified > 0 ? [`${plural(result.filesModified, 'modified file')}`] : []),
      ...(result.filesRemoved > 0 ? [`${plural(result.filesRemoved, 'removed file')}`] : []),
      plural(result.nodesUpdated, 'node'),
      formatDuration(result.durationMs),
    ];

  return {
    status: 'success',
    title: 'complete',
    segments,
  };
}

function shouldSettleProgressWithSummary(result: IndexResult, options: PrintIndexResultOptions): boolean {
  return options.terseSuccess === true
    && options.suppressPrimary === true
    && result.filesIndexed > 0;
}

function shouldPrintPrimaryIndexSummary(result: IndexResult, options: PrintIndexResultOptions, hasErrors: boolean): boolean {
  return result.filesIndexed > 0
    && !shouldSettleProgressWithSummary(result, options)
    && (!options.terseSuccess || hasErrors);
}

function printIndexResult(presenter: TerminalPresenter, result: IndexResult, projectPath?: string, dataDir?: string, options: PrintIndexResultOptions = {}): void {
  const hasErrors = result.filesErrored > 0;
  const issues = issueCounts(result);
  const hasIssues = issues.errors > 0 || issues.warnings > 0;

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    presenter.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (!shouldSettleProgressWithSummary(result, options)) {
      if (options.terseSuccess && !hasErrors) {
        const prefix = options.successPrefix ?? 'SolidKG indexed';
        presenter.message(formatIndexSuccessLine(result, prefix));
      } else if (hasErrors) {
        presenter.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
      } else {
        presenter.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
      }
    }
    if (shouldPrintPrimaryIndexSummary(result, options, hasErrors)) {
      presenter.status(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
    }
  } else if (hasErrors) {
    presenter.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    presenter.warn('No files found to index');
  }

  if (result.skippedFiles && result.skippedFiles.length > 0) {
    const breakdown = skippedFileBreakdown(result.skippedFiles);
    if (options.terseSuccess && !hasErrors) {
      presenter.message(`Skipped ${breakdown}`);
    } else {
      presenter.note(`Skipped files\n${breakdown}`);
    }
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    presenter.note(`Error breakdown\n${breakdown}`);

    if (result.filesIndexed > 0) {
      presenter.status(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  }

  if (projectPath && hasIssues) {
    writeErrorLog(projectPath, result.errors, dataDir);
    if (!shouldSettleProgressWithSummary(result, options) && (!options.terseSuccess || hasErrors)) {
      presenter.status(`See ${path.join(getSolidKGDir(projectPath, { dataDir }), 'errors.log')} for details`);
    }
  } else if (projectPath) {
    const logPath = path.join(getSolidKGDir(projectPath, { dataDir }), 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

/**
 * Write detailed error log to .solidkg/errors.log
 */
function writeErrorLog(projectPath: string, diagnostics: Array<{ message: string; filePath?: string; severity: string; code?: string }>, dataDir?: string): void {
  const cgDir = getSolidKGDir(projectPath, { dataDir });
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  const diagnosticsByFile = new Map<string, Array<{ message: string; severity: string; code?: string }>>();
  const noFileDiagnostics: Array<{ message: string; severity: string; code?: string }> = [];

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning') continue;
    if (isSkippedFileDiagnostic(diagnostic)) continue;
    if (diagnostic.filePath) {
      let list = diagnosticsByFile.get(diagnostic.filePath);
      if (!list) {
        list = [];
        diagnosticsByFile.set(diagnostic.filePath, list);
      }
      list.push({ message: diagnostic.message, severity: diagnostic.severity, code: diagnostic.code });
    } else {
      noFileDiagnostics.push({ message: diagnostic.message, severity: diagnostic.severity, code: diagnostic.code });
    }
  }

  const lines: string[] = [
    `SolidKG Error Log - ${new Date().toISOString()}`,
    `${diagnosticsByFile.size} files with diagnostics`,
    '',
  ];

  for (const [filePath, fileDiagnostics] of diagnosticsByFile) {
    for (const diagnostic of fileDiagnostics) {
      lines.push(`${filePath}: ${diagnostic.severity}: ${diagnostic.message}`);
    }
  }

  for (const diagnostic of noFileDiagnostics) {
    lines.push(`${diagnostic.severity}: ${diagnostic.message}`);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

// =============================================================================
// Commands
// =============================================================================

/**
 * solidkg init [path]
 */
program
  .command('init [path]')
  .description('Initialize SolidKG in a project directory')
  .option('-i, --index', 'Run initial indexing after initialization')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .option('--extra-root <path>', 'Additional source root to index (repeatable)', collectRepeatable, [])
  .option('--include <glob>', 'Only index files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--exclude <glob>', 'Exclude files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--include-vendored', 'Include vendor/ and vendored/ source instead of the default dependency-source exclusion')
  .option('--max-file-size <size>', 'Skip source files larger than this size (bytes, kb, mb, gb; default 5mb)')
  .option('--recurse-submodules', 'Index nested Git repositories/submodules')
  .action(async (pathArg: string | undefined, options: { index?: boolean; verbose?: boolean; dataDir?: string; extraRoot?: string[]; recurseSubmodules?: boolean } & IndexingControlOptions) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const dataDir = resolveDataDir(options.dataDir);
    const presenter = createTerminalPresenter();
    const terseInitIndex = options.index === true && options.verbose !== true;
    let cg: SolidKG | undefined;
    let diagnostics: IndexLifecycleDiagnostics | undefined;

    if (!terseInitIndex) {
      presenter.intro('Initializing SolidKG');
    }

    try {
      const controls = indexingControls(options);
      if (isInitialized(projectPath, { dataDir })) {
        presenter.warn(`Already initialized in ${projectPath}`);
        presenter.status(`Data directory: ${getSolidKGDir(projectPath, { dataDir })}`);
        presenter.status('Use "solidkg index" to re-index or "solidkg sync" to update');
        // Re-run agent surface wiring so re-running `init` is the
        // documented way to recover a project that's missing its
        // Cursor rules file (or future per-agent project surfaces).
        try {
          const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
          for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
            presenter.success(`${target.displayName}: ${file.action} ${file.path}`);
          }
        } catch { /* non-fatal */ }
        try {
          const { offerWatchFallback } = await import('../installer');
          await offerWatchFallback(presenter, projectPath);
        } catch { /* non-fatal */ }
        presenter.outro('');
        return;
      }

      const { default: SolidKG } = await loadSolidKG();
      cg = await SolidKG.init(projectPath, { index: false, dataDir, extraRoots: options.extraRoot, includeSubmodules: options.recurseSubmodules, ...controls });
      if (!terseInitIndex) {
        presenter.success(`Initialized in ${projectPath}`);
        presenter.status(`Data directory: ${cg.getDataDir()}`);
      }

      // Bootstrap project-local surfaces for any agent that's
      // configured globally (Cursor needs ./.cursor/rules/solidkg.mdc
      // to actually prefer solidkg over native grep). Silent when
      // there's nothing to write.
      try {
        const { wireProjectSurfacesForGlobalAgents } = await import('../installer');
        for (const { target, file } of wireProjectSurfacesForGlobalAgents()) {
          if (!terseInitIndex) {
            presenter.success(`${target.displayName}: ${file.action} ${file.path}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        presenter.warn(`Skipped wiring project-local agent surfaces: ${msg}`);
      }

      if (options.index) {
        diagnostics = new IndexLifecycleDiagnostics({
          dataDir: cg.getDataDir(),
          operation: 'indexAll',
        });
        diagnostics.start({ phase: 'scanning', current: 0, total: 0 });
        let result: IndexResult;
        let progressSettled = false;

        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: trackIndexProgress(diagnostics, createVerboseProgress(presenter)),
            verbose: true,
            scip: 'auto',
            extraRoots: options.extraRoot,
            includeSubmodules: options.recurseSubmodules,
            ...controls,
          });
        } else {
          const progress = createInteractiveProgress(presenter);
          result = await cg.indexAll({
            onProgress: trackIndexProgress(diagnostics, progress?.onProgress),
            scip: 'auto',
            extraRoots: options.extraRoot,
            includeSubmodules: options.recurseSubmodules,
            ...controls,
          });
          const finalCompletion = terseInitIndex
            ? formatIndexCompletionSummary(result, 'SolidKG initialized and indexed', projectPath, dataDir)
            : undefined;
          await progress?.stop(finalCompletion);
          progressSettled = progress !== undefined && finalCompletion !== undefined;
        }

        printIndexResult(presenter, result, projectPath, dataDir, terseInitIndex ? {
          terseSuccess: true,
          successPrefix: 'SolidKG initialized and indexed',
          suppressPrimary: progressSettled,
        } : undefined);

        if (!result.success) {
          diagnostics.fail(resultFailure(result));
          destroyIndexGraph(cg);
          cg = undefined;
          process.exit(1);
        }

        diagnostics.succeed(lifecycleCounts(result));
      } else {
        presenter.status('Run "solidkg index" to index the project');
      }

      try {
        const { offerWatchFallback } = await import('../installer');
        await offerWatchFallback(presenter, projectPath);
      } catch { /* non-fatal */ }

      if (!terseInitIndex) {
        presenter.outro('Done');
      }
      destroyIndexGraph(cg);
      cg = undefined;
    } catch (err) {
      diagnostics?.fail(err instanceof Error ? err : new Error(String(err)));
      destroyIndexGraph(cg);
      presenter.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove SolidKG from a project (deletes .solidkg/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (pathArg: string | undefined, options: { force?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(pathArg, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        warn(`SolidKG is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // Confirm with user
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all SolidKG data. Continue? (y/N) `),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const { default: SolidKG } = await loadSolidKG();
      const cg = SolidKG.openSync(projectPath, { dataDir });
      cg.uninitialize();

      // Clean up any git sync hooks we installed (no-op if none / not a repo).
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* non-fatal */ }

      success(`Removed SolidKG from ${projectPath}`);
    } catch (err) {
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg index [path]
 */
program
  .command('index [path]')
  .description('Index all files in the project')
  .option('-f, --force', 'Force full re-index even if already indexed')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .option('--scip <mode>', 'SCIP generation mode: off, auto, or required', 'off')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .option('--extra-root <path>', 'Additional source root to index (repeatable)', collectRepeatable, [])
  .option('--include <glob>', 'Only index files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--exclude <glob>', 'Exclude files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--include-vendored', 'Include vendor/ and vendored/ source instead of the default dependency-source exclusion')
  .option('--max-file-size <size>', 'Skip source files larger than this size (bytes, kb, mb, gb; default 5mb)')
  .option('--recurse-submodules', 'Index nested Git repositories/submodules')
  .option('--profile-json', 'Output only JSON with aggregate indexing profile data on success')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean; scip?: string; dataDir?: string; extraRoot?: string[]; recurseSubmodules?: boolean; profileJson?: boolean } & IndexingControlOptions) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(pathArg, dataDir);
    const presenter = createTerminalPresenter({ quiet: options.quiet });
    const terseIndex = options.verbose !== true;
    let cg: SolidKG | undefined;
    let diagnostics: IndexLifecycleDiagnostics | undefined;

    try {
      const controls = indexingControls(options);
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const { default: SolidKG } = await loadSolidKG();
      cg = await SolidKG.open(projectPath, { dataDir, extraRoots: options.extraRoot, includeSubmodules: options.recurseSubmodules, ...controls });
      const scip = parseScipMode(options.scip ?? 'off');
      diagnostics = new IndexLifecycleDiagnostics({
        dataDir: cg.getDataDir(),
        operation: 'indexAll',
      });
      diagnostics.start({ phase: 'scanning', current: 0, total: 0 });

      if (options.profileJson) {
        if (options.force) cg.clear();
        const result = await cg.indexAll({
          profile: true,
          onProgress: trackIndexProgress(diagnostics),
          scip,
          extraRoots: options.extraRoot,
          includeSubmodules: options.recurseSubmodules,
          ...controls,
        });
        if (!result.success) {
          diagnostics.fail(resultFailure(result));
          destroyIndexGraph(cg);
          cg = undefined;
          process.exit(1);
        }
        diagnostics.succeed(lifecycleCounts(result));
        cg.destroy();
        cg = undefined;
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      if (options.quiet) {
        // Quiet mode: no UI, just run
        if (options.force) cg.clear();
        const result = await cg.indexAll({
          onProgress: trackIndexProgress(diagnostics),
          scip,
          extraRoots: options.extraRoot,
          includeSubmodules: options.recurseSubmodules,
          ...controls,
        });
        if (!result.success) {
          diagnostics.fail(resultFailure(result));
          destroyIndexGraph(cg);
          cg = undefined;
          process.exit(1);
        }
        diagnostics.succeed(lifecycleCounts(result));
        cg.destroy();
        cg = undefined;
        return;
      }

      if (!terseIndex) {
        presenter.intro('Indexing project');
      }

      if (options.force) {
        cg.clear();
        if (!terseIndex) {
          presenter.status('Cleared existing index');
        }
      }

      let result: IndexResult;
      let progressSettled = false;

      if (options.verbose) {
        result = await cg.indexAll({
          onProgress: trackIndexProgress(diagnostics, createVerboseProgress(presenter)),
          verbose: true,
          scip,
          extraRoots: options.extraRoot,
          includeSubmodules: options.recurseSubmodules,
          ...controls,
        });
      } else {
        const progress = createInteractiveProgress(presenter);
        result = await cg.indexAll({
          onProgress: trackIndexProgress(diagnostics, progress?.onProgress),
          scip,
          extraRoots: options.extraRoot,
          includeSubmodules: options.recurseSubmodules,
          ...controls,
        });
        const finalCompletion = terseIndex
          ? formatIndexCompletionSummary(result, 'SolidKG indexed', projectPath, dataDir)
          : undefined;
        await progress?.stop(finalCompletion);
        progressSettled = progress !== undefined && finalCompletion !== undefined;
      }

      printIndexResult(presenter, result, projectPath, dataDir, terseIndex ? {
        terseSuccess: true,
        suppressPrimary: progressSettled,
      } : undefined);

      if (!result.success) {
        diagnostics.fail(resultFailure(result));
        destroyIndexGraph(cg);
        cg = undefined;
        process.exit(1);
      }

      if (!terseIndex) {
        presenter.outro('Done');
      }
      diagnostics.succeed(lifecycleCounts(result));
      cg.destroy();
      cg = undefined;
    } catch (err) {
      diagnostics?.fail(err instanceof Error ? err : new Error(String(err)));
      destroyIndexGraph(cg);
      if (options.profileJson) {
        console.error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .option('--extra-root <path>', 'Additional source root to sync (repeatable)', collectRepeatable, [])
  .option('--include <glob>', 'Only sync files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--exclude <glob>', 'Exclude files under source roots matching this gitignore-style pattern (repeatable)', collectRepeatable, [])
  .option('--include-vendored', 'Include vendor/ and vendored/ source instead of the default dependency-source exclusion')
  .option('--max-file-size <size>', 'Skip source files larger than this size (bytes, kb, mb, gb; default 5mb)')
  .option('--recurse-submodules', 'Index nested Git repositories/submodules')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean; dataDir?: string; extraRoot?: string[]; recurseSubmodules?: boolean } & IndexingControlOptions) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(pathArg, dataDir);
    const presenter = createTerminalPresenter({ quiet: options.quiet });

    try {
      const controls = indexingControls(options);
      if (!isInitialized(projectPath, { dataDir })) {
        if (!options.quiet) {
          error(`SolidKG not initialized in ${projectPath}`);
          info(formatDataDirHint(dataDir));
        }
        process.exit(1);
      }

      const { default: SolidKG } = await loadSolidKG();
      const cg = await SolidKG.open(projectPath, { dataDir, extraRoots: options.extraRoot, includeSubmodules: options.recurseSubmodules, ...controls });

      if (options.quiet) {
        await cg.sync({ extraRoots: options.extraRoot, includeSubmodules: options.recurseSubmodules, ...controls });
        cg.destroy();
        return;
      }

      const progress = createInteractiveProgress(presenter);

      const result = await cg.sync({
        ...(progress ? { onProgress: progress.onProgress } : {}),
        extraRoots: options.extraRoot,
        includeSubmodules: options.recurseSubmodules,
        ...controls,
      });

      const finalMessage = formatSyncSuccessLine(result);
      const finalCompletion = formatSyncCompletionSummary(result);
      await progress?.stop(finalCompletion);

      if (progress === undefined) {
        presenter.message(finalMessage);
      }
      cg.destroy();
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * solidkg status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (pathArg: string | undefined, options: { json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(pathArg, dataDir);
    // The directory the user actually ran from, before walking up to the index
    // root. Used to detect when the resolved index lives in a different git
    // working tree (e.g. a nested worktree borrowing the main checkout's index).
    const startPath = path.resolve(pathArg || process.cwd());
    const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        if (options.json) {
          console.log(JSON.stringify({
            schemaVersion: STATUS_JSON_SCHEMA_VERSION,
            initialized: false,
            projectPath,
            dataDir: getSolidKGDir(projectPath, { dataDir }),
            counts: {
              files: 0,
              nodes: 0,
              edges: 0,
              semanticRelations: 0,
            },
            backend: null,
            journalMode: null,
            scip: null,
          }));
          return;
        }
        console.log(chalk.bold('\nSolidKG Status\n'));
        info(`Project: ${projectPath}`);
        info(`Data directory: ${getSolidKGDir(projectPath, { dataDir })}`);
        warn('Not initialized');
        info(formatDataDirHint(dataDir));
        return;
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();
      const journalMode = cg.getJournalMode();

      // JSON output mode
      if (options.json) {
        console.log(JSON.stringify({
          schemaVersion: STATUS_JSON_SCHEMA_VERSION,
          initialized: true,
          projectPath,
          dataDir: cg.getDataDir(),
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          counts: {
            files: stats.fileCount,
            nodes: stats.nodeCount,
            edges: stats.edgeCount,
            semanticRelations: stats.hyperedgeCount ?? 0,
          },
          semanticRelations: {
            total: stats.hyperedgeCount ?? 0,
            byKind: stats.hyperedgesByKind ?? {},
          },
          scip: stats.scip,
          solidkgVersion: stats.solidkgVersion ?? null,
          dbSizeBytes: stats.dbSizeBytes,
          backend,
          journalMode,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
          worktreeMismatch: worktreeMismatch
            ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
            : null,
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nSolidKG Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      console.log(chalk.cyan('Data dir:'), cg.getDataDir());
      if (worktreeMismatch) {
        warn(worktreeMismatchWarning(worktreeMismatch));
      }
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      if (stats.scip && (stats.scip.indexes > 0 || stats.scip.symbols > 0 || stats.scip.occurrences > 0)) {
        console.log(`  SCIP:      ${formatNumber(stats.scip.indexes)} index(es), ${formatNumber(stats.scip.symbols)} symbols, ${formatNumber(stats.scip.occurrences)} occurrences, ${formatNumber(stats.scip.linkedNodes)} linked nodes`);
      }
      if (stats.scip?.generation && Object.keys(stats.scip.generation.languages).length > 0) {
        console.log('  SCIP gen:');
        for (const state of Object.values(stats.scip.generation.languages).sort((left, right) => left.language.localeCompare(right.language))) {
          const detail = state.message ? ` (${state.message})` : '';
          console.log(`    ${state.language.padEnd(12)} ${state.state}${detail}`);
        }
      }
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  Version:   ${stats.solidkgVersion ?? 'unknown'}`);
      // Surface the active SQLite backend (node:sqlite — Node's built-in real
      // SQLite, full WAL + FTS5, no native build).
      const backendLabel = chalk.green(`node:sqlite ${getGlyphs().dash} built-in (full WAL)`);
      console.log(`  Backend:   ${backendLabel}`);
      // Effective journal mode: 'wal' means concurrent reads never block on a
      // writer; anything else means they can ("database is locked"). node:sqlite
      // supports WAL everywhere, so a non-wal mode means the filesystem can't
      // (network mounts, WSL2 /mnt). See issue #238.
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
      console.log();

      // Node breakdown
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Language breakdown
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Pending changes
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "solidkg sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      cg.destroy();
    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);

      const limit = parseBoundedIntegerOption(options.limit || '10', 'query limit', 1, 1000);
      const kind = options.kind as NodeKind | undefined;
      if (kind !== undefined && !NODE_KINDS.includes(kind)) {
        throw new Error(`Invalid node kind "${options.kind}". Expected one of: ${NODE_KINDS.join(', ')}.`);
      }
      const results = cg.searchNodes(search, {
        limit,
        kinds: kind ? [kind] : undefined,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;
            const score = chalk.dim(`(score ${result.score.toFixed(2)})`);

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name) +
              ' ' + score
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped, overview)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree and overview formats')
  .option('--expand <path>', 'Overview format: expand a collapsed path beyond max depth (repeatable)', collectRepeatable, [])
  .option('--max-entries <number>', 'Overview format: maximum rendered entries before capping output')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (options: {
    path?: string;
    dataDir?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    expand?: string[];
    maxEntries?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      let files = cg.getFiles();

      if (files.length === 0) {
        info('No files indexed. Run "solidkg index" first.');
        cg.destroy();
        return;
      }

      // Filter by path prefix
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => pathMatchesRootAwarePrefix(f.path, filter));
      }

      // Filter by glob pattern
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        info('No files found matching the criteria.');
        cg.destroy();
        return;
      }

      // JSON output
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(output, null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      if (format !== 'tree' && format !== 'flat' && format !== 'grouped' && format !== 'overview') {
        throw new Error(`Invalid --format "${format}". Expected tree, flat, grouped, or overview.`);
      }
      const maxDepth = options.maxDepth ? parseBoundedIntegerOption(options.maxDepth, '--max-depth', 1, 20) : undefined;

      // Format output
      switch (format) {
        case 'overview':
          console.log(cg.getOverviewText(parseOverviewOptions(options)));
          break;

        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('overview [path]')
  .description('Show indexed repository overview tree')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--max-depth <number>', 'Maximum directory depth')
  .option('--expand <path>', 'Expand a collapsed path beyond max depth (repeatable)', collectRepeatable, [])
  .option('--max-entries <number>', 'Maximum rendered entries before capping output')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (pathArg: string | undefined, options: OverviewCliOptions) => {
    try {
      await printRepositoryOverview(pathArg, options);
    } catch (err) {
      error(`Failed to render overview: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

/**
 * solidkg context <task>
 */
program
  .command('context <task>')
  .description('Build context for a task (outputs markdown)')
  .option('-p, --path <path>', 'Project path')
  .option('-n, --max-nodes <number>', 'Maximum nodes to include')
  .option('-c, --max-code <number>', 'Maximum code blocks')
  .option('--no-code', 'Exclude code blocks')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .option('--detail <detail>', 'Detail preset (standard, minimal)', 'standard')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (task: string, options: {
    path?: string;
    dataDir?: string;
    maxNodes?: string;
    maxCode?: string;
    code?: boolean;
    format?: string;
    detail?: string;
  }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      const detailLevel = parseContextDetail(options.detail ?? 'standard');

      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);

      const maxNodes = parseOptionalBoundedIntegerOption(options.maxNodes, 'context max nodes', 20, 1, 200);
      const maxCodeBlocks = options.maxCode === undefined && detailLevel === 'minimal'
        ? undefined
        : parseOptionalBoundedIntegerOption(options.maxCode, 'context max code blocks', 5, 0, 50);
      const contextOptions = {
        maxNodes,
        includeCode: options.code !== false,
        format: options.format as 'markdown' | 'json',
        detailLevel,
        ...(maxCodeBlocks !== undefined ? { maxCodeBlocks } : {}),
      };

      const context = await cg.buildContext(task, contextOptions);

      // Output the context
      console.log(context);

      cg.destroy();
    } catch (err) {
      error(`Failed to build context: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('snapshot <action> [label]')
  .description('Create, list, delete, or diff explicit graph snapshots')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --description <text>', 'Snapshot description for create')
  .option('-m, --metadata <json>', 'Snapshot metadata JSON object for create')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (action: string, label: string | undefined, options: { path?: string; description?: string; metadata?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = action === 'create' || action === 'delete'
        ? await (await loadSolidKG()).default.open(projectPath, { dataDir })
        : await openSolidKGReadOnly(projectPath, dataDir);

      if (action === 'list') {
        const snapshots = await cg.listSnapshots();
        if (options.json) console.log(JSON.stringify(snapshots, null, 2));
        else if (snapshots.length === 0) info('No graph snapshots saved.');
        else {
          console.log(chalk.bold('\nGraph Snapshots:\n'));
          for (const snapshot of snapshots) {
            console.log(`${chalk.cyan(snapshot.label)} ${chalk.dim(new Date(snapshot.createdAt).toISOString())}`);
            console.log(chalk.dim(`  ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges, ${snapshot.hyperedgeCount} hyperedges`));
            if (snapshot.description) console.log(chalk.dim(`  ${snapshot.description}`));
            console.log();
          }
        }
        cg.destroy();
        return;
      }

      if (!label) {
        error(`snapshot ${action} requires a label`);
        cg.destroy();
        process.exit(1);
      }

      if (action === 'create') {
        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          const parsed = JSON.parse(options.metadata) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('--metadata must be a JSON object');
          }
          metadata = parsed as Record<string, unknown>;
        }
        const snapshot = await cg.createSnapshot(label, { description: options.description, metadata });
        if (options.json) console.log(JSON.stringify(snapshot, null, 2));
        else success(`Saved snapshot "${snapshot.label}" (${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges)`);
      } else if (action === 'delete') {
        const deleted = await cg.deleteSnapshot(label);
        if (options.json) console.log(JSON.stringify({ label, deleted }, null, 2));
        else if (deleted) success(`Deleted snapshot "${label}"`);
        else warn(`Snapshot "${label}" not found`);
      } else if (action === 'diff') {
        const diff = await cg.diffSnapshot(label);
        if (options.json) console.log(JSON.stringify(diff, null, 2));
        else {
          console.log(chalk.bold(`\nSnapshot Diff: ${label}\n`));
          const rows = [
            ['Added nodes', diff.addedNodes.length],
            ['Removed nodes', diff.removedNodes.length],
            ['Changed nodes', diff.changedNodes.length],
            ['Added edges', diff.addedEdges.length],
            ['Removed edges', diff.removedEdges.length],
            ['Changed edges', diff.changedEdges.length],
            ['Added hyperedges', diff.addedHyperedges.length],
            ['Removed hyperedges', diff.removedHyperedges.length],
            ['Changed hyperedges', diff.changedHyperedges.length],
            ['Added hyperedge members', diff.addedHyperedgeMembers.length],
            ['Removed hyperedge members', diff.removedHyperedgeMembers.length],
            ['Changed hyperedge members', diff.changedHyperedgeMembers.length],
          ];
          for (const [name, count] of rows) console.log(`${String(name).padEnd(26)} ${count}`);
        }
      } else {
        throw new Error(`Unknown snapshot action: ${action}`);
      }

      cg.destroy();
    } catch (err) {
      error(`Snapshot command failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('architecture [action] [name]')
  .description('Analyze or inspect package/layer architecture rollups')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --layers <json>', 'Layer rules JSON array for analyze')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (actionArg: string | undefined, name: string | undefined, options: { path?: string; layers?: string; json?: boolean; dataDir?: string }) => {
    const action = actionArg || 'get';
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const { default: SolidKG } = await loadSolidKG();
      const cg = await SolidKG.open(projectPath, { dataDir });
      let layers: Array<{ name: string; paths: string[] }> | undefined;
      if (options.layers) {
        const parsed = JSON.parse(options.layers) as unknown;
        if (!Array.isArray(parsed)) throw new Error('--layers must be a JSON array');
        layers = parsed.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('each layer rule must be an object');
          const rule = entry as Record<string, unknown>;
          if (typeof rule.name !== 'string' || !Array.isArray(rule.paths) || !rule.paths.every((p) => typeof p === 'string')) {
            throw new Error('each layer rule must have a string name and string[] paths');
          }
          return { name: rule.name, paths: rule.paths as string[] };
        });
      }

      if (action === 'analyze') {
        const report = cg.analyzeArchitecture({ layers });
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else printArchitectureReport(report);
      } else if (action === 'get') {
        const report = cg.getArchitecture();
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else printArchitectureReport(report);
      } else if (action === 'coupling') {
        const coupling = cg.getCoupling();
        console.log(JSON.stringify(coupling, null, 2));
      } else if (action === 'package') {
        if (!name) throw new Error('architecture package requires a package name or root path');
        const pkg = cg.getPackage(name);
        if (options.json) console.log(JSON.stringify(pkg, null, 2));
        else if (pkg) console.log(`${chalk.cyan(pkg.name)} ${chalk.dim(pkg.root)} (${pkg.fileCount} files, ${pkg.provenance})`);
        else warn(`Package "${name}" not found`);
      } else {
        throw new Error(`Unknown architecture action: ${action}`);
      }

      cg.destroy();
    } catch (err) {
      error(`Architecture command failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

function printArchitectureReport(report: {
  packages: Array<{ name: string; root: string; fileCount: number }>;
  layers: Array<{ name: string; fileCount: number }>;
  packageDependencies: Array<{ source: string; target: string; edgeKinds: string[] }>;
  layerDependencies: Array<{ source: string; target: string; edgeKinds: string[] }>;
  coupling: { packages: Array<{ name: string; Ca: number; Ce: number; instability: number }>; layers: Array<{ name: string; Ca: number; Ce: number; instability: number }> };
}): void {
  console.log(chalk.bold('\nArchitecture Rollup\n'));
  console.log(chalk.bold('Packages:'));
  for (const pkg of report.packages) {
    const metric = report.coupling.packages.find((entry) => entry.name === pkg.name);
    const coupling = metric ? ` Ca=${metric.Ca} Ce=${metric.Ce} I=${metric.instability.toFixed(2)}` : '';
    console.log(`  ${chalk.cyan(pkg.name)} ${chalk.dim(pkg.root)} (${pkg.fileCount} files)${coupling}`);
  }
  console.log(chalk.bold('\nLayers:'));
  for (const layer of report.layers) {
    const metric = report.coupling.layers.find((entry) => entry.name === layer.name);
    const coupling = metric ? ` Ca=${metric.Ca} Ce=${metric.Ce} I=${metric.instability.toFixed(2)}` : '';
    console.log(`  ${chalk.cyan(layer.name)} (${layer.fileCount} files)${coupling}`);
  }
  console.log(chalk.bold('\nPackage Dependencies:'));
  for (const dep of report.packageDependencies) console.log(`  ${dep.source} -> ${dep.target} (${dep.edgeKinds.join(', ')})`);
  console.log(chalk.bold('\nLayer Dependencies:'));
  for (const dep of report.layerDependencies) console.log(`  ${dep.source} -> ${dep.target} (${dep.edgeKinds.join(', ')})`);
  console.log();
}

const scipCommand = program
  .command('scip')
  .description('Generate and import SCIP precision indexes');

scipCommand
  .command('generate')
  .description('Generate SCIP index files for supported languages')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --language <language>', 'Only generate SCIP for one language')
  .option('-o, --output-dir <path>', 'Directory for generated .scip files')
  .option('--scip <mode>', 'SCIP generation mode: auto, off, or required', 'auto')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (options: { path?: string; language?: string; outputDir?: string; scip?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);
    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const { default: SolidKG } = await loadSolidKG();
      const cg = await SolidKG.open(projectPath, { dataDir });
      const result = await cg.generateScipIndexes({
        mode: parseScipMode(options.scip ?? 'auto'),
        languages: options.language ? [options.language] : undefined,
        outputDir: options.outputDir ? path.resolve(options.outputDir) : undefined,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(`Generated ${formatNumber(result.generatedFiles.length)} SCIP file(s)`);
        for (const state of Object.values(result.status.languages).sort((left, right) => left.language.localeCompare(right.language))) {
          const detail = state.message ? ` ${getGlyphs().dash} ${state.message}` : '';
          info(`${state.language}: ${state.state}${detail}`);
        }
      }
      cg.destroy();
      if (!result.success) process.exit(1);
    } catch (err) {
      error(`Failed to generate SCIP indexes: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scipCommand
  .command('import <files...>')
  .description('Import existing .scip index files into the SolidKG database')
  .option('-p, --path <path>', 'Project path')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (files: string[], options: { path?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);
    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const { default: SolidKG } = await loadSolidKG();
      const cg = await SolidKG.open(projectPath, { dataDir });
      const indexFiles = files.map((file) => path.resolve(file));
      const stats = await cg.importScipIndexes(indexFiles);
      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        success(`Imported ${formatNumber(stats.indexes)} SCIP index(es)`);
        info(`${formatNumber(stats.symbols)} symbols, ${formatNumber(stats.occurrences)} occurrences, ${formatNumber(stats.linkedNodes)} linked nodes`);
      }
      cg.destroy();
    } catch (err) {
      error(`Failed to import SCIP indexes: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg serve
 */
program
  .command('serve')
  .description('Start SolidKG as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (options: { path?: string; mcp?: boolean; watch?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = options.path ? resolveProjectPath(options.path, dataDir) : undefined;

    // Commander sets watch=false when --no-watch is passed. Route it through
    // the same env-var chokepoint the watcher and MCP server already honor.
    if (options.watch === false) {
      process.env.SOLIDKG_NO_WATCH = '1';
    }

    try {
      if (options.mcp) {
        // Start MCP server - it handles initialization lazily based on rootUri from client
        const { MCPServer } = await import('../mcp/index');
        const server = new MCPServer(projectPath, { dataDir });
        await server.start();
        // Server will run until terminated
      } else {
        // Default: show info about MCP mode.
        // Use stderr so stdout stays clean for any piped/stdio usage.
        console.error(chalk.bold('\nSolidKG MCP Server\n'));
        console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
        console.error('\nTo use with Claude Code, add to your MCP configuration:');
        console.error(chalk.dim(`
{
  "mcpServers": {
    "solidkg": {
      "command": "solidkg",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.error('Available tools:');
        console.error(chalk.cyan('  solidkg_search') + '    - Search for code symbols');
        console.error(chalk.cyan('  solidkg_context') + '   - Build context for a task');
        console.error(chalk.cyan('  solidkg_callers') + '   - Find callers of a symbol');
        console.error(chalk.cyan('  solidkg_callees') + '   - Find what a symbol calls');
        console.error(chalk.cyan('  solidkg_impact') + '    - Analyze impact of changes');
        console.error(chalk.cyan('  solidkg_node') + '      - Get symbol details');
        console.error(chalk.cyan('  solidkg_precise_refs') + ' - Get SCIP precise references');
        console.error(chalk.cyan('  solidkg_files') + '     - Get project file structure');
        console.error(chalk.cyan('  solidkg_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (pathArg: string | undefined, options: { dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(pathArg, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getSolidKGDir(projectPath, { dataDir }), 'solidkg.lock');

      if (!fs.existsSync(lockPath)) {
        info(`No lock file found ${getGlyphs().dash} nothing to do`);
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg callers <symbol>
 *
 * CLI parity with the MCP graph tools (solidkg_callers/callees/impact) so the
 * traversal queries work in scripts, CI, and git hooks without a running MCP
 * server.
 */
program
  .command('callers <symbol>')
  .description('Find all functions/methods that call a specific symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      const limit = parseOptionalBoundedIntegerOption(options.limit, '--limit', 20, 1, 100);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallers: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];
      const allEdges: Edge[] = [];
      const seenEdges = new Set<string>();
      const detailedResults = [];
      const exactMatches = matches.filter((match) => match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`));
      const targetMatches = exactMatches.length > 0 ? exactMatches : matches.slice(0, 1);
      const matchedTargets = targetMatches.map((match) => ({ name: match.node.name, kind: match.node.kind, filePath: match.node.filePath, startLine: match.node.startLine }));

      for (const match of targetMatches) {
        const detailed = cg.getCallersDetailed(match.node.id);
        detailedResults.push(detailed);
        for (const c of detailed.entries) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
          const edgeKey = `${c.edge.source}->${c.edge.target}:${c.edge.kind}:${c.edge.line ?? ''}:${c.edge.column ?? ''}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            allEdges.push(c.edge);
          }
        }
      }

      const limited = allCallers.slice(0, limit);
      const packet = formatCliGraphTraversalPacket({
        queryKind: 'direct_callers',
        startNodeIds: targetMatches.map((match) => match.node.id),
        direction: 'reverse',
        edgeKinds: ['calls'],
        maxDepth: 1,
        resultNodeIds: [...seen],
        edges: allEdges,
        traversals: detailedResults.map((entry) => entry.traversal),
        relationCounts: relationCountsForEdges(allEdges),
        resultLimitHit: allCallers.length > limit,
      });

      if (options.json) {
        console.log(JSON.stringify({ symbol, matches: matchedTargets, callers: limited, graphTraversal: packet.packet }, null, 2));
      } else if (limited.length === 0) {
        info(`No callers found for "${symbol}"`);
        console.log(packet.markdown);
      } else {
        const countLabel = allCallers.length === limited.length ? `${limited.length}` : `${limited.length} shown, ${allCallers.length} found`;
        console.log(chalk.bold(`\nCallers of "${symbol}" (${countLabel}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
        console.log(packet.markdown);
      }

      cg.destroy();
    } catch (err) {
      error(`callers failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg callees <symbol>
 */
program
  .command('callees <symbol>')
  .description('Find all functions/methods that a specific symbol calls')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      const limit = parseOptionalBoundedIntegerOption(options.limit, '--limit', 20, 1, 100);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallees: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];
      const allEdges: Edge[] = [];
      const seenEdges = new Set<string>();
      const detailedResults = [];
      const calleeStartNodeIds: string[] = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        calleeStartNodeIds.push(match.node.id);
        const detailed = cg.getCalleesDetailed(match.node.id);
        detailedResults.push(detailed);
        for (const c of detailed.entries) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
          const edgeKey = `${c.edge.source}->${c.edge.target}:${c.edge.kind}:${c.edge.line ?? ''}:${c.edge.column ?? ''}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            allEdges.push(c.edge);
          }
        }
      }

      if (allCallees.length === 0 && matches[0]) {
        if (calleeStartNodeIds.length === 0) calleeStartNodeIds.push(matches[0].node.id);
        const detailed = cg.getCalleesDetailed(matches[0].node.id);
        detailedResults.push(detailed);
        for (const c of detailed.entries) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
          const edgeKey = `${c.edge.source}->${c.edge.target}:${c.edge.kind}:${c.edge.line ?? ''}:${c.edge.column ?? ''}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            allEdges.push(c.edge);
          }
        }
      }

      const limited = allCallees.slice(0, limit);
      const packet = formatCliGraphTraversalPacket({
        queryKind: 'direct_callees',
        startNodeIds: calleeStartNodeIds,
        direction: 'forward',
        edgeKinds: ['calls'],
        maxDepth: 1,
        resultNodeIds: [...seen],
        edges: allEdges,
        traversals: detailedResults.map((entry) => entry.traversal),
        relationCounts: relationCountsForEdges(allEdges),
        resultLimitHit: allCallees.length > limit,
      });

      if (options.json) {
        console.log(JSON.stringify({ symbol, callees: limited, graphTraversal: packet.packet }, null, 2));
      } else if (limited.length === 0) {
        info(`No callees found for "${symbol}"`);
        console.log(packet.markdown);
      } else {
        const countLabel = allCallees.length === limited.length ? `${limited.length}` : `${limited.length} shown, ${allCallees.length} found`;
        console.log(chalk.bold(`\nCallees of "${symbol}" (${countLabel}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
        console.log(packet.markdown);
      }

      cg.destroy();
    } catch (err) {
      error(`callees failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg impact <symbol>
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      const depth = parseOptionalBoundedIntegerOption(options.depth, '--depth', 2, 1, 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      // Merge impact subgraphs across all exact-matching symbols
      const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
      const seenEdges = new Set<string>();
      let mergedEdges: Edge[] = [];
      const impactTraversals: GraphTraversalResult[] = [];
      const impactStartNodeIds: string[] = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        const impact = cg.getImpactRadius(match.node.id, depth);
        impactStartNodeIds.push(match.node.id);
        impactTraversals.push(cg.getImpactTraversal(match.node.id, depth));
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            mergedEdges.push(e);
          }
        }
      }

      // Fallback to top match if exact filter removed everything
      if (mergedNodes.size === 0 && matches[0]) {
        const impact = cg.getImpactRadius(matches[0].node.id, depth);
        impactStartNodeIds.push(matches[0].node.id);
        impactTraversals.push(cg.getImpactTraversal(matches[0].node.id, depth));
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        mergedEdges = [...impact.edges];
      }

      const impactTraversal = mergeTraversalResults(impactStartNodeIds, impactTraversals);
      const impactPacket = formatCliGraphTraversalPacket({
        queryKind: 'impact',
        startNodeIds: impactStartNodeIds,
        direction: 'reverse',
        edgeKinds: Object.keys(relationCountsForEdges(impactTraversal.edges)) as EdgeKind[],
        maxDepth: depth,
        resultNodeIds: impactTraversal.nodeIds,
        edges: impactTraversal.edges,
        traversals: [impactTraversal],
        relationCounts: relationCountsForEdges(impactTraversal.edges),
        resultLimitHit: false,
      });

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          depth,
          nodeCount: mergedNodes.size,
          edgeCount: mergedEdges.length,
          affected: Array.from(mergedNodes.values()),
          graphTraversal: impactPacket.packet,
        }, null, 2));
      } else if (mergedNodes.size === 0) {
        info(`No affected symbols found for "${symbol}"`);
        console.log(impactPacket.markdown);
      } else {
        console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

        // Group by file
        const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
        for (const node of mergedNodes.values()) {
          const list = byFile.get(node.filePath) || [];
          list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
          byFile.set(node.filePath, list);
        }

        for (const [file, nodes] of byFile) {
          console.log(chalk.cyan(file));
          for (const node of nodes) {
            const loc = node.startLine ? `:${node.startLine}` : '';
            console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
          }
          console.log();
        }
        console.log(impactPacket.markdown);
      }

      cg.destroy();
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   git diff --name-only | solidkg affected --stdin
 *   solidkg affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .option('--data-dir <dir>', 'Directory for SolidKG data (defaults to <project>/.solidkg)')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean; dataDir?: string }) => {
    const dataDir = resolveDataDir(options.dataDir);
    const projectPath = resolveProjectPath(options.path, dataDir);

    try {
      if (!isInitialized(projectPath, { dataDir })) {
        error(`SolidKG not initialized in ${projectPath}`);
        info(formatDataDirHint(dataDir));
        process.exit(1);
      }

      // Collect changed files from args or stdin
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      changedFiles = Array.from(new Set(changedFiles.map(file => normalizeAffectedFileInput(file, projectPath))));

      if (changedFiles.length === 0) {
        if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
        process.exit(0);
      }

      const cg = await openSolidKGReadOnly(projectPath, dataDir);
      const maxDepth = parseInt(options.depth || '5', 10);

      // Common test file patterns
      const defaultTestPatterns = [
        /\.spec\./,
        /\.test\./,
        /\/__tests__\//,
        /\/tests?\//,
        /\/e2e\//,
        /\/spec\//,
      ];

      // Custom filter pattern
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // Convert glob to regex: ** → .+, * → [^/]*, . → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      function isTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return defaultTestPatterns.some(p => p.test(filePath));
      }

      // BFS to find all transitive dependents of changed files, filtered to test files
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // If the changed file is itself a test file, include it
        if (isTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS through dependents
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (isTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // Output
      if (options.json) {
        console.log(JSON.stringify({
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }, null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * solidkg install
 */
program
  .command('install')
    .description('Install solidkg MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, Kimi Code)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install scope: "global" for personal/user config or "local" for project/team config. Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--check', 'Print a read-only setup health report and exit')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    permissions?: boolean;
    check?: boolean;
    printConfig?: string;
  }) => {
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }

    if (opts.check) {
      const { runInstallCheck } = await import('../installer/check');
      try {
        runInstallCheck({
          target: opts.target,
          location: opts.location as 'global' | 'local' | undefined,
        });
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    if (opts.printConfig) {
      const { getTarget, listTargetIds } = await import('../installer/targets/registry');
      const target = getTarget(opts.printConfig);
      if (!target) {
        const known = listTargetIds().join(', ');
        error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
        process.exit(1);
      }
      const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
      process.stdout.write(target.printConfig(loc));
      return;
    }

    const { runInstallerWithOptions } = await import('../installer');
    try {
      // Commander's `--no-permissions` makes `opts.permissions === false`;
      // omitting the flag leaves it `true` (the positive-form default).
      // We MUST treat the default-true as "user did not override — let
      // the orchestrator prompt" and only forward an explicit `false`
      // (or `true` when --yes implies it). Otherwise the auto-allow
      // prompt is silently skipped on every interactive run.
      const explicitNoPermissions = opts.permissions === false;
      const autoAllow: boolean | undefined = explicitNoPermissions
        ? false
        : opts.yes
          ? true
          : undefined;

      await runInstallerWithOptions({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        autoAllow,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * solidkg uninstall
 *
 * Inverse of `install`. Removes the solidkg MCP server entry,
 * instructions block, and permissions from every agent (or a
 * `--target` subset). Prompts global-vs-local when not given. Does NOT
 * delete the `.solidkg/` index — that's `solidkg uninit`.
 */
program
  .command('uninstall')
    .description('Remove solidkg from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, Kimi Code)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option('-l, --location <where>', 'Uninstall scope: "global" for personal/user config or "local" for project/team config. Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
  }) => {
    const { runUninstaller } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      await runUninstaller({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Parse and run
program.parse();

} // end main()
