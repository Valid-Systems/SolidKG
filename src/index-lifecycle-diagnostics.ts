import * as path from 'path';
import { logWarn } from './errors';
import { writeAtomicLifecycleFile } from './index-lifecycle-atomic-file';

const DIAGNOSTIC_FILENAME = 'index-lifecycle.json';
const SCHEMA_VERSION = 'solidkg.indexLifecycleDiagnostic.v1';
const MAX_ACTIVE_RESOURCES = 64;
const MAX_RESOURCE_LENGTH = 256;
const MAX_ERROR_NAME_LENGTH = 256;
const MAX_ERROR_MESSAGE_LENGTH = 4_096;
const MAX_ERROR_STACK_LENGTH = 16_384;
const MAX_ERROR_CAUSE_DEPTH = 8;
const MAX_DETAIL_LENGTH = 256;
const PROGRESS_PERSIST_INTERVAL_MS = 2_000;

export type IndexLifecycleProgress = {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly detail?: string;
  readonly currentFile?: string;
};

export type IndexLifecycleCounts = {
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly filesErrored: number;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
};

type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
};

type LifecycleStatus = 'running' | 'succeeded' | 'failed';

type LifecycleProgress = {
  readonly current: number;
  readonly total: number;
  readonly detail?: string;
};

type LifecycleRecord = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: string;
  readonly status: LifecycleStatus;
  readonly phase: string;
  readonly progress: LifecycleProgress;
  readonly activeResources: readonly string[];
  readonly process: {
    readonly pid: number;
    readonly runtime: 'node';
  };
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly counts?: IndexLifecycleCounts;
  readonly error?: SerializedError;
};

export type IndexLifecycleDiagnosticsOptions = {
  readonly dataDir: string;
  readonly operation: string;
  readonly activeResources?: readonly string[];
};

function boundedText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 3)}...`;
}

function serializeCause(cause: unknown, depth: number): SerializedError {
  if (cause instanceof Error) return serializeError(cause, depth);
  return {
    name: typeof cause,
    message: boundedText(String(cause), MAX_ERROR_MESSAGE_LENGTH),
  };
}

function serializeError(error: Error, depth = 0): SerializedError {
  const serialized: SerializedError = {
    name: boundedText(error.name, MAX_ERROR_NAME_LENGTH),
    message: boundedText(error.message, MAX_ERROR_MESSAGE_LENGTH),
    ...(error.stack ? { stack: boundedText(error.stack, MAX_ERROR_STACK_LENGTH) } : {}),
  };

  if (depth >= MAX_ERROR_CAUSE_DEPTH || error.cause === undefined) {
    return serialized;
  }

  return { ...serialized, cause: serializeCause(error.cause, depth + 1) };
}

function activeResources(): readonly string[] {
  return process.getActiveResourcesInfo()
    .slice(0, MAX_ACTIVE_RESOURCES)
    .map((resource) => boundedText(resource, MAX_RESOURCE_LENGTH));
}

function lifecycleProgress(progress: IndexLifecycleProgress): LifecycleProgress {
  const detail = progress.detail ?? progress.currentFile;
  return { current: progress.current, total: progress.total, ...(detail === undefined ? {} : { detail: boundedText(detail, MAX_DETAIL_LENGTH) }) };
}

function persistenceErrorLabel(error: unknown): string {
  if (error instanceof Error) {
    if ('code' in error && typeof error.code === 'string') {
      return boundedText(error.code, MAX_ERROR_NAME_LENGTH);
    }
    return boundedText(error.name, MAX_ERROR_NAME_LENGTH);
  }
  return boundedText(typeof error, MAX_ERROR_NAME_LENGTH);
}

export class IndexLifecycleDiagnostics {
  private record: LifecycleRecord | undefined;
  private lastPersistedAt: number | undefined;

  public constructor(private readonly options: IndexLifecycleDiagnosticsOptions) {}

  public start(progress: IndexLifecycleProgress): void {
    const now = new Date().toISOString();
    this.record = {
      schemaVersion: SCHEMA_VERSION,
      operation: this.options.operation,
      status: 'running',
      phase: progress.phase,
      progress: lifecycleProgress(progress),
      activeResources: this.options.activeResources ?? activeResources(),
      process: { pid: process.pid, runtime: 'node' },
      startedAt: now,
      updatedAt: now,
    };
    this.persist();
  }

  public updateProgress(progress: Omit<IndexLifecycleProgress, 'phase'>): void {
    if (!this.record) return;
    this.transition({ ...progress, phase: this.record.phase });
  }

  public transition(progress: IndexLifecycleProgress): void {
    if (!this.record) {
      this.start(progress);
      return;
    }
    const nextProgress = lifecycleProgress(progress);
    if (
      this.record.phase === progress.phase &&
      this.record.progress.current === nextProgress.current &&
      this.record.progress.total === nextProgress.total &&
      this.record.progress.detail === nextProgress.detail
    ) {
      return;
    }

    const phaseChanged = this.record.phase !== progress.phase;
    const detailChanged = this.record.progress.detail !== nextProgress.detail;
    const isComplete = nextProgress.current === nextProgress.total;

    this.record = {
      ...this.record,
      phase: progress.phase,
      progress: nextProgress,
      updatedAt: new Date().toISOString(),
    };
    if (phaseChanged || detailChanged || isComplete || this.countPersistIntervalElapsed()) {
      this.persist();
    }
  }

  public succeed(counts: IndexLifecycleCounts): void {
    this.finish({ counts });
  }

  public fail(error: Error): void {
    this.finish({ error: serializeError(error) });
  }

  private finish(result: { readonly counts: IndexLifecycleCounts } | { readonly error: SerializedError }): void {
    if (!this.record) return;

    const completedAt = new Date().toISOString();
    this.record = {
      ...this.record,
      status: 'counts' in result ? 'succeeded' : 'failed',
      updatedAt: completedAt,
      completedAt,
      ...result,
    };
    this.persist();
  }

  private persist(): void {
    if (!this.record) return;

    const diagnosticPath = path.join(this.options.dataDir, DIAGNOSTIC_FILENAME);
    try {
      writeAtomicLifecycleFile(
        diagnosticPath,
        `${JSON.stringify(this.record, null, 2)}\n`,
      );
      this.lastPersistedAt = Date.now();
    } catch (error) {
      this.warnPersistenceFailure(diagnosticPath, error);
    }
  }

  private countPersistIntervalElapsed(): boolean {
    return this.lastPersistedAt === undefined
      || Date.now() - this.lastPersistedAt >= PROGRESS_PERSIST_INTERVAL_MS;
  }

  private warnPersistenceFailure(diagnosticPath: string, error: unknown): void {
    try {
      logWarn('Failed to persist index lifecycle diagnostic', {
        diagnosticPath: boundedText(diagnosticPath, MAX_RESOURCE_LENGTH),
        error: persistenceErrorLabel(error),
      });
    } catch {
      try {
        process.stderr.write('Warning: failed to persist index lifecycle diagnostic\n');
      } catch (stderrError) {
        if (stderrError instanceof Error) return;
      }
    }
  }
}
