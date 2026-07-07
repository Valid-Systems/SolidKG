import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

export const INDEX_PROFILE_SCHEMA_VERSION = 'solidkg.indexProfile.v1';

export interface IndexProfile {
  schemaVersion: typeof INDEX_PROFILE_SCHEMA_VERSION;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  timingsMs: {
    extraction: number;
    scip: number;
    resolution: number;
    maintenance: number;
    total: number;
  };
  counts: {
    filesScanned: number;
    filesIndexed: number;
    filesSkipped: number;
    filesErrored: number;
    nodesCreated: number;
    edgesCreated: number;
    unresolvedReferencesRemaining: number;
    semanticRelations: number;
  };
  resources: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    dbSizeBytes: number;
    walSizeBytes: number;
  };
  dbStatements: {
    byGroup: Record<string, number>;
  };
}

export interface MutableIndexProfile extends IndexProfile {
  readonly markStartedAt: number;
}

export function createIndexProfile(): MutableIndexProfile {
  const startedAtMs = Date.now();
  return {
    schemaVersion: INDEX_PROFILE_SCHEMA_VERSION,
    startedAtMs,
    finishedAtMs: startedAtMs,
    durationMs: 0,
    markStartedAt: performance.now(),
    timingsMs: {
      extraction: 0,
      scip: 0,
      resolution: 0,
      maintenance: 0,
      total: 0,
    },
    counts: {
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      unresolvedReferencesRemaining: 0,
      semanticRelations: 0,
    },
    resources: {
      rssBytes: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      dbSizeBytes: 0,
      walSizeBytes: 0,
    },
    dbStatements: {
      byGroup: {},
    },
  };
}

export function nowMs(): number {
  return performance.now();
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

export function recordResourceStats(profile: MutableIndexProfile, dataDir: string): void {
  const memory = process.memoryUsage();
  const dbPath = path.join(dataDir, 'solidkg.db');
  const walPath = `${dbPath}-wal`;
  profile.resources = {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    dbSizeBytes: fileSizeOrZero(dbPath),
    walSizeBytes: fileSizeOrZero(walPath),
  };
}

function fileSizeOrZero(filePath: string): number {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}
