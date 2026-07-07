import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const passportPath = path.join(repoRoot, 'scripts', 'agent-eval', 'benchmark-passport.mjs');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function writeEvidenceDossier(dir: string, run: { id: string; scenarioId: string; armId: string; repeat: number; blockId: string }) {
  const runDir = path.join(dir, run.id.replace(/[^A-Za-z0-9_.-]+/g, '_'));
  const payloadDir = path.join(runDir, 'tool-results');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, '0000-solidkg_context.json');
  const payload = JSON.stringify({ ok: true, runId: run.id });
  fs.writeFileSync(payloadPath, payload);
  const dossierPath = path.join(runDir, 'evidence-dossier.json');
  fs.writeFileSync(dossierPath, `${JSON.stringify({
    schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
    runId: run.id,
    scenarioId: run.scenarioId,
    armId: run.armId,
    repeat: run.repeat,
    blockId: run.blockId,
    toolResults: [{ seq: 0, tool: 'solidkg_context', requestId: `${run.id}:request`, resultId: `${run.id}:result`, rawPayloadPath: payloadPath, rawPayloadSha256: sha256(payload), sizeBytes: Buffer.byteLength(payload) }],
  }, null, 2)}\n`);
  return dossierPath;
}

function writeImplementationFiles(dir: string) {
  const files = [
    'opencode-answer-benchmark.mjs',
    'answer-scenarios.mjs',
    'answer-arms.mjs',
    'opencode-runner.mjs',
    'parse-opencode-transcript.mjs',
    'score-answer-quality.mjs',
    'answer-evidence-contract.mjs',
    'report-answer-quality.mjs',
    'benchmark-passport.mjs',
  ];
  for (const file of files) fs.writeFileSync(path.join(dir, file), `// ${file} v1\n`);
  return { files, entry: path.join(dir, 'opencode-answer-benchmark.mjs') };
}
function claimGradeResults(tempDir: string, repeats = 4) {
  const runs = ['solidkg', 'grep_read'].flatMap((armId) => Array.from({ length: repeats }, (_, index) => {
    const repeat = index + 1;
    const run = {
      id: `ky-architecture_flow:r${repeat}:${armId}`,
      blockId: `ky-architecture_flow:r${repeat}`,
      scenarioId: 'ky-architecture_flow',
      repoId: 'ky',
      armId,
      repeat,
      status: 'pass',
      score: 90,
      setupDurationMs: 1,
      queryDurationMs: 1,
      costUsd: 0,
      toolCalls: [{ tool: armId === 'solidkg' ? 'solidkg_context' : 'read' }],
    };
    return { ...run, evidenceDossierPath: writeEvidenceDossier(tempDir, run) };
  }));
  return {
    schemaName: 'solidkg.llm-answer-quality.results.v1',
    reportSchemaName: 'solidkg.llm-answer-quality.report.v1',
    profile: 'full',
    seed: 'passport-test',
    plannedRunOrder: runs.map((run) => run.id),
    runs,
  };
}

