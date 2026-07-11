#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReferenceQualityReport, compareReports, isReferenceQualityReport, renderMarkdown, serializeReport } from './reference-quality/report.mjs';
import { TRUSTED_GIT_EXECUTABLE } from './reference-quality/sqlite-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..', '..');
const workerPath = join(here, 'reference-quality', 'worker.mjs');
const READ_ONLY_PROBE_TOOLS = new Set([
  'solidkg_search', 'solidkg_context', 'solidkg_explore', 'solidkg_trace', 'solidkg_node',
  'solidkg_callers', 'solidkg_callees', 'solidkg_impact', 'solidkg_files', 'solidkg_status', 'solidkg_precise_refs',
]);
const EVIDENCE_RELEVANCE = new Set(['required', 'useful', 'misleading']);
const QUERY_VARIANTS = new Set(['long', 'terse', 'counterfactual']);

function portableRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || posix.isAbsolute(value) || win32.isAbsolute(value)) return null;
  const normalized = posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function help() {
  return `SolidKG diagnostic reference-quality sweep

Usage:
  node scripts/agent-eval/reference-quality-sweep.mjs --root <path> --out <directory> [options]
  node scripts/agent-eval/reference-quality-sweep.mjs --from-results <report.json> --baseline <report.json> --out <directory>

Options:
  --root <path>                    Parent containing pre-indexed repositories
  --out <directory>               Output directory
  --min-repos <number>             Fail before scanning if fewer indexes are present
  --probe-manifest <file.json>     Optional curated ToolHandler probe manifest
  --probe-repeats <number>         Measured repeats after one warm-up (default: 5)
  --scan-timeout-ms <number>       Per-repository hard deadline (default: 120000)
  --probe-timeout-ms <number>      Per-probe hard deadline (default: 120000)
  --baseline <report.json>         Diagnostic comparison baseline
  --from-results <report.json>     Compare an existing report without scanning
  --generated-at <ISO timestamp>   Fixed timestamp for deterministic reproduction
  --help                           Show this help

Outputs are diagnostic evidence, not claim-grade current-build quality proof.
`;
}

function parseArgs(argv) {
  const args = { minRepos: 0, probeRepeats: 5, scanTimeoutMs: 120_000, probeTimeoutMs: 120_000 };
  const valueAt = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${option}`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--root') args.root = valueAt(index++, arg);
    else if (arg === '--out') args.out = valueAt(index++, arg);
    else if (arg === '--min-repos') args.minRepos = Number(valueAt(index++, arg));
    else if (arg === '--probe-manifest') args.probeManifest = valueAt(index++, arg);
    else if (arg === '--probe-repeats') args.probeRepeats = Number(valueAt(index++, arg));
    else if (arg === '--scan-timeout-ms') args.scanTimeoutMs = Number(valueAt(index++, arg));
    else if (arg === '--probe-timeout-ms') args.probeTimeoutMs = Number(valueAt(index++, arg));
    else if (arg === '--baseline') args.baseline = valueAt(index++, arg);
    else if (arg === '--from-results') args.fromResults = valueAt(index++, arg);
    else if (arg === '--generated-at') args.generatedAt = valueAt(index++, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [option, value, minimum] of [
    ['--min-repos', args.minRepos, 0],
    ['--probe-repeats', args.probeRepeats, 1],
    ['--scan-timeout-ms', args.scanTimeoutMs, 1],
    ['--probe-timeout-ms', args.probeTimeoutMs, 1],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${option}: expected an integer >= ${minimum}`);
  }
  if (args.generatedAt && Number.isNaN(Date.parse(args.generatedAt))) throw new Error('invalid --generated-at: expected an ISO timestamp');
  return args;
}

