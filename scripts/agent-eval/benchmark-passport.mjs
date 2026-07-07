#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyRawEvidence } from './answer-evidence-contract.mjs';

export const BENCHMARK_PASSPORT_SCHEMA = 'solidkg.llm-answer-quality.benchmark-passport.v1';
export const REQUIRED_REPEAT_COUNT = 4;
export const REQUIRED_BENCHMARK_IMPLEMENTATION_FILES = Object.freeze([
  'opencode-answer-benchmark.mjs',
  'answer-scenarios.mjs',
  'answer-arms.mjs',
  'opencode-runner.mjs',
  'parse-opencode-transcript.mjs',
  'score-answer-quality.mjs',
  'answer-evidence-contract.mjs',
  'report-answer-quality.mjs',
  'benchmark-passport.mjs',
]);
export const STOP_CONDITION_CODES = Object.freeze([
  'missing_benchmark_passport',
  'benchmark_code_hash_missing',
  'benchmark_code_hash_mismatch',
  'scenario_hash_missing',
  'scenario_hash_mismatch',
  'solidkg_binary_mismatch',
  'solidkg_index_unavailable',
  'solidkg_index_stale',
  'benchmark_verification_path_missing',
  'scenario_verification_path_missing',
  'low_repeat_claim_grade_blocked',
  'raw_tool_outputs_unavailable',
]);

