/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { hiddenExecFileSyncOptions } from '../platform/child-process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, initGrammars, loadGrammarsForLanguages } from './grammars';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath, isPathWithinRootReal } from '../utils';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import {
  CONFIG_READ_PRODUCER_ID,
  CONFIG_READ_PRODUCER_VERSION,
  analyzeConfigReadCapabilities,
} from '../capabilities';
import type { ResolutionContext } from '../resolution/types';
import type { IndexProfile } from '../profiling';
import {
  buildSourceRoots,
  type SourceRoot,
  type SourceRootOptions,
} from '../source-roots';

export {
  buildSourceRoots,
  type SourceRoot,
  type SourceRootInput,
} from '../source-roots';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;
const MAX_PARSE_TIMEOUT_MS = 30_000;

/**
 * Number of files to parse before recycling the worker thread. This bounds
 * native parser allocations during large indexing runs.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Large files get a fresh worker instead of sharing accumulated parser state.
 */
export const LARGE_FILE_FRESH_WORKER_BYTES = 256 * 1024;

export function shouldRecycleWorkerForLargeFile(contentLength: number, workerParseCount: number): boolean {
  return contentLength >= LARGE_FILE_FRESH_WORKER_BYTES && workerParseCount > 0;
}

export function parseTimeoutMsForContentLength(contentLength: number): number {
  return Math.min(
    MAX_PARSE_TIMEOUT_MS,
    PARSE_TIMEOUT_MS + Math.floor(contentLength / 100_000) * 10_000
  );
}

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'scip' | 'resolving' | 'synthesis';
  detail?: 'source_chunks';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
  skippedFiles?: IndexSkippedFile[];
  profile?: IndexProfile;
}

export type IndexSkipReason = 'excluded' | 'max_size' | 'parse_timeout';

export interface IndexSkippedFile {
  path: string;
  reason: IndexSkipReason;
  message: string;
  pattern?: string;
  size?: number;
  limit?: number;
}

export type IndexIssue =
  | { kind: 'diagnostic'; diagnostic: ExtractionError }
  | { kind: 'skipped'; skipped: IndexSkippedFile };

export type IndexIssueSink = (issue: IndexIssue) => void;

function emitIndexIssue(onIssue: IndexIssueSink | undefined, issue: IndexIssue): void {
  try {
    onIssue?.(issue);
  } catch (error) {
    logWarn('Index issue sink failed', { error: String(error) });
  }
}

function isParseTimeoutMessage(message: string): boolean {
  return /^Parse timed out after \d+ms$/.test(message);
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export interface ScanOptions {
  includeSubmodules?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  includeVendored?: boolean;
  maxFileSizeBytes?: number;
  skippedFiles?: IndexSkippedFile[];
}

export interface ExtractionOrchestratorOptions extends ScanOptions, SourceRootOptions {}

interface ScannedFile {
  displayPath: string;
  relativePath: string;
  fullPath: string;
  root: SourceRoot;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Skip files larger than this (bytes). Generated bundles, minified JS, and
 * vendored blobs blow the WASM heap and the worker-recycle budget for no useful
 * symbols. 5 MiB keeps normal first-party generated/test source visible while
 * still excluding pathological mega-files by default.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks SolidKG supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); opt in with
 * `includeVendored` or an explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because SolidKG indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  'target', '.gradle',
  // .NET
  'obj',
  // Vendored source bundles
  'vendor', 'vendored',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
];