describe('benchmark passport readiness gates', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('exports a stable schema and required stop-condition codes', async () => {
    const passport = await import(pathToFileUrl(passportPath));

    expect(passport.BENCHMARK_PASSPORT_SCHEMA).toBe('solidkg.llm-answer-quality.benchmark-passport.v1');
    expect(passport.BENCHMARK_PASSPORT_READINESS_SCHEMA.stableFields).toEqual(['proofTier', 'claimGrade', 'stopConditions', 'warnings', 'requiredRepeatCount']);
    expect(passport.STOP_CONDITION_CODES).toEqual(expect.arrayContaining([
      'missing_benchmark_passport',
      'benchmark_code_hash_missing',
      'benchmark_code_hash_mismatch',
      'scenario_hash_missing',
      'scenario_hash_mismatch',
      'solidkg_binary_mismatch',
      'solidkg_index_unavailable',
      'solidkg_index_stale',
      'low_repeat_claim_grade_blocked',
      'raw_tool_outputs_unavailable',
    ]));
  });

  it('captures required implementation hashes and detects implementation and scenario drift', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-hash-'));
    const implementation = writeImplementationFiles(tempDir);
    const scenarios = path.join(tempDir, 'scenarios.json');
    fs.writeFileSync(scenarios, '{"schemaName":"scenario"}\n');
    const results = claimGradeResults(tempDir);
    const built = passport.buildBenchmarkPassport({ results, benchmarkScriptPath: implementation.entry, scenarioFile: scenarios, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    expect(built.benchmarkCode.sha256).toBe(passport.sha256File(implementation.entry));
    expect(built.benchmarkImplementation.requiredFiles).toEqual(implementation.files.sort());
    expect(built.benchmarkImplementation.missingFiles).toEqual([]);
    for (const file of [
      'answer-scenarios.mjs',
      'answer-arms.mjs',
      'opencode-runner.mjs',
      'parse-opencode-transcript.mjs',
      'score-answer-quality.mjs',
      'answer-evidence-contract.mjs',
      'report-answer-quality.mjs',
      'benchmark-passport.mjs',
    ]) {
      expect(built.benchmarkImplementation.files.find((row: { relativePath: string; sha256: string | null }) => row.relativePath === file)?.sha256).toBe(passport.sha256File(path.join(tempDir, file)));
    }
    expect(built.scenarios.sha256).toBe(passport.sha256File(scenarios));

    fs.writeFileSync(path.join(tempDir, 'score-answer-quality.mjs'), '// score-answer-quality.mjs v2\n');
    fs.writeFileSync(path.join(tempDir, 'parse-opencode-transcript.mjs'), '// parse-opencode-transcript.mjs v2\n');
    fs.writeFileSync(scenarios, '{"schemaName":"scenario2"}\n');

    const readiness = passport.evaluateBenchmarkPassport({ results: { ...results, benchmarkPassport: built }, currentBenchmarkScriptPath: implementation.entry, currentScenarioFile: scenarios, expectedSolidKGBin: 'solidkg' });

    expect(readiness.stopConditions).toEqual(expect.arrayContaining(['benchmark_code_hash_mismatch', 'scenario_hash_mismatch']));
    expect(readiness.benchmarkImplementation.mismatchedFiles.map((file: { relativePath: string }) => file.relativePath)).toEqual(['parse-opencode-transcript.mjs', 'score-answer-quality.mjs']);
  });

  it('blocks claim-grade when any required implementation hash is missing', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-missing-impl-'));
    const implementation = writeImplementationFiles(tempDir);
    const results = claimGradeResults(tempDir);
    const built = passport.buildBenchmarkPassport({ results, benchmarkScriptPath: implementation.entry, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });
    built.benchmarkImplementation.files = built.benchmarkImplementation.files.filter((file: { relativePath: string }) => file.relativePath !== 'report-answer-quality.mjs');

    const readiness = passport.evaluateBenchmarkPassport({ results: { ...results, benchmarkPassport: built }, currentBenchmarkScriptPath: implementation.entry, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toContain('benchmark_code_hash_missing');
    expect(readiness.benchmarkImplementation.missingFiles).toContain('report-answer-quality.mjs');
  });
  it('blocks claim-grade when the configured SolidKG binary does not match provenance', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-bin-'));
    const results = claimGradeResults(tempDir);
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, solidkgBin: 'wrong-solidkg', solidkgProbe: { configuredBin: 'wrong-solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toContain('solidkg_binary_mismatch');
  });

  it('classifies missing and stale index metadata', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-index-'));
    const repoPath = path.join(tempDir, 'repo');
    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(repoPath, { recursive: true });

    expect(passport.collectIndexMetadata({ repoId: 'repo', repoPath, dataDir }).status).toBe('missing');

    fs.mkdirSync(dataDir, { recursive: true });
    const indexFile = path.join(dataDir, 'index.sqlite');
    const sourceFile = path.join(repoPath, 'source.ts');
    fs.writeFileSync(indexFile, 'index');
    fs.writeFileSync(sourceFile, 'source');
    const old = new Date(Date.now() - 120000);
    const fresh = new Date();
    fs.utimesSync(indexFile, old, old);
    fs.utimesSync(sourceFile, fresh, fresh);

    const stale = passport.collectIndexMetadata({ repoId: 'repo', repoPath, dataDir });
    const results = claimGradeResults(tempDir);
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [stale] });

    expect(stale.status).toBe('stale');
    expect(passport.evaluateBenchmarkPassport({ results, expectedSolidKGBin: 'solidkg' }).stopConditions).toContain('solidkg_index_stale');
  });

  it('uses the raw-evidence classifier and blocks missing raw sidecars', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    const results = claimGradeResults(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-raw-unused-')));
    tempDir = path.dirname(results.runs[0].evidenceDossierPath);
    results.runs = results.runs.map((run: any) => ({ ...run, evidenceDossierPath: undefined }));
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(readiness.rawEvidence.rows[0].causeCode).toBe('missing_evidence_dossier');
  });

  it('blocks low-repeat non-claim-grade fixtures', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-low-repeat-'));
    const results = claimGradeResults(tempDir, 2);
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toContain('low_repeat_claim_grade_blocked');
  });


  it('blocks claim-grade when a scoreable run points at a mismatched sidecar', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-mismatched-sidecar-'));
    const implementation = writeImplementationFiles(tempDir);
    const scenarios = path.join(tempDir, 'scenarios.json');
    fs.writeFileSync(scenarios, '{"schemaName":"scenario"}\n');
    const results = claimGradeResults(tempDir);
    const firstDossierPath = results.runs[0].evidenceDossierPath;
    const dossier = JSON.parse(fs.readFileSync(firstDossierPath, 'utf8'));
    dossier.runId = 'unrelated:r1:solidkg';
    fs.writeFileSync(firstDossierPath, JSON.stringify(dossier, null, 2) + '\n');
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, benchmarkScriptPath: implementation.entry, scenarioFile: scenarios, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, currentBenchmarkScriptPath: implementation.entry, currentScenarioFile: scenarios, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(readiness.rawEvidence.rows[0]).toMatchObject({ status: 'invalid', causeCode: 'run_identity_mismatch' });
  });

  it('blocks claim-grade without current benchmark and scenario verification paths', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-current-paths-'));
    const implementation = writeImplementationFiles(tempDir);
    const scenarios = path.join(tempDir, 'scenarios.json');
    fs.writeFileSync(scenarios, '{"schemaName":"scenario"}\n');
    const results = claimGradeResults(tempDir);
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, benchmarkScriptPath: implementation.entry, scenarioFile: scenarios, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, expectedSolidKGBin: 'solidkg' });

    expect(readiness.claimGrade).toBe(false);
    expect(readiness.stopConditions).toEqual(expect.arrayContaining(['benchmark_verification_path_missing', 'scenario_verification_path_missing']));
  });
  it('accepts a positive claim-grade fixture', async () => {
    const passport = await import(pathToFileUrl(passportPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-passport-positive-'));
    const implementation = writeImplementationFiles(tempDir);
    const scenarios = path.join(tempDir, 'scenarios.json');
    fs.writeFileSync(scenarios, '{"schemaName":"scenario"}\n');
    const results = claimGradeResults(tempDir);
    results.benchmarkPassport = passport.buildBenchmarkPassport({ results, benchmarkScriptPath: implementation.entry, scenarioFile: scenarios, solidkgBin: 'solidkg', solidkgProbe: { configuredBin: 'solidkg', statusCode: 0 }, indexes: [{ repoId: 'ky', status: 'available' }] });

    const readiness = passport.evaluateBenchmarkPassport({ results, currentBenchmarkScriptPath: implementation.entry, currentScenarioFile: scenarios, expectedSolidKGBin: 'solidkg' });

    expect(readiness).toMatchObject({ claimGrade: true, proofTier: 'claim_grade', stopConditions: [] });
  });
});