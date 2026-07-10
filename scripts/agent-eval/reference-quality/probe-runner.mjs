import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const INDEX_ARTIFACTS = new Set(['solidkg.db', 'solidkg.db-wal', 'solidkg.db-shm', '.solidkg-owned', '.gitignore']);
const elapsed = (started) => Number((performance.now() - started).toFixed(3));
const hashBuffer = (value) => createHash('sha256').update(value).digest('hex');
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeProbeRepeats(repeats) {
  const measured = repeats.filter((repeat) => repeat.status === 'measured');
  const durations = measured.map((repeat) => repeat.executeMs);
  const statuses = {};
  for (const repeat of repeats) statuses[repeat.status] = (statuses[repeat.status] ?? 0) + 1;
  const outputHashes = [...new Set(measured.map((repeat) => repeat.outputHash).filter(Boolean))].sort();
  const expectationCounts = measured.map((repeat) => repeat.evidence.expectationResults.length);
  const expectationMissCounts = measured.map((repeat) => repeat.evidence.expectationResults.filter((item) => !item.matched).length);
  return {
    repeatCount: repeats.length,
    latencyMs: {
      p50: median(durations),
      min: durations.length ? Math.min(...durations) : null,
      max: durations.length ? Math.max(...durations) : null,
    },
    payloadBytes: measured.length ? Math.max(...measured.map((repeat) => repeat.payloadBytes)) : 0,
    outputHashes,
    deterministic: measured.length === repeats.length && measured.length > 0 && outputHashes.length === 1,
    statuses,
    expectationCount: expectationCounts.length ? Math.max(...expectationCounts) : 0,
    expectationMissCount: expectationMissCounts.length ? Math.max(...expectationMissCounts) : 0,
  };
}

export function classifyProbeRepeats(repeats) {
  const statuses = new Set(repeats.map((repeat) => repeat.status));
  if (statuses.has('timeout')) return 'timeout';
  if (statuses.has('unavailable')) return 'unavailable';
  if (statuses.has('error') || statuses.has('measured') === false) return 'error';
  const summary = summarizeProbeRepeats(repeats);
  if (!summary.deterministic) return 'nondeterministic';
  if (summary.expectationMissCount > 0) return 'miss';
  return 'measured';
}

export function snapshotIndexArtifacts(indexDir) {
  if (!existsSync(indexDir)) return [];
  return readdirSync(indexDir).filter((name) => name.startsWith('solidkg.db')).sort().map((name) => {
    const filePath = join(indexDir, name);
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`index artifact must be a regular file: ${name}`);
    return { name, size: stat.size, sha256: hashBuffer(readFileSync(filePath)) };
  });
}