export const BENCHMARK_PASSPORT_READINESS_SCHEMA = Object.freeze({
  schemaName: 'solidkg.llm-answer-quality.benchmark-passport-readiness.v1',
  stableFields: ['proofTier', 'claimGrade', 'stopConditions', 'warnings', 'requiredRepeatCount'],
  stopConditionCodes: STOP_CONDITION_CODES,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function moduleDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function implementationRoot(benchmarkScriptPath = null) {
  return hasText(benchmarkScriptPath) ? dirname(resolve(benchmarkScriptPath)) : moduleDir();
}

export function sha256File(filePath) {
  if (!hasText(filePath) || !existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function safeStat(filePath) {
  try { return statSync(filePath); } catch { return null; }
}

function isExcluded(current, excluded) {
  return excluded.some((prefix) => current === prefix || current.startsWith(`${prefix}\\`) || current.startsWith(`${prefix}/`));
}

function walkLatest(root, { exclude = [] } = {}) {
  if (!hasText(root) || !existsSync(root)) return { fileCount: 0, latestMtimeMs: null };
  let fileCount = 0;
  let latestMtimeMs = 0;
  const excluded = exclude.filter(hasText).map((value) => resolve(value));
  const stack = [resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (isExcluded(current, excluded)) continue;
    const stat = safeStat(current);
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(resolve(current, entry));
      continue;
    }
    fileCount += 1;
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
  }
  return { fileCount, latestMtimeMs: fileCount > 0 ? latestMtimeMs : null };
}

export function collectIndexMetadata({ repoId, repoPath, dataDir, setupStartedAt = null, setupEndedAt = null } = {}) {
  const index = walkLatest(dataDir);
  const repo = walkLatest(repoPath, { exclude: [dataDir] });
  const available = index.fileCount > 0;
  const stale = available && repo.latestMtimeMs !== null && index.latestMtimeMs !== null && index.latestMtimeMs + 1000 < repo.latestMtimeMs;
  return {
    repoId: repoId ?? null,
    repoPath: repoPath ?? null,
    dataDir: dataDir ?? null,
    setupStartedAt,
    setupEndedAt,
    status: available ? (stale ? 'stale' : 'available') : 'missing',
    fileCount: index.fileCount,
    latestMtimeMs: index.latestMtimeMs,
    repoLatestMtimeMs: repo.latestMtimeMs,
  };
}

export function collectBenchmarkImplementationHashes({ benchmarkScriptPath = null, requiredFiles = REQUIRED_BENCHMARK_IMPLEMENTATION_FILES } = {}) {
  const rootDir = implementationRoot(benchmarkScriptPath);
  const files = [...requiredFiles].map((relativePath) => {
    const path = resolve(rootDir, relativePath);
    return { relativePath: normalizePath(relativePath), path, sha256: sha256File(path) };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    rootDir,
    requiredFiles: [...requiredFiles].map(normalizePath).sort(),
    files,
    missingFiles: files.filter((file) => !hasText(file.sha256)).map((file) => file.relativePath),
  };
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cmdArg(value) {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : shellQuote(text);
}

function resolveWindowsBin(bin, env = process.env) {
  if (process.platform !== 'win32' || extname(bin) || /[\\/]/.test(bin)) return bin;
  const pathValue = env.Path ?? env.PATH ?? '';
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of ['.cmd', '.exe', '.bat', '']) {
      const candidate = join(directory, `${bin}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

function spawnCli(bin, argv, { cwd, timeoutMs, env = process.env, stdio = 'pipe' } = {}) {
  if (process.platform === 'win32') {
    if (!extname(bin) && !/[\\/]/.test(bin)) {
      const commandLine = [bin, ...argv.map(cmdArg)].join(' ');
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { cwd, encoding: 'utf8', timeout: timeoutMs, env, stdio });
    }
    const resolvedBin = resolveWindowsBin(bin, env);
    if (/\.(cmd|bat)$/i.test(resolvedBin)) {
      const commandLine = `call ${[resolvedBin, ...argv].map(cmdArg).join(' ')}`;
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { cwd, encoding: 'utf8', timeout: timeoutMs, env, stdio });
    }
    return spawnSync(resolvedBin, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env, stdio });
  }
  return spawnSync(bin, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env, stdio });
}

function runSolidKGProbe(solidkgBin, { cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  const bin = hasText(solidkgBin) ? solidkgBin : 'solidkg';
  const result = spawnCli(bin, ['--version'], { cwd, timeoutMs });
  return {
    configuredBin: bin,
    argv: [bin, '--version'],
    statusCode: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    errorCode: result.error?.code ?? null,
  };
}

function scenarioHashes({ scenarioFile, matrix } = {}) {
  const fileHash = sha256File(scenarioFile);
  return {
    path: scenarioFile ?? null,
    sha256: fileHash ?? (matrix ? createHash('sha256').update(JSON.stringify(matrix)).digest('hex') : null),
    source: fileHash ? 'file' : (matrix ? 'matrix_object' : 'missing'),
  };
}

function plannedRunRows(results) {
  const plannedRunOrder = asArray(results?.plannedRunOrder);
  return {
    plannedRunCount: plannedRunOrder.length,
    resultRowCount: asArray(results?.runs).length,
    missingPlannedRunCount: Math.max(0, plannedRunOrder.length - asArray(results?.runs).length),
  };
}

function repeatReadiness(results, requiredRepeatCount = REQUIRED_REPEAT_COUNT) {
  const scoreable = asArray(results?.runs).filter((run) => typeof run.score === 'number');
  const counts = new Map();
  for (const run of scoreable) {
    const key = `${run.scenarioId}:${run.armId}`;
    if (!counts.has(key)) counts.set(key, new Set());
    counts.get(key).add(run.repeat ?? 1);
  }
  const rows = [...counts.entries()].map(([key, repeats]) => {
    const [scenarioId, armId] = key.split(':');
    return { scenarioId, armId, scoreableRepeatCount: repeats.size, requiredRepeatCount, ready: repeats.size >= requiredRepeatCount };
  });
  return { requiredRepeatCount, scoreableScenarioArms: rows.length, rows, ready: rows.length > 0 && rows.every((row) => row.ready) };
}

function rawEvidenceReadiness(results) {
  const rows = [];
  for (const run of asArray(results?.runs).filter((candidate) => typeof candidate.score === 'number')) {
    const classification = classifyRawEvidence({ run });
    rows.push({
      runId: run.id ?? `${run.blockId ?? run.scenarioId}:${run.armId}`,
      scenarioId: run.scenarioId,
      armId: run.armId,
      repeat: run.repeat ?? 1,
      status: classification.status,
      causeCode: classification.causeCode,
      sourceAttempted: classification.sourceAttempted,
      errors: classification.errors,
    });
  }
  return { rows, ready: rows.length > 0 && rows.every((row) => row.status === 'available') };
}

function benchmarkImplementationFromPassport(passport) {
  if (isRecord(passport.benchmarkImplementation)) return passport.benchmarkImplementation;
  const legacyPath = passport.benchmarkCode?.path;
  const legacyRelativePath = hasText(legacyPath) ? normalizePath(relative(dirname(legacyPath), legacyPath)) : 'opencode-answer-benchmark.mjs';
  return {
    rootDir: hasText(legacyPath) ? dirname(legacyPath) : null,
    requiredFiles: [legacyRelativePath],
    files: [{ relativePath: legacyRelativePath, path: legacyPath ?? null, sha256: passport.benchmarkCode?.sha256 ?? null }],
    missingFiles: hasText(passport.benchmarkCode?.sha256) ? [] : [legacyRelativePath],
    legacyOnly: true,
  };
}

function implementationHashReadiness({ passport, currentBenchmarkScriptPath }) {
  const captured = benchmarkImplementationFromPassport(passport);
  const requiredFiles = asArray(captured.requiredFiles).map(normalizePath).sort();
  const capturedByRelativePath = new Map(asArray(captured.files).map((file) => [normalizePath(file.relativePath), file]));
  const missingFiles = [];
  const mismatchedFiles = [];

  for (const relativePath of requiredFiles) {
    const capturedFile = capturedByRelativePath.get(relativePath);
    if (!hasText(capturedFile?.sha256)) {
      missingFiles.push(relativePath);
      continue;
    }
    if (currentBenchmarkScriptPath) {
      const currentPath = resolve(implementationRoot(currentBenchmarkScriptPath), relativePath);
      const currentSha256 = sha256File(currentPath);
      if (hasText(currentSha256) && currentSha256 !== capturedFile.sha256) {
        mismatchedFiles.push({ relativePath, capturedSha256: capturedFile.sha256, currentSha256, path: currentPath });
      }
    }
  }

  const missingRequiredFiles = REQUIRED_BENCHMARK_IMPLEMENTATION_FILES
    .map(normalizePath)
    .filter((relativePath) => !requiredFiles.includes(relativePath));
  missingFiles.push(...missingRequiredFiles);

  return {
    ...captured,
    requiredFiles,
    coveredFiles: asArray(captured.files).filter((file) => hasText(file.sha256)).map((file) => normalizePath(file.relativePath)).sort(),
    missingFiles: [...new Set(missingFiles)].sort(),
    mismatchedFiles,
  };
}

export function buildBenchmarkPassport({
  results = {},
  matrix = null,
  scenarioFile = null,
  benchmarkScriptPath = null,
  solidkgBin = 'solidkg',
  solidkgProbe = null,
  indexes = [],
  generatedAt = new Date().toISOString(),
  diagnosticOnly = false,
} = {}) {
  const benchmarkImplementation = collectBenchmarkImplementationHashes({ benchmarkScriptPath });
  const opencodeBenchmark = benchmarkImplementation.files.find((file) => file.relativePath === 'opencode-answer-benchmark.mjs');
  const passport = {
    schemaName: BENCHMARK_PASSPORT_SCHEMA,
    generatedAt,
    diagnosticOnly: diagnosticOnly === true,
    requiredRepeatCount: REQUIRED_REPEAT_COUNT,
    benchmarkCode: { path: opencodeBenchmark?.path ?? benchmarkScriptPath ?? null, sha256: opencodeBenchmark?.sha256 ?? sha256File(benchmarkScriptPath) },
    benchmarkImplementation,
    scenarios: scenarioHashes({ scenarioFile, matrix }),
    solidkg: solidkgProbe ?? runSolidKGProbe(solidkgBin),
    indexes: asArray(indexes),
    plannedRuns: plannedRunRows(results),
  };
  return { ...passport, readiness: evaluateBenchmarkPassport({ results: { ...results, benchmarkPassport: passport }, currentBenchmarkScriptPath: benchmarkScriptPath, currentScenarioFile: scenarioFile, expectedSolidKGBin: solidkgBin }) };
}

export function evaluateBenchmarkPassport({
  results = {},
  currentBenchmarkScriptPath = null,
  currentScenarioFile = null,
  expectedSolidKGBin = null,
  requiredRepeatCount = REQUIRED_REPEAT_COUNT,
} = {}) {
  const stopConditions = [];
  const warnings = [];
  const passport = results?.benchmarkPassport;
  if (!isRecord(passport)) {
    return {
      schemaName: BENCHMARK_PASSPORT_READINESS_SCHEMA.schemaName,
      proofTier: 'diagnostic',
      claimGrade: false,
      stopConditions: ['missing_benchmark_passport'],
      warnings: ['results do not include a benchmark passport; report remains diagnostic only'],
      requiredRepeatCount,
    };
  }

  const benchmarkImplementation = implementationHashReadiness({ passport, currentBenchmarkScriptPath });
  if (!hasText(currentBenchmarkScriptPath)) addUnique(stopConditions, 'benchmark_verification_path_missing');
  if (hasText(passport.scenarios?.sha256) && !hasText(currentScenarioFile)) addUnique(stopConditions, 'scenario_verification_path_missing');
  if (benchmarkImplementation.missingFiles.length > 0) addUnique(stopConditions, 'benchmark_code_hash_missing');
  if (benchmarkImplementation.mismatchedFiles.length > 0) addUnique(stopConditions, 'benchmark_code_hash_mismatch');

  if (!hasText(passport.scenarios?.sha256)) addUnique(stopConditions, 'scenario_hash_missing');
  else if (currentScenarioFile) {
    const actual = sha256File(currentScenarioFile);
    if (actual && actual !== passport.scenarios.sha256) addUnique(stopConditions, 'scenario_hash_mismatch');
  }

  if (hasText(expectedSolidKGBin) && hasText(passport.solidkg?.configuredBin) && passport.solidkg.configuredBin !== expectedSolidKGBin) addUnique(stopConditions, 'solidkg_binary_mismatch');
  if (passport.solidkg?.statusCode !== undefined && passport.solidkg.statusCode !== 0) addUnique(stopConditions, 'solidkg_binary_mismatch');

  const indexes = asArray(passport.indexes);
  if (indexes.some((index) => index.status === 'missing' || index.status === 'unavailable')) addUnique(stopConditions, 'solidkg_index_unavailable');
  if (indexes.some((index) => index.status === 'stale')) addUnique(stopConditions, 'solidkg_index_stale');

  const repeats = repeatReadiness(results, requiredRepeatCount);
  if (!repeats.ready) addUnique(stopConditions, 'low_repeat_claim_grade_blocked');

  const rawEvidence = rawEvidenceReadiness(results);
  if (!rawEvidence.ready) addUnique(stopConditions, 'raw_tool_outputs_unavailable');

  const planned = plannedRunRows(results);
  if (planned.missingPlannedRunCount > 0) warnings.push(`${planned.missingPlannedRunCount} planned runs have no result row`);
  if (passport.diagnosticOnly === true) warnings.push('passport was generated for a dry-run or diagnostic-only result set');
  if (!hasText(currentBenchmarkScriptPath)) warnings.push('current benchmark implementation path was not supplied for report-time verification');
  if (hasText(passport.scenarios?.sha256) && !hasText(currentScenarioFile)) warnings.push('current scenario file path was not supplied for report-time verification');
  for (const file of benchmarkImplementation.missingFiles) warnings.push(`benchmark implementation hash missing: ${file}`);
  for (const file of benchmarkImplementation.mismatchedFiles) warnings.push(`benchmark implementation hash mismatch: ${file.relativePath}`);
  for (const row of repeats.rows.filter((row) => !row.ready)) warnings.push(`${row.scenarioId}/${row.armId} has ${row.scoreableRepeatCount} scoreable repeats; ${requiredRepeatCount} required for claim-grade`);
  for (const row of rawEvidence.rows.filter((row) => row.status !== 'available')) warnings.push(`${row.runId} raw evidence unavailable: ${row.causeCode}`);

  const claimGrade = stopConditions.length === 0 && planned.missingPlannedRunCount === 0 && passport.diagnosticOnly !== true;
  return {
    schemaName: BENCHMARK_PASSPORT_READINESS_SCHEMA.schemaName,
    proofTier: claimGrade ? 'claim_grade' : (results?.profile === 'smoke' || results?.profile === 'calibration' ? 'smoke_or_diagnostic' : 'diagnostic'),
    claimGrade,
    stopConditions,
    warnings,
    requiredRepeatCount,
    benchmarkCode: passport.benchmarkCode ?? null,
    benchmarkImplementation,
    scenarios: passport.scenarios ?? null,
    solidkg: passport.solidkg ?? null,
    indexes,
    repeatReadiness: repeats,
    rawEvidence,
    plannedRuns: planned,
  };
}

export function attachBenchmarkPassport(results, options = {}) {
  const passport = buildBenchmarkPassport({ results, ...options });
  return { ...results, benchmarkPassport: passport };
}