import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogger, setLogger, type Logger } from '../src/errors';
import { writeAtomicLifecycleFile } from '../src/index-lifecycle-atomic-file';
import { IndexLifecycleDiagnostics } from '../src/index-lifecycle-diagnostics';

const randomBytes = vi.hoisted(() => vi.fn());
const renameSync = vi.hoisted(() => vi.fn());
const nativeRenameSync = vi.hoisted(() => vi.fn());
const atomicsWait = vi.hoisted(() => vi.fn(() => 'timed-out' as const));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  nativeRenameSync.mockImplementation(actual.renameSync);
  renameSync.mockImplementation(nativeRenameSync);
  return { ...actual, renameSync };
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  randomBytes.mockImplementation(actual.randomBytes);
  return { ...actual, randomBytes };
});

const DIAGNOSTIC_FILENAME = 'index-lifecycle.json';
const tempDirs: string[] = [];

beforeEach(() => {
  vi.spyOn(Atomics, 'wait').mockImplementation(atomicsWait);
});

function createTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new TypeError('Expected a JSON object');
}

function readDiagnostic(dataDir: string): Record<string, unknown> {
  const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
  return requireRecord(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')));
}

function reportCaughtFailure(
  diagnostics: IndexLifecycleDiagnostics,
  indexingError: Error,
): never {
  try {
    throw indexingError;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    diagnostics.fail(error);
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  randomBytes.mockClear();
  renameSync.mockReset();
  renameSync.mockImplementation(nativeRenameSync);
  atomicsWait.mockClear();
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('index lifecycle diagnostics', () => {
  it('writes a versioned atomic start diagnostic to the resolved external data directory', () => {
    // Given
    const projectDir = createTempDir('solidkg-index-lifecycle-project-');
    const dataDir = createTempDir('solidkg-index-lifecycle-data-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['parse-worker-1', 'solidkg.db'],
    });

    // When
    diagnostics.start({ phase: 'scanning', current: 0, total: 3 });

    // Then
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    expect(fs.existsSync(diagnosticPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.solidkg', DIAGNOSTIC_FILENAME))).toBe(false);
    expect(fs.readdirSync(dataDir).filter((entry) => entry.startsWith('index-lifecycle.'))).toEqual([
      DIAGNOSTIC_FILENAME,
    ]);

    const diagnostic = readDiagnostic(dataDir);
    expect(diagnostic).toMatchObject({
      schemaVersion: 'solidkg.indexLifecycleDiagnostic.v1',
      operation: 'indexAll',
      status: 'running',
      phase: 'scanning',
      progress: { current: 0, total: 3 },
      activeResources: ['parse-worker-1', 'solidkg.db'],
      process: { pid: process.pid, runtime: 'node' },
    });
    expect(typeof diagnostic['startedAt']).toBe('string');
    expect(typeof diagnostic['process']).toBe('object');
  });

  it('persists an in-phase completion immediately', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-progress-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['parse-worker-1'],
    });
    diagnostics.start({ phase: 'scanning', current: 0, total: 3 });
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const preservedTime = new Date(1_000);
    fs.utimesSync(diagnosticPath, preservedTime, preservedTime);

    // When
    diagnostics.updateProgress({ current: 3, total: 3 });

    // Then
    expect(fs.statSync(diagnosticPath).mtimeMs).toBeGreaterThan(preservedTime.getTime());
    expect(readDiagnostic(dataDir)).toMatchObject({
      phase: 'scanning',
      progress: { current: 3, total: 3 },
    });
  });

  it('throttles count-only progress but persists phase, detail, completion, and terminal state changes', () => {
    // Given: a fake clock and diagnostics whose progress updates share one active phase.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    const dataDir = createTempDir('solidkg-index-lifecycle-throttle-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    diagnostics.start({ phase: 'scanning', current: 0, total: 3 });
    const initialContents = fs.readFileSync(path.join(dataDir, DIAGNOSTIC_FILENAME), 'utf8');

    // When: a same-phase count update arrives before the persistence interval.
    vi.advanceTimersByTime(1_999);
    diagnostics.updateProgress({ current: 1, total: 3 });

    // Then: the durable record stays unchanged while the in-memory record advances.
    expect(fs.readFileSync(path.join(dataDir, DIAGNOSTIC_FILENAME), 'utf8')).toBe(initialContents);

    // When: the next same-phase count update reaches the interval.
    vi.advanceTimersByTime(1);
    diagnostics.updateProgress({ current: 2, total: 3 });

    // Then: the latest count is persisted.
    expect(readDiagnostic(dataDir)).toMatchObject({
      phase: 'scanning',
      progress: { current: 2, total: 3 },
    });

    // When: phase, detail, and completion updates arrive before another interval.
    diagnostics.transition({ phase: 'storing', current: 0, total: 3 });
    diagnostics.transition({ phase: 'storing', detail: 'source_chunks', current: 1, total: 3 });
    diagnostics.updateProgress({ detail: 'source_chunks', current: 3, total: 3 });

    // Then: each semantic state change is durable immediately.
    expect(readDiagnostic(dataDir)).toMatchObject({
      phase: 'storing',
      progress: { current: 3, total: 3, detail: 'source_chunks' },
    });

    // When: a throttled increment is followed by successful completion.
    diagnostics.transition({ phase: 'storing', detail: 'source_chunks', current: 1, total: 4 });
    diagnostics.succeed({
      filesScanned: 4,
      filesIndexed: 4,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 8,
      edgesCreated: 4,
    });

    // Then: terminal records always include the latest in-memory progress.
    expect(readDiagnostic(dataDir)).toMatchObject({
      status: 'succeeded',
      progress: { current: 1, total: 4, detail: 'source_chunks' },
    });

    // Given: a separate failing run with a throttled progress increment.
    const failedDataDir = createTempDir('solidkg-index-lifecycle-failed-throttle-');
    const failedDiagnostics = new IndexLifecycleDiagnostics({
      dataDir: failedDataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    failedDiagnostics.start({ phase: 'scanning', current: 0, total: 2 });
    failedDiagnostics.updateProgress({ current: 1, total: 2 });

    // When: the run fails before its count update reaches the interval.
    failedDiagnostics.fail(new Error('fixture failure'));

    // Then: the failure record persists the latest in-memory count.
    expect(readDiagnostic(failedDataDir)).toMatchObject({
      status: 'failed',
      progress: { current: 1, total: 2 },
    });
  });

  it('retries a randomized exclusive temporary path without touching the collision file', () => {
    // Given: the first deterministic random path is occupied by unrelated content.
    const dataDir = createTempDir('solidkg-index-lifecycle-collision-');
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const firstRandomBytes = Buffer.alloc(16, 0x11);
    const secondRandomBytes = Buffer.alloc(16, 0x22);
    const collisionPath = `${diagnosticPath}.${firstRandomBytes.toString('hex')}.tmp`;
    fs.writeFileSync(collisionPath, 'preserve collision content', 'utf8');
    randomBytes
      .mockReturnValueOnce(firstRandomBytes)
      .mockReturnValueOnce(secondRandomBytes);

    // When: the atomic writer encounters EEXIST on its first wx create.
    writeAtomicLifecycleFile(diagnosticPath, 'replacement diagnostic\n');

    // Then: it preserves the collision and publishes through the next random path.
    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(collisionPath, 'utf8')).toBe('preserve collision content');
    expect(fs.readFileSync(diagnosticPath, 'utf8')).toBe('replacement diagnostic\n');
    expect(fs.existsSync(`${diagnosticPath}.${secondRandomBytes.toString('hex')}.tmp`)).toBe(false);
  });

  it('retries a transient Windows rename failure with the same owned temporary file', () => {
    // Given: the atomic writer owns one temporary file and its first publish attempt gets EPERM.
    const dataDir = createTempDir('solidkg-index-lifecycle-rename-retry-');
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const temporaryBytes = Buffer.alloc(16, 0x33);
    randomBytes.mockReturnValue(temporaryBytes);
    const renameError = Object.assign(new Error('rename is temporarily blocked'), { code: 'EPERM' });
    renameSync
      .mockImplementationOnce(() => {
        throw renameError;
      })
      .mockImplementation(nativeRenameSync);

    // When: lifecycle persistence publishes the diagnostic.
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    diagnostics.start({ phase: 'scanning', current: 1, total: 2 });

    // Then: it retries the exact owned temp path, publishes the final record, and leaves no temp.
    const temporaryPath = `${diagnosticPath}.${temporaryBytes.toString('hex')}.tmp`;
    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(renameSync.mock.calls.map(([source, destination]) => [source, destination])).toEqual([
      [temporaryPath, diagnosticPath],
      [temporaryPath, diagnosticPath],
    ]);
    expect(readDiagnostic(dataDir)).toMatchObject({
      status: 'running',
      phase: 'scanning',
      progress: { current: 1, total: 2 },
    });
    expect(fs.existsSync(temporaryPath)).toBe(false);
  });

  it('bounds persistent Windows rename retries and removes the owned temporary file', () => {
    // Given: every publish attempt receives a persistent EPERM.
    const dataDir = createTempDir('solidkg-index-lifecycle-rename-failure-');
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const temporaryBytes = Buffer.alloc(16, 0x44);
    randomBytes.mockReturnValue(temporaryBytes);
    const renameError = Object.assign(new Error('rename remains blocked'), { code: 'EPERM' });
    renameSync.mockImplementation(() => {
      throw renameError;
    });

    // When: atomic persistence is attempted.
    const temporaryPath = `${diagnosticPath}.${temporaryBytes.toString('hex')}.tmp`;
    expect(() => writeAtomicLifecycleFile(diagnosticPath, 'blocked diagnostic\n')).toThrow(renameError);

    // Then: retries are bounded, the owned temp is cleaned, and no destination is published.
    expect(renameSync).toHaveBeenCalledTimes(8);
    expect(atomicsWait.mock.calls.map((call) => call[3])).toEqual([25, 50, 100, 150, 150, 150, 150]);
    expect(renameSync.mock.calls.every(([source, destination]) => source === temporaryPath && destination === diagnosticPath)).toBe(true);
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(fs.existsSync(diagnosticPath)).toBe(false);
  });

  it.each(['EACCES', 'EBUSY'] as const)('retries transient %s rename failures', (code) => {
    const dataDir = createTempDir(`solidkg-index-lifecycle-${code.toLowerCase()}-`);
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    renameSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('transient rename failure'), { code });
      })
      .mockImplementation(nativeRenameSync);

    writeAtomicLifecycleFile(diagnosticPath, 'diagnostic\n');

    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(atomicsWait.mock.calls.map((call) => call[3])).toEqual([25]);
    expect(fs.readFileSync(diagnosticPath, 'utf8')).toBe('diagnostic\n');
  });

  it('does not retry a non-transient rename failure', () => {
    const dataDir = createTempDir('solidkg-index-lifecycle-non-transient-');
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const renameError = Object.assign(new Error('invalid destination'), { code: 'EINVAL' });
    renameSync.mockImplementation(() => {
      throw renameError;
    });

    expect(() => writeAtomicLifecycleFile(diagnosticPath, 'diagnostic\n')).toThrow(renameError);

    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(atomicsWait).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')(
    'does not follow a pre-created predictable temporary-file symlink',
    () => {
      // Given
      const dataDir = createTempDir('solidkg-index-lifecycle-symlink-');
      const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
      const collisionPath = `${diagnosticPath}.${process.pid}.tmp`;
      const protectedPath = path.join(dataDir, 'protected.txt');
      const protectedBytes = 'do not overwrite this file';
      fs.writeFileSync(protectedPath, protectedBytes, 'utf8');
      fs.symlinkSync(protectedPath, collisionPath);
      const diagnostics = new IndexLifecycleDiagnostics({
        dataDir,
        operation: 'indexAll',
      });

      // When
      diagnostics.start({ phase: 'scanning', current: 0, total: 1 });

      // Then
      expect(fs.readFileSync(protectedPath, 'utf8')).toBe(protectedBytes);
      expect(fs.lstatSync(collisionPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(diagnosticPath)).toBe(true);
      expect(
        fs.readdirSync(dataDir).filter(
          (entry) =>
            entry.startsWith(`${DIAGNOSTIC_FILENAME}.`) &&
            entry.endsWith('.tmp') &&
            entry !== path.basename(collisionPath),
        ),
      ).toEqual([]);
    },
  );

  it.runIf(process.platform !== 'win32')('writes diagnostics with owner-only permissions', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-mode-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
    });
    const originalUmask = process.umask(0);

    // When
    try {
      diagnostics.start({ phase: 'scanning', current: 0, total: 1 });
    } finally {
      process.umask(originalUmask);
    }

    // Then
    const mode = fs.statSync(path.join(dataDir, DIAGNOSTIC_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes a diagnostic when the indexing phase changes', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-phase-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['parse-worker-1'],
    });
    diagnostics.start({ phase: 'scanning', current: 0, total: 3 });
    const diagnosticPath = path.join(dataDir, DIAGNOSTIC_FILENAME);
    const preservedTime = new Date(1_000);
    fs.utimesSync(diagnosticPath, preservedTime, preservedTime);

    // When
    diagnostics.transition({ phase: 'parsing', current: 0, total: 3 });

    // Then
    expect(fs.statSync(diagnosticPath).mtimeMs).toBeGreaterThan(preservedTime.getTime());
    expect(readDiagnostic(dataDir)).toMatchObject({
      phase: 'parsing',
      progress: { current: 0, total: 3 },
    });
  });

  it('persists successful completion with the final indexing counts', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-success-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    diagnostics.start({ phase: 'scanning', current: 0, total: 2 });
    diagnostics.transition({ phase: 'synthesis', current: 2, total: 2 });

    // When
    diagnostics.succeed({
      filesScanned: 2,
      filesIndexed: 2,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 4,
      edgesCreated: 3,
    });

    // Then
    expect(readDiagnostic(dataDir)).toMatchObject({
      status: 'succeeded',
      phase: 'synthesis',
      progress: { current: 2, total: 2 },
      counts: {
        filesScanned: 2,
        filesIndexed: 2,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 4,
        edgesCreated: 3,
      },
    });
  });

  it('records a caught failure with error cause and stack details', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-failure-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['parse-worker-1', 'solidkg.db'],
    });
    diagnostics.start({ phase: 'resolving', current: 1, total: 2 });
    const cause = new Error('database unavailable');
    const indexingError = new Error('indexing failed', { cause });

    // When
    expect(() => reportCaughtFailure(diagnostics, indexingError)).toThrow(indexingError);

    // Then
    expect(readDiagnostic(dataDir)).toMatchObject({
      status: 'failed',
      phase: 'resolving',
      activeResources: ['parse-worker-1', 'solidkg.db'],
      error: {
        name: 'Error',
        message: 'indexing failed',
        cause: { name: 'Error', message: 'database unavailable' },
      },
    });
    const error = requireRecord(readDiagnostic(dataDir)['error']);
    expect(typeof error['stack']).toBe('string');
  });

  it('warns with persistence context without throwing when diagnostic writing fails', () => {
    // Given
    const dataDir = createTempDir('solidkg-index-lifecycle-write-failure-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    diagnostics.start({ phase: 'resolving', current: 1, total: 2 });
    const indexingError = new Error('indexing failed');
    const warnings: Array<{
      readonly message: string;
      readonly context: Record<string, unknown> | undefined;
    }> = [];
    const warningLogger: Logger = {
      debug(): void {},
      warn(message, context): void {
        warnings.push({ message, context });
      },
      error(): void {},
    };
    const originalLogger = getLogger();

    fs.rmSync(path.join(dataDir, DIAGNOSTIC_FILENAME));
    fs.mkdirSync(path.join(dataDir, DIAGNOSTIC_FILENAME));

    // When
    setLogger(warningLogger);
    try {
      expect(() => diagnostics.fail(indexingError)).not.toThrow();
    } finally {
      setLogger(originalLogger);
    }

    // Then
    expect(warnings).toEqual([
      {
        message: 'Failed to persist index lifecycle diagnostic',
        context: {
          diagnosticPath: path.join(dataDir, DIAGNOSTIC_FILENAME),
          error: expect.any(String),
        },
      },
    ]);
    expect(fs.statSync(path.join(dataDir, DIAGNOSTIC_FILENAME)).isDirectory()).toBe(true);
  });

  it('falls back to bounded stderr output when diagnostic persistence and configured logging both fail', () => {
    // Given: diagnostic persistence is blocked and the configured warning logger throws.
    const dataDir = createTempDir('solidkg-index-lifecycle-logger-failure-');
    const diagnostics = new IndexLifecycleDiagnostics({
      dataDir,
      operation: 'indexAll',
      activeResources: ['solidkg.db'],
    });
    diagnostics.start({ phase: 'resolving', current: 1, total: 2 });
    fs.rmSync(path.join(dataDir, DIAGNOSTIC_FILENAME));
    fs.mkdirSync(path.join(dataDir, DIAGNOSTIC_FILENAME));
    const originalLogger = getLogger();
    const throwingLogger: Logger = {
      debug(): void {},
      warn(): void { throw new Error('logger implementation failure'); },
      error(): void {},
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // When: terminal failure attempts to persist its latest lifecycle state.
    setLogger(throwingLogger);
    try {
      expect(() => diagnostics.fail(new Error('indexing failed'))).not.toThrow();
    } finally {
      setLogger(originalLogger);
    }

    // Then: stderr receives one bounded operational warning without error details.
    expect(stderr).toHaveBeenCalledWith('Warning: failed to persist index lifecycle diagnostic\n');
    expect(stderr.mock.calls.flat().join('')).not.toContain('logger implementation failure');
    expect(stderr.mock.calls.flat().join('')).not.toContain('indexing failed');
  });
});