function sha256Files(paths) {
  const hash = createHash('sha256');
  for (const filePath of [...paths].sort()) {
    hash.update(relative(engineRoot, filePath).replace(/\\/g, '/'));
    hash.update(readFileSync(filePath));
  }
  return hash.digest('hex');
}

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? collectJavaScriptFiles(entryPath) : entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function trustedGit(args) {
  if (!TRUSTED_GIT_EXECUTABLE) return null;
  const result = spawnSync(TRUSTED_GIT_EXECUTABLE, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
    cwd: engineRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runWorker(mode, input, timeout) {
  const tempRoot = mkdtempSync(join(tmpdir(), `solidkg-reference-${mode}-`));
  try {
    const result = spawnSync(process.execPath, [workerPath, mode], {
      cwd: engineRoot,
      input: JSON.stringify({ ...input, tempRoot }),
      encoding: 'utf8',
      timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.error?.code === 'ETIMEDOUT') return { repoId: input.repoId ?? input.probe?.repoId, probeId: input.probe?.id, status: 'timeout', cleanup: { owner: 'parent', cleaned: true } };
    if (result.status !== 0) return { repoId: input.repoId ?? input.probe?.repoId, probeId: input.probe?.id, status: 'worker_error', error: String(result.stderr ?? '').trim(), cleanup: { owner: 'parent', cleaned: true } };
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { repoId: input.repoId ?? input.probe?.repoId, probeId: input.probe?.id, status: 'worker_error', error: 'worker returned invalid JSON', cleanup: { owner: 'parent', cleaned: true } };
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateProbeManifest(manifest) {
  if (manifest?.schemaName !== 'solidkg.reference-quality.probes.v1' || !Array.isArray(manifest.probes) || manifest.probes.length > 100) throw new Error('invalid probe manifest');
  for (const probe of manifest.probes) {
    if (!probe || typeof probe.id !== 'string' || typeof probe.repoId !== 'string' || !READ_ONLY_PROBE_TOOLS.has(probe.tool) || !probe.arguments || typeof probe.arguments !== 'object') throw new Error('invalid probe manifest');
    if ('projectPath' in probe.arguments || 'dataDir' in probe.arguments) throw new Error('invalid probe manifest: projectPath and dataDir are forbidden');
    if (!Array.isArray(probe.expectedFiles) || probe.expectedFiles.length > 50 || probe.expectedFiles.some((file) => portableRelativePath(file) === null)) throw new Error('invalid probe manifest: expectedFiles must be repository-relative');
    if (!Array.isArray(probe.expectations) || probe.expectations.length > 50) throw new Error('invalid probe manifest');
    if (probe.familyId !== undefined && (typeof probe.familyId !== 'string' || probe.familyId.length === 0)) throw new Error('invalid probe manifest: familyId must be a non-empty string');
    if (probe.queryVariant !== undefined && !QUERY_VARIANTS.has(probe.queryVariant)) throw new Error('invalid probe manifest: queryVariant must be long, terse, or counterfactual');
    if (probe.evidenceJudgments !== undefined) {
      if (!Array.isArray(probe.evidenceJudgments) || probe.evidenceJudgments.length > 100) throw new Error('invalid probe manifest: evidenceJudgments must be a bounded array');
      const files = new Set();
      for (const judgment of probe.evidenceJudgments) {
        const normalizedFile = portableRelativePath(judgment?.file);
        if (!judgment || normalizedFile === null || !EVIDENCE_RELEVANCE.has(judgment.relevance)) throw new Error('invalid probe manifest: evidenceJudgments must use portable files and known relevance');
        if (files.has(normalizedFile)) throw new Error('invalid probe manifest: evidenceJudgments files must be unique');
        files.add(normalizedFile);
      }
    }
  }
}

function discoverIndexes(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ repoId: entry.name, repoPath: join(root, entry.name), dbPath: join(root, entry.name, '.solidkg', 'solidkg.db') }))
    .filter((entry) => existsSync(entry.dbPath))
    .sort((left, right) => left.repoId.localeCompare(right.repoId));
}

function writeReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'reference-quality-baseline.json');
  const markdown = join(outDir, 'reference-quality-baseline.md');
  writeFileSync(json, serializeReport(report));
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}