function normalizeScopePattern(pattern: string): string {
  const normalized = normalizePath(pattern.trim()).replace(/^\//, '');
  if (!normalized || normalized === '.') return normalized;
  if (normalized.includes('*') || normalized.endsWith('/')) return normalized;
  return normalized.includes('.') ? normalized : `${normalized}/**`;
}

function normalizeScopePatterns(patterns: string[] | undefined): string[] {
  return (patterns ?? [])
    .map(normalizeScopePattern)
    .filter((pattern) => pattern.length > 0);
}

function defaultIgnorePatterns(options: ScanOptions = {}): string[] {
  return options.includeVendored
    ? DEFAULT_IGNORE_PATTERNS.filter((pattern) => pattern !== 'vendor/' && pattern !== 'vendored/')
    : DEFAULT_IGNORE_PATTERNS;
}

function buildUserExcludeMatcher(options: ScanOptions = {}): Ignore | null {
  const patterns = normalizeScopePatterns(options.excludePatterns);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

function buildUserIncludeMatcher(options: ScanOptions = {}): Ignore | null {
  const patterns = normalizeScopePatterns(options.includePatterns);
  return patterns.length > 0 ? ignore().add(patterns) : null;
}

function firstMatchingPattern(filePath: string, patterns: string[] | undefined): string | undefined {
  const normalized = normalizePath(filePath);
  for (const pattern of normalizeScopePatterns(patterns)) {
    if (ignore().add(pattern).ignores(normalized)) return pattern;
  }
  return undefined;
}

function recordSkippedFile(options: ScanOptions, skipped: IndexSkippedFile): void {
  options.skippedFiles?.push(skipped);
}

function isIncludedByUserPatterns(filePath: string, options: ScanOptions): boolean {
  const includeMatcher = buildUserIncludeMatcher(options);
  return !includeMatcher || includeMatcher.ignores(normalizePath(filePath));
}

function shouldIndexVisibleSourceFile(filePath: string, options: ScanOptions): boolean {
  if (!isSourceFile(filePath)) return false;

  const userExcludeMatcher = buildUserExcludeMatcher(options);
  if (userExcludeMatcher?.ignores(filePath)) {
    recordSkippedFile(options, {
      path: filePath,
      reason: 'excluded',
      pattern: firstMatchingPattern(filePath, options.excludePatterns),
      message: 'File matched an exclude pattern',
    });
    return false;
  }

  if (!isIncludedByUserPatterns(filePath, options)) {
    recordSkippedFile(options, {
      path: filePath,
      reason: 'excluded',
      message: 'File did not match any include pattern',
    });
    return false;
  }

  return true;
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default. Shared
 * by both enumeration paths so behavior is identical with or without git — and so
 * the defaults apply to tracked files too (committing a dependency dir doesn't make
 * it project code; use `includeVendored` or a `.gitignore` negation to opt in).
 */
export function buildDefaultIgnore(rootDir: string, options: ScanOptions = {}): Ignore {
  const ig = ignore().add(defaultIgnorePatterns(options));
  try {
    const rootGitignore = path.join(rootDir, '.gitignore');
    if (fs.existsSync(rootGitignore)) ig.add(fs.readFileSync(rootGitignore, 'utf-8'));
    if (options.includeVendored) ig.add(['!vendor/', '!vendor/**', '!vendored/', '!vendored/**']);
    const excludePatterns = normalizeScopePatterns(options.excludePatterns);
    if (excludePatterns.length > 0) ig.add(excludePatterns);
  } catch {
    // Unreadable root .gitignore — the built-in defaults still apply.
  }
  return ig;
}

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.)
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, options: ScanOptions = {}): void {
  const gitOpts = hiddenExecFileSyncOptions({ cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] });

  const addRegularFile = (gitPath: string): void => {
    const fullPath = path.join(repoDir, gitPath);
    try {
      if (!fs.statSync(fullPath).isFile()) return;
    } catch {
      return;
    }
    files.add(normalizePath(prefix + gitPath));
  };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  const tracked = execFileSync('git', options.includeSubmodules ? ['ls-files', '-c', '--recurse-submodules'] : ['ls-files', '-c'], gitOpts);
  for (const line of tracked.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      addRegularFile(trimmed);
    }
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  if (options.includeSubmodules) {
    try {
      const gitmodules = fs.readFileSync(path.join(repoDir, '.gitmodules'), 'utf-8');
      for (const match of gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
        const submodulePath = normalizePath(match[1]!.trim()).replace(/\/$/, '');
        if (!submodulePath) continue;
        const childDir = path.join(repoDir, submodulePath);
        if (fs.existsSync(childDir)) {
          collectGitFiles(childDir, prefix + submodulePath + '/', files, options);
        }
      }
    } catch {
      // No .gitmodules file, or unreadable: normal git-visible files still apply.
    }
  }

  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], gitOpts);
  for (const line of untracked.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git check anyway, and skip anything else exactly as git
      // itself skips it (we never descend into a non-repo opaque dir).
      const childDir = path.join(repoDir, trimmed);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        collectGitFiles(childDir, prefix + trimmed, files, options);
      }
      continue;
    }
    addRegularFile(trimmed);
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
function getGitVisibleFiles(rootDir: string, options: ScanOptions = {}): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      hiddenExecFileSyncOptions({ cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          hiddenExecFileSyncOptions({ cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    collectGitFiles(rootDir, '', files, options);
    // Apply built-in default ignores uniformly — to tracked files too, since
    // committing a dependency/build dir doesn't make it project code. A
    // `includeVendored` or a `.gitignore` negation (e.g. `!vendored/`) is the explicit opt-in. (issue #407)
    const ig = buildDefaultIgnore(rootDir, options);
    const visible = new Set<string>();
    for (const file of files) {
      if (ig.ignores(file)) {
        if (isSourceFile(file)) {
          recordSkippedFile(options, {
            path: file,
            reason: 'excluded',
            pattern: firstMatchingPattern(file, options.excludePatterns),
            message: 'File matched default, .gitignore, or exclude rules',
          });
        }
        continue;
      }
      visible.add(file);
    }
    return visible;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--no-renames'],
      hiddenExecFileSyncOptions({ cwd: rootDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] })
    );

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const line of output.split('\n')) {
      if (line.length < 4) continue; // Minimum: "XY file"

      const statusCode = line.substring(0, 2);
      const filePath = normalizePath(line.substring(3));

      // Skip non-source files (git status already omits .gitignored paths).
      if (!isSourceFile(filePath)) continue;

      if (statusCode === '??') {
        added.push(filePath);
      } else if (statusCode.includes('D')) {
        deleted.push(filePath);
      } else {
        // M, MM, AM, A (staged), etc. — treat as modified
        modified.push(filePath);
      }
    }

    return { modified, added, deleted };
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void,
  options: ScanOptions = {}
): string[] {
  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir, options);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIndexVisibleSourceFile(filePath, options)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress, options);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void,
  options: ScanOptions = {}
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir, options);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIndexVisibleSourceFile(filePath, options)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress, options);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void,
  options: ScanOptions = {}
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();

  // A .gitignore matcher scoped to the directory that declared it. Patterns in
  // a nested .gitignore are relative to that directory, so we keep the dir
  // alongside the matcher and test paths relative to it — mirroring how git
  // applies .gitignore files at every level.
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    try {
      const giPath = path.join(dir, '.gitignore');
      if (fs.existsSync(giPath)) {
        return { dir, ig: ignore().add(fs.readFileSync(giPath, 'utf-8')) };
      }
    } catch {
      // Unreadable .gitignore — treat as absent.
    }
    return null;
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
      if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    // The root's .gitignore is already merged into the seeded base matcher (so a
    // negation there can override a built-in default), so skip it here.
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or our own data directory.
      if (entry.name === '.git' || entry.name === '.solidkg') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (!isPathWithinRootReal(relativePath, rootDir)) {
            continue;
          }
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && shouldIndexVisibleSourceFile(relativePath, options)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!options.includeSubmodules && fs.existsSync(path.join(fullPath, '.git'))) continue;
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && shouldIndexVisibleSourceFile(relativePath, options)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  // Seed a base matcher with the built-in default ignores (merged with the root
  // .gitignore so a negation can override). Nested .gitignores still layer per-dir.
  walk(rootDir, [{ dir: rootDir, ig: buildDefaultIgnore(rootDir, options) }]);
  return files;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  private sourceRoots: SourceRoot[];
  private scanOptions: ScanOptions;
  private detectedFrameworkNamesByRoot: Map<string, string[]> | null = null;

  constructor(rootDir: string, queries: QueryBuilder, options: ExtractionOrchestratorOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.queries = queries;
    this.sourceRoots = buildSourceRoots(this.rootDir, options.extraRoots ?? []);
    this.scanOptions = {
      includeSubmodules: options.includeSubmodules === true,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      includeVendored: options.includeVendored === true,
      maxFileSizeBytes: options.maxFileSizeBytes,
    };
  }

  private maxFileSizeBytes(): number {
    return this.scanOptions.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  private displayPath(root: SourceRoot, relativePath: string): string {
    return normalizePath(root.prefix + relativePath);
  }

  private resolveIndexedPath(filePath: string): ScannedFile | null {
    const normalized = normalizePath(filePath);
    for (const root of this.sourceRoots) {
      if (root.prefix && normalized.startsWith(root.prefix)) {
        const relativePath = normalized.slice(root.prefix.length);
        const fullPath = validatePathWithinRoot(root.rootDir, relativePath);
        return fullPath && isPathWithinRootReal(relativePath, root.rootDir) ? { displayPath: normalized, relativePath, fullPath, root } : null;
      }
    }
    if (this.sourceRoots.length === 1) {
      const root = this.sourceRoots[0]!;
      const fullPath = validatePathWithinRoot(root.rootDir, normalized);
      return fullPath && isPathWithinRootReal(normalized, root.rootDir) ? { displayPath: normalized, relativePath: normalized, fullPath, root } : null;
    }
    return null;
  }

  private scanAll(onProgress?: (current: number, file: string) => void): ScannedFile[] {
    const files: ScannedFile[] = [];
    let count = 0;
    for (const root of this.sourceRoots) {
      for (const relativePath of scanDirectory(root.rootDir, undefined, this.scanOptions)) {
        const fullPath = validatePathWithinRoot(root.rootDir, relativePath);
        if (!fullPath || !isPathWithinRootReal(relativePath, root.rootDir)) continue;
        const displayPath = this.displayPath(root, relativePath);
        files.push({ displayPath, relativePath, fullPath, root });
        count++;
        onProgress?.(count, displayPath);
      }
    }
    return files;
  }

  private async scanAllAsync(onProgress?: (current: number, file: string) => void): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    let count = 0;
    for (const root of this.sourceRoots) {
      const relativePaths = await scanDirectoryAsync(root.rootDir, undefined, this.scanOptions);
      for (const relativePath of relativePaths) {
        const fullPath = validatePathWithinRoot(root.rootDir, relativePath);
        if (!fullPath || !isPathWithinRootReal(relativePath, root.rootDir)) continue;
        const displayPath = this.displayPath(root, relativePath);
        files.push({ displayPath, relativePath, fullPath, root });
        count++;
        onProgress?.(count, displayPath);
      }
    }
    return files;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(root: SourceRoot, files: string[]): ResolutionContext {
    const rootDir = root.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full || !isPathWithinRootReal(relativePath, rootDir)) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full || !isPathWithinRootReal(relativePath, rootDir)) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
      // Monorepo support — needed by framework detect()s that probe
      // subpackage manifests (e.g. fabric-view looking at
      // packages/<sub>/package.json when the root manifest is just a
      // workspace declaration). Matches the resolver-context shape.
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? rootDir
            : path.join(rootDir, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private detectFrameworksByRoot(files?: ScannedFile[]): Map<string, string[]> {
    if (this.detectedFrameworkNamesByRoot !== null) return this.detectedFrameworkNamesByRoot;
    const fileList = files ?? this.scanAll();
    const byRoot = new Map<string, { root: SourceRoot; files: string[] }>();

    for (const root of this.sourceRoots) {
      byRoot.set(root.label, { root, files: [] });
    }
    for (const file of fileList) {
      const bucket = byRoot.get(file.root.label) ?? { root: file.root, files: [] };
      bucket.files.push(file.relativePath);
      byRoot.set(file.root.label, bucket);
    }

    const detected = new Map<string, string[]>();
    for (const [label, bucket] of byRoot) {
      const context = this.buildDetectionContext(bucket.root, bucket.files);
      detected.set(label, detectFrameworks(context).map((r) => r.name));
    }
    this.detectedFrameworkNamesByRoot = detected;
    return detected;
  }

  private frameworkNamesForFile(file: ScannedFile): string[] {
    return this.detectFrameworksByRoot().get(file.root.label) ?? [];
  }

  private reconcileTrackedFiles(scannedFiles: ScannedFile[], skippedFiles: IndexSkippedFile[]): void {
    const currentPaths = new Set(scannedFiles.map((file) => file.displayPath));
    const skippedPaths = new Set(skippedFiles.map((file) => file.path));
    for (const tracked of this.queries.getAllFiles()) {
      if (!currentPaths.has(tracked.path) || skippedPaths.has(tracked.path)) {
        this.queries.deleteFile(tracked.path, { deleteScipFacts: true });
      }
    }
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean,
    onIssue?: IndexIssueSink
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const skippedFiles: IndexSkippedFile[] = [];
    this.scanOptions.skippedFiles = skippedFiles;
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const scannedFiles = await this.scanAllAsync((current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });
    filesSkipped += skippedFiles.length;
    for (const skipped of skippedFiles) {
      emitIndexIssue(onIssue, { kind: 'skipped', skipped });
    }

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    this.detectedFrameworkNamesByRoot = null;
    const frameworkNamesByRoot = this.detectFrameworksByRoot(scannedFiles);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
        skippedFiles,
      };
    }

    // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
    const total = scannedFiles.length;
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(scannedFiles.map((f) => detectLanguage(f.displayPath)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Try to use a worker thread for parsing (keeps main thread unblocked for UI).
    // Falls back to in-process parsing if the compiled worker is unavailable (e.g. tests).
    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    const useWorker = fs.existsSync(parseWorkerPath);
    let WorkerClass: typeof import('worker_threads').Worker | null = null;

    if (useWorker) {
      const { Worker } = await import('worker_threads');
      WorkerClass = Worker;
    } else {
      // In-process fallback: load grammars locally
      await loadGrammarsForLanguages(neededLanguages);
    }

    // --- Worker lifecycle management ---
    // The worker can crash or hang on pathological files.
    // We track pending parse promises and handle both cases:
    //   - Timeout: terminate + restart the worker, reject the timed-out request
    //   - Crash: reject all pending promises, restart for remaining files
    let parseWorker: import('worker_threads').Worker | null = null;
    let nextId = 0;
    let workerParseCount = 0;
    const pendingParses = new Map<number, {
      resolve: (result: ExtractionResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    function rejectAllPending(reason: string): void {
      for (const [id, pending] of pendingParses) {
        clearTimeout(pending.timer);
        pendingParses.delete(id);
        pending.reject(new Error(reason));
      }
    }

    function attachWorkerHandlers(w: import('worker_threads').Worker): void {
      w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult }) => {
        if (msg.type === 'parse-result' && msg.id !== undefined) {
          const pending = pendingParses.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingParses.delete(msg.id);
            pending.resolve(msg.result!);
          }
        }
      });

      w.on('error', (err) => {
        logWarn('Parse worker error', { error: err.message });
        rejectAllPending(`Worker error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (code !== 0 && pendingParses.size > 0) {
          logWarn('Parse worker exited unexpectedly', { code });
          rejectAllPending(`Worker exited with code ${code}`);
        }
        // Clear reference so we know to respawn, reset count so
        // the fresh worker gets a full cycle before recycling.
        if (parseWorker === w) {
          parseWorker = null;
          workerParseCount = 0;
        }
      });
    }

    async function ensureWorker(): Promise<import('worker_threads').Worker> {
      if (parseWorker) return parseWorker;
      log('Spawning new parse worker...');
      parseWorker = new WorkerClass!(parseWorkerPath);
      attachWorkerHandlers(parseWorker);

      // Load grammars in the new worker
      await new Promise<void>((resolve, reject) => {
        parseWorker!.once('message', (msg: { type: string }) => {
          if (msg.type === 'grammars-loaded') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        parseWorker!.postMessage({ type: 'load-grammars', languages: neededLanguages });
      });

      return parseWorker;
    }

    if (WorkerClass) {
      await ensureWorker();
    }

    /**
     * Recycle the worker thread to reclaim parser memory.
     * Terminates the current worker and clears the reference so
     * ensureWorker() will spawn a fresh one on the next call.
     */
    function recycleWorker(): void {
      if (!parseWorker) return;
      log(`Recycling worker after ${workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
      const w = parseWorker;
      parseWorker = null;
      workerParseCount = 0;
      // Fire-and-forget: worker.terminate() can hang if native parsing is stuck
      w.terminate().catch(() => {});
    }

    async function requestParse(filePath: string, content: string, frameworkNames: string[]): Promise<ExtractionResult> {
      if (!WorkerClass) {
        // In-process fallback
        return extractFromSource(
          filePath,
          content,
          detectLanguage(filePath, content),
          frameworkNames
        );
      }

      // Recycle the worker before the next parse if we've hit the threshold.
      // This starts a fresh worker with clean parser state.
      if (
        workerParseCount >= WORKER_RECYCLE_INTERVAL ||
        shouldRecycleWorkerForLargeFile(content.length, workerParseCount)
      ) {
        await recycleWorker();
      }

      const worker = await ensureWorker();
      const id = nextId++;
      workerParseCount++;
      const recycleAfterParse = content.length >= LARGE_FILE_FRESH_WORKER_BYTES;

      // Scale timeout for large files: base 10s + 10s per 100KB
      const timeoutMs = parseTimeoutMsForContentLength(content.length);

      return new Promise<ExtractionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingParses.delete(id);
          log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
          // Reject first because terminating a stuck worker can take time.
          parseWorker = null;
          workerParseCount = 0;
          reject(new Error(`Parse timed out after ${timeoutMs}ms`));
          // Fire-and-forget: kill the stuck worker in the background
          worker.terminate().catch(() => {});
        }, timeoutMs);

        pendingParses.set(id, {
          resolve: (result) => {
            if (recycleAfterParse) recycleWorker();
            resolve(result);
          },
          reject,
          timer,
        });
        worker.postMessage({ type: 'parse', id, filePath, content, frameworkNames });
      });
    }

    for (let i = 0; i < scannedFiles.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          filesErrored,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
          skippedFiles,
        };
      }

      const batch = scannedFiles.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const content = await fsp.readFile(fp.fullPath, 'utf-8');
            const stats = await fsp.stat(fp.fullPath);
            return { filePath: fp.displayPath, content, stats, error: null as Error | null, frameworkNames: frameworkNamesByRoot.get(fp.root.label) ?? [] };
          } catch (err) {
            return { filePath: fp.displayPath, content: null as string | null, stats: null as fs.Stats | null, error: err as Error, frameworkNames: frameworkNamesByRoot.get(fp.root.label) ?? [] };
          }
        })
      );

      // Send to worker for parsing, store results on main thread
      for (const { filePath, content, stats, error, frameworkNames } of fileContents) {
        if (signal?.aborted) {
          if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
          return {
            success: false,
            filesIndexed,
            filesSkipped,
            filesErrored,
            nodesCreated: totalNodes,
            edgesCreated: totalEdges,
            errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
            durationMs: Date.now() - startTime,
            skippedFiles,
          };
        }

        // Report progress before parsing (show current file being worked on)
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        // Honour MAX_FILE_SIZE. Without this check, vendored generated
        // headers, minified bundles, and other multi-MB files get indexed,
        // wasting parser memory and the worker recycle budget on inputs with no
        // useful symbols. The single-file extractFile path already enforces
        // this; the bulk path used to silently skip the check.
        const maxFileSizeBytes = this.maxFileSizeBytes();
        if (stats.size > maxFileSizeBytes) {
          processed++;
          filesSkipped++;
          const skipped: IndexSkippedFile = {
            path: filePath,
            reason: 'max_size',
            size: stats.size,
            limit: maxFileSizeBytes,
            message: `File exceeds max size (${stats.size} > ${maxFileSizeBytes})`,
          };
          const diagnostic: ExtractionError = {
            message: `File exceeds max size (${stats.size} > ${maxFileSizeBytes})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          };
          skippedFiles.push(skipped);
          errors.push(diagnostic);
          emitIndexIssue(onIssue, { kind: 'diagnostic', diagnostic });
          emitIndexIssue(onIssue, { kind: 'skipped', skipped });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Parse in worker thread (main thread stays unblocked).
        // Wrapped in try/catch to handle worker timeouts and crashes gracefully.
        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content, frameworkNames);
        } catch (parseErr) {
          const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
          if (isParseTimeoutMessage(message)) {
            processed++;
            filesSkipped++;
            const skipped: IndexSkippedFile = {
              path: filePath,
              reason: 'parse_timeout',
              message,
            };
            const diagnostic: ExtractionError = {
              message,
              filePath,
              severity: 'warning',
              code: 'parse_timeout',
            };
            skippedFiles.push(skipped);
            errors.push(diagnostic);
            emitIndexIssue(onIssue, { kind: 'diagnostic', diagnostic });
            emitIndexIssue(onIssue, { kind: 'skipped', skipped });
            continue;
          }
          processed++;
          filesErrored++;
          errors.push({
            message,
            filePath,
            severity: 'error',
            code: 'parse_error',
          });
          emitIndexIssue(onIssue, { kind: 'diagnostic', diagnostic: errors[errors.length - 1]! });
          continue;
        }

        processed++;

        // Store in database on main thread (SQLite is not thread-safe)
        const language = detectLanguage(filePath, content);
        const storedFileRecord = result.nodes.length > 0 || result.errors.length === 0;
        if (storedFileRecord) {
          this.storeExtractionResult(filePath, content, language, stats, result);
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            if (!err.filePath) err.filePath = filePath;
            emitIndexIssue(onIssue, { kind: 'diagnostic', diagnostic: err });
          }
          errors.push(...result.errors);
        }

        if (storedFileRecord) {
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
        } else if (result.errors.some((e) => e.severity === 'error')) {
          filesErrored++;
        } else {
          filesSkipped++;
        }
      }
    }

    this.reconcileTrackedFiles(scannedFiles, skippedFiles);

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry files whose worker exited unexpectedly on a fresh worker.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        e.message.includes('Worker exited')
    );

    if (retryableErrors.length > 0 && WorkerClass) {
      log(`Retrying ${retryableErrors.length} files whose parse worker exited...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Use a fresh worker for every retry.
        recycleWorker();

        let content: string;
        let resolved: ScannedFile;
        try {
          const indexedPath = this.resolveIndexedPath(filePath);
          if (!indexedPath) continue;
          resolved = indexedPath;
          content = await fsp.readFile(resolved.fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          const frameworkNames = frameworkNamesByRoot.get(resolved.root.label) ?? [];
          result = await requestParse(filePath, content, frameworkNames);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          const resolvedStats = this.resolveIndexedPath(filePath);
          if (!resolvedStats) continue;
          const stats = await fsp.stat(resolvedStats.fullPath);
          this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce parser memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          recycleWorker();

          let fullContent: string;
          let resolved: ScannedFile;
          try {
            const indexedPath = this.resolveIndexedPath(filePath);
            if (!indexedPath) continue;
            resolved = indexedPath;
            fullContent = await fsp.readFile(resolved.fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            const frameworkNames = frameworkNamesByRoot.get(resolved.root.label) ?? [];
            result = await requestParse(filePath, stripped, frameworkNames);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, fullContent);
            const resolvedStats = this.resolveIndexedPath(filePath);
            if (!resolvedStats) continue;
            const stats = await fsp.stat(resolvedStats.fullPath);
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // Shut down parse worker and clear any pending timers
    rejectAllPending('Indexing complete');
    if (parseWorker) {
      (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
      skippedFiles,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    await initGrammars();
    const neededLanguages = [...new Set(filePaths.map((filePath) => detectLanguage(filePath)))];
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }
    await loadGrammarsForLanguages(neededLanguages);

    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const skippedFiles: IndexSkippedFile[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
        for (const err of result.errors) {
          if (err.code === 'size_exceeded' && err.filePath) {
            skippedFiles.push({
              path: err.filePath,
              reason: 'max_size',
              message: err.message,
            });
          }
        }
      }

      if (result.nodes.length > 0 || (isSourceFile(filePath) && result.errors.length === 0)) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
      skippedFiles,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const resolved = this.resolveIndexedPath(relativePath);

    if (!resolved) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(resolved.fullPath);
      content = await fsp.readFile(resolved.fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    const resolved = this.resolveIndexedPath(relativePath);
    if (!resolved) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Check file size
    const maxFileSizeBytes = this.maxFileSizeBytes();
    if (stats.size > maxFileSizeBytes) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${maxFileSizeBytes})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.frameworkNamesForFile(resolved);
    const result = extractFromSource(relativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      this.refreshCapabilityAnalysis(filePath, content, language, contentHash);
      return; // No changes
    }

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    this.replaceCapabilityAnalysis(filePath, content, language, contentHash);

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  private refreshCapabilityAnalysis(
    filePath: string,
    content: string,
    language: Language,
    contentHash: string
  ): void {
    if (this.queries.capabilityAnalysisRunIsCurrent(
      filePath,
      CONFIG_READ_PRODUCER_ID,
      CONFIG_READ_PRODUCER_VERSION,
      contentHash
    )) {
      return;
    }
    this.replaceCapabilityAnalysis(filePath, content, language, contentHash);
  }

  private replaceCapabilityAnalysis(
    filePath: string,
    content: string,
    language: Language,
    contentHash: string
  ): void {
    const analysis = analyzeConfigReadCapabilities({
      filePath,
      language,
      content,
      sourceHash: contentHash,
      nodes: this.queries.getNodesByFile(filePath),
    });
    this.queries.replaceCapabilityAnalysisForFile(filePath, analysis.run, analysis.assertions);
  }

  /**
   * Sync the index with the current file state.
   *
   * Change detection is filesystem-based, never git: a (size, mtime) stat
   * pre-filter skips unchanged files, then a content-hash compare confirms real
   * changes. This works in non-git projects and catches committed changes from
   * `git pull`/`checkout`/`merge`/`rebase` that `git status` cannot see.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars();
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    // === Filesystem reconcile (git-independent) ===
    // The source of truth for "what changed" is the filesystem vs the indexed
    // state — never git. We enumerate the current source files and reconcile
    // each against the DB. A cheap (size, mtime) stat pre-filter skips unchanged
    // files without reading or hashing them, so the expensive read+hash+parse
    // only runs for files that actually changed. This catches edits/adds/deletes
    // whether or not the project uses git, and crucially also catches committed
    // changes from `git pull`/`checkout`/`merge`/`rebase` — which `git status`
    // cannot see, because the working tree is clean afterward.
    const scannedCurrentFiles = this.scanAll();
    filesChecked = scannedCurrentFiles.length;
    const currentFiles = scannedCurrentFiles.map((file) => file.displayPath);
    const currentByDisplayPath = new Map(scannedCurrentFiles.map((file) => [file.displayPath, file]));
    const currentSet = new Set(currentFiles);

    const trackedFiles = this.queries.getAllFiles();
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    // Removals: tracked in the DB but no longer a present source file. Check the
    // filesystem directly — `scanDirectory` (via `git ls-files`) still lists a
    // file deleted from disk but not yet staged, so set membership alone misses it.
    for (const tracked of trackedFiles) {
      const resolvedTracked = this.resolveIndexedPath(tracked.path);
      if (!currentSet.has(tracked.path) || !resolvedTracked || !fs.existsSync(resolvedTracked.fullPath)) {
        this.queries.deleteFile(tracked.path, { deleteScipFacts: true });
        filesRemoved++;
      }
    }

    // Adds / modifications.
    for (const filePath of currentFiles) {
      const scanned = currentByDisplayPath.get(filePath);
      if (!scanned) continue;
      const fullPath = scanned.fullPath;
      const tracked = trackedMap.get(filePath);

      // Cheap pre-filter: an already-indexed file whose size AND mtime both match
      // the DB is unchanged — skip it without reading or hashing. (A content
      // change that preserves both exactly is the blind spot every mtime-based
      // incremental tool accepts; `index --force` is the escape hatch. Git bumps
      // mtime on every file it writes during checkout/merge, so pulls are caught.)
      if (tracked) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue;
          }
        } catch (error) {
          logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
          continue;
        }
      }

      // New, or size/mtime changed — read + hash to confirm a real content change.
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }
      const contentHash = hashContent(content);

      if (!tracked) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesModified++;
      }
    }

    // Load only grammars needed for changed files
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = this.sourceRoots.length === 1 ? getGitChangedFiles(this.rootDir) : null;

    if (gitChanges) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Deleted files — only report if tracked in DB
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // Modified + added files — read + hash, compare with DB. Untracked (`??`)
      // files stay untracked in git even after indexing, so they must be
      // hash-compared like modified files instead of always counting as added —
      // otherwise status reports them as pending forever. (See issue #206.)
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const scannedCurrentFiles = this.scanAll();
    const currentFiles = new Set(scannedCurrentFiles.map((file) => file.displayPath));
    const currentByDisplayPath = new Map(scannedCurrentFiles.map((file) => [file.displayPath, file]));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const scanned = currentByDisplayPath.get(filePath);
      if (!scanned) continue;
      const fullPath = scanned.fullPath;
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