export function copyIndexArtifacts(indexDir, requestedTempRoot) {
  const tempRoot = requestedTempRoot ? resolve(requestedTempRoot) : mkdtempSync(join(tmpdir(), 'solidkg-reference-probe-'));
  const copyDir = join(tempRoot, '.solidkg');
  try {
    const sourceStat = lstatSync(indexDir);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('index directory must be a regular directory');
    if (requestedTempRoot) {
      const parentStat = lstatSync(tempRoot);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('parent temp root must be an owned directory');
    }
    mkdirSync(copyDir);
    for (const name of readdirSync(indexDir).filter((entry) => INDEX_ARTIFACTS.has(entry)).sort()) {
      const source = join(indexDir, name); const artifact = lstatSync(source);
      if (!artifact.isFile() || artifact.isSymbolicLink()) throw new Error(`index artifact must be a regular file: ${name}`);
      copyFileSync(source, join(copyDir, name));
    }
    return { tempRoot, copyDir, owner: requestedTempRoot ? 'parent' : 'worker' };
  } catch (error) {
    try {
      rmSync(requestedTempRoot ? copyDir : tempRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to copy and clean probe artifacts: ${errorMessage(error)}`);
    }
    throw error;
  }
}

function sectionText(text, section) {
  if (!section) return text;
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const expectedHeading = section.trim();
  const heading = headings.find((match) => {
    const actualHeading = match[0].trim();
    return actualHeading === expectedHeading || actualHeading.startsWith(`${expectedHeading} `);
  });
  if (!heading) return null;
  const level = heading[1].length;
  const start = heading.index + heading[0].length;
  const next = headings.find((match) => match.index > heading.index && match[1].length <= level);
  return text.slice(start, next?.index ?? text.length);
}

export function parseToolOutput(text, expected) {
  const expectationResults = (expected ?? []).map((item) => {
    const bounded = sectionText(text, item.section);
    return { section: item.section ?? null, includes: item.includes, matched: bounded?.includes(item.includes) ?? false };
  });
  const packetSchema = text.match(/- Schema: ([^\r\n]+)/)?.[1] ?? null;
  const sourceCompleteness = text.match(/Returned source coverage only: ([^\s(]+)/)?.[1]
    ?? text.match(/Source completeness: ([^\s]+)/)?.[1]
    ?? null;
  const rankingBlock = text.match(/- Ranking reasons:\r?\n((?:\s{2}- [^\r\n]+\r?\n?)*)/)?.[1] ?? '';
  const rankingReasons = [...rankingBlock.matchAll(/^\s+- ([^:]+):\s*(.+)$/gm)].map((match) => ({ kind: match[1].trim(), label: match[2].trim() }));
  return {
    packetSchema,
    answerPacketAvailability: packetSchema === null ? 'unavailable' : 'available',
    sufficiency: text.match(/- Binary sufficiency: ([^\s(]+)/)?.[1] ?? null,
    evidenceAnchorCount: (text.match(/^\s+- ev_[^:]+:/gm) ?? []).length,
    sourceCompleteness,
    sourceCompletenessAvailability: sourceCompleteness === null ? 'unavailable' : 'available',
    rankingReasons,
    expectationResults,
  };
}

export function stabilizeCopiedDatabase(copiedDbPath) {
  const db = new DatabaseSync(copiedDbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function inspectCopiedIndex(options, copiedDbPath, runtime) {
  stabilizeCopiedDatabase(copiedDbPath);
  const db = new DatabaseSync(copiedDbPath, { readOnly: true });
  try {
    const schemaRow = db.prepare('SELECT MAX(version) AS version FROM schema_versions').get();
    const revisionRow = db.prepare("SELECT value FROM project_metadata WHERE key = 'solidkg:version'").get();
    const statement = db.prepare('SELECT content_hash, language, errors FROM files WHERE path = ?');
    const files = (options.probe.expectedFiles ?? []).map((relativePath) => {
      const row = statement.get(relativePath);
      const sourcePath = join(options.repoPath, relativePath);
      const sourceHash = existsSync(sourcePath) ? hashBuffer(readFileSync(sourcePath)) : null;
      return {
        path: relativePath,
        indexed: Boolean(row),
        language: row?.language ?? null,
        fresh: Boolean(row && sourceHash === row.content_hash),
        extractionErrors: row?.errors ? JSON.parse(row.errors).length : 0,
      };
    });
    const language = options.probe.expectedLanguage ?? null;
    return {
      schema: { actual: schemaRow?.version ?? null, expected: runtime.schemaVersion, current: schemaRow?.version === runtime.schemaVersion },
      revision: { actual: revisionRow?.value ?? null, expected: runtime.engineVersion, current: revisionRow?.value === runtime.engineVersion },
      parser: { available: language === null || runtime.supportedLanguages.includes(language), language },
      freshness: { fresh: files.every((file) => file.fresh), files },
    };
  } finally {
    db.close();
  }
}

async function loadRuntime(engineRoot) {
  const moduleUrl = (relativePath) => pathToFileURL(resolve(engineRoot, 'dist', relativePath)).href;
  const [indexModule, toolsModule, grammarModule, migrationModule, versionModule] = await Promise.all([
    import(moduleUrl('index.js')),
    import(moduleUrl('mcp/tools.js')),
    import(moduleUrl('extraction/grammars.js')),
    import(moduleUrl('db/migrations.js')),
    import(moduleUrl('version.js')),
  ]);
  return {
    SolidKG: indexModule.default?.default ?? indexModule.default ?? indexModule.SolidKG,
    ToolHandler: toolsModule.ToolHandler ?? toolsModule.default?.ToolHandler,
    supportedLanguages: grammarModule.getSupportedLanguages(),
    schemaVersion: migrationModule.CURRENT_SCHEMA_VERSION,
    engineVersion: versionModule.SOLIDKG_VERSION,
  };
}

function summarizePayload(payload, executeMs, expectations) {
  return {
    status: 'measured',
    executeMs,
    payloadBytes: Buffer.byteLength(payload, 'utf8'),
    outputHash: hashBuffer(payload),
    evidence: parseToolOutput(payload, expectations),
  };
}

export async function runProbeCase(options) {
  const totalStarted = performance.now();
  const sourceIndexDir = join(options.repoPath, '.solidkg');
  const originalBefore = snapshotIndexArtifacts(sourceIndexDir);
  const timingMs = { copy: 0, open: 0, warmup: 0, execute: 0, total: 0 };
  let copied;
  let result;
  const copyStarted = performance.now();
  try {
    copied = copyIndexArtifacts(sourceIndexDir, options.tempRoot);
    timingMs.copy = elapsed(copyStarted);
    const runtime = await loadRuntime(options.engineRoot);
    const preflight = inspectCopiedIndex(options, join(copied.copyDir, 'solidkg.db'), runtime);
    const common = { repoId: options.probe.repoId, probeId: options.probe.id, preflight, repeats: [] };
    if (!preflight.parser.available) {
      result = { ...common, status: 'unavailable', reason: 'parser_unavailable' };
    } else if (!preflight.schema.current || !preflight.revision.current || !preflight.freshness.fresh) {
      result = { ...common, status: 'stale', reason: 'index_preflight_failed' };
    } else {
      const openStarted = performance.now();
      const graph = runtime.SolidKG.openSync(options.repoPath, { dataDir: copied.copyDir, readOnly: true });
      timingMs.open = elapsed(openStarted);
      try {
        const handler = new runtime.ToolHandler(graph);
        const warmupStarted = performance.now();
        await handler.execute(options.probe.tool, options.probe.arguments);
        timingMs.warmup = elapsed(warmupStarted);
        const repeats = [];
        for (let index = 0; index < options.repeatCount; index++) {
          const executeStarted = performance.now();
          try {
            const toolResult = await handler.execute(options.probe.tool, options.probe.arguments);
            const payload = toolResult.content?.find((item) => item.type === 'text')?.text;
            if (typeof payload !== 'string') throw new Error('tool returned no text payload');
            repeats.push(summarizePayload(payload, elapsed(executeStarted), options.probe.expectations));
          } catch (error) {
            repeats.push({ status: 'error', executeMs: elapsed(executeStarted), payloadBytes: 0, outputHash: null, evidence: { expectationResults: [] }, error: errorMessage(error) });
          }
        }
        timingMs.execute = Number(repeats.reduce((sum, repeat) => sum + repeat.executeMs, 0).toFixed(3));
        result = { ...common, status: classifyProbeRepeats(repeats), summary: summarizeProbeRepeats(repeats), repeats };
      } finally {
        graph.close();
      }
    }
  } catch (error) {
    timingMs.copy ||= elapsed(copyStarted);
    result = { repoId: options.probe.repoId, probeId: options.probe.id, status: 'error', reason: 'probe_execution_failed', error: errorMessage(error), repeats: [] };
  }

  let cleanupError = null;
  if (copied) {
    try { rmSync(copied.tempRoot, { recursive: true, force: true }); }
    catch (error) { cleanupError = errorMessage(error); }
  }
  const originalAfter = snapshotIndexArtifacts(sourceIndexDir);
  const originalPreserved = JSON.stringify(originalBefore) === JSON.stringify(originalAfter);
  timingMs.total = elapsed(totalStarted);
  const cleanup = { tempRoot: copied?.tempRoot ?? resolve(options.tempRoot ?? ''), owner: copied?.owner ?? (options.tempRoot ? 'parent' : 'worker'), cleaned: cleanupError === null };
  if (cleanupError || !originalPreserved) {
    return { ...result, status: 'error', reason: cleanupError ? 'cleanup_failed' : 'original_artifacts_changed', cleanup, originalPreserved, timingMs, ...(cleanupError ? { error: cleanupError } : {}) };
  }
  return { ...result, cleanup, originalPreserved, timingMs };
}