function compareExisting(args) {
  if (!args.fromResults || !existsSync(args.fromResults)) throw new Error(`results file not found: ${args.fromResults ?? ''}`);
  if (!args.baseline || !existsSync(args.baseline)) throw new Error(`baseline file not found: ${args.baseline ?? ''}`);
  const current = JSON.parse(readFileSync(args.fromResults, 'utf8'));
  const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
  if (!isReferenceQualityReport(current) || !isReferenceQualityReport(baseline)) throw new Error('invalid reference-quality report');
  const comparison = compareReports(baseline, current);
  const outDir = resolve(args.out ?? join(engineRoot, '.omo', 'evidence', 'reference-quality-comparison'));
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'reference-quality-comparison.json');
  writeFileSync(json, `${JSON.stringify(comparison, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, comparison: comparison.status, artifacts: { json } }, null, 2)}\n`);
}

function runSweep(args) {
  const sweepStarted = performance.now();
  if (!args.root || !existsSync(args.root)) throw new Error(`root not found: ${args.root ?? ''}`);
  const root = resolve(args.root);
  const indexes = discoverIndexes(root);
  if (indexes.length < args.minRepos) throw new Error(`minimum repository count not met: found ${indexes.length}, required ${args.minRepos}`);
  const repos = indexes.map((entry) => runWorker('scan', entry, args.scanTimeoutMs));
  const probes = [];
  let manifestPath = null;
  let manifestHash = null;
  if (args.probeManifest) {
    manifestPath = resolve(args.probeManifest);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    validateProbeManifest(manifest);
    manifestHash = sha256Files([manifestPath]);
    const byId = new Map(indexes.map((entry) => [entry.repoId, entry]));
    for (const probe of manifest.probes ?? []) {
      const entry = byId.get(probe.repoId);
      if (!entry) {
        probes.push({ repoId: probe.repoId, probeId: probe.id, status: 'missing_repo' });
        continue;
      }
      probes.push(runWorker('probe', { engineRoot, repoPath: entry.repoPath, probe, repeatCount: args.probeRepeats }, args.probeTimeoutMs));
    }
  }
  const packageJson = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));
  const implementationFiles = [
    join(here, 'reference-quality-sweep.mjs'),
    join(here, 'reference-quality', 'policy.mjs'),
    join(here, 'reference-quality', 'sqlite-metrics.mjs'),
    join(here, 'reference-quality', 'probe-runner.mjs'),
    join(here, 'reference-quality', 'report.mjs'),
    join(here, 'reference-quality', 'worker.mjs'),
  ];
  const probeParserPath = join(here, 'reference-quality', 'probe-runner.mjs');
  const distRoot = join(engineRoot, 'dist');
  if (!existsSync(distRoot)) throw new Error('built runtime not found: run pnpm run build');
  const runtimeFiles = collectJavaScriptFiles(distRoot);
  const gitRevision = trustedGit(['rev-parse', 'HEAD']);
  const gitDirty = trustedGit(['status', '--porcelain']);
  const report = buildReferenceQualityReport({
    repos,
    probes,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    provenance: {
      solidkgVersion: packageJson.version,
      implementationHash: sha256Files(implementationFiles),
      probeManifestHash: manifestHash,
      probeParserHash: sha256Files([probeParserPath]),
      runtimeHash: sha256Files(runtimeFiles),
      benchmarkRevision: gitRevision,
      benchmarkDirty: gitDirty === null ? null : gitDirty !== '',
      host: `${platform()}-${arch()}-node-${process.version}`,
      corpusId: basename(root),
      indexCount: indexes.length,
      totalElapsedMs: Math.round(performance.now() - sweepStarted),
    },
  });
  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
    if (!isReferenceQualityReport(baseline)) throw new Error('invalid reference-quality report');
    report.comparison = compareReports(baseline, report);
  }
  const outDir = resolve(args.out ?? join(engineRoot, '.omo', 'evidence', 'reference-quality'));
  const artifacts = writeReport(report, outDir);
  process.stdout.write(`${JSON.stringify({ ok: true, statusDistribution: report.aggregate.statusDistribution, artifacts }, null, 2)}\n`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(help());
  } else if (args.fromResults) {
    compareExisting(args);
  } else {
    runSweep(args);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
