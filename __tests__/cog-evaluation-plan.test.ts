import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'agent-eval', 'cog-evaluation.mjs');
const planPath = path.join(repoRoot, 'docs', 'design', 'cog-adoption-evaluation-plan.md');
const readinessManifestPath = path.join(repoRoot, 'docs', 'design', 'readiness-evidence-manifest.json');
const corpusManifestPath = path.join(repoRoot, 'fixtures', 'evaluation-corpus', 'manifest.json');
const hasPlanDoc = fs.existsSync(planPath);
const hasReadinessManifest = fs.existsSync(readinessManifestPath);

const survivingCandidates = [
  'deterministic-typed-summaries',
  'evidence-utility-diagnostic',
  'deterministic-failure-hints',
  'offline-semantic-negative-control',
  'offline-query-plan-harness',
];

const killedMechanisms = [
  'runtime-llm-planning',
  'llm-generated-user-facing-code',
  'sandbox-self-correction',
  'tur-primary-metric',
  'semantic-traversal-replacement',
  'kgqa-direct-evidence',
];

function runHelper(...args: string[]) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('CoG adoption evaluation plan', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it.skipIf(!hasPlanDoc)('documents the full deterministic experiment plan and excludes runtime CoG mechanisms', () => {
    const plan = fs.readFileSync(planPath, 'utf8');

    expect(plan).toContain('Code-on-Graph Adoption Evaluation Plan');
    expect(plan).toContain('Execute the full evaluation program');
    expect(plan).toContain('current main');
    expect(plan).toContain('simpler deterministic alternative');
    expect(plan).toContain('at least 4 runs/arm');

    for (const candidate of survivingCandidates) expect(plan).toContain(candidate);
    for (const mechanism of killedMechanisms) expect(plan).toContain(mechanism);
  });

  it('emits a schema-valid sample covering every surviving candidate and proof gate', () => {
    const result = runHelper('--sample');

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schemaName: string;
      candidates: Array<{ id: string; status: string; primaryMetrics: string[]; passGate: string; killGate: string }>;
      globalProofGate: { runs: { minimumRunsPerArm: number }; primaryMetrics: string[]; absoluteKillConditions: string[] };
      exclusions: string[];
    };

    expect(report.schemaName).toBe('solidkg.cog-adoption-evaluation.v1');
    expect(report.candidates.map((candidate) => candidate.id)).toEqual(survivingCandidates);
    expect(report.candidates.every((candidate) => candidate.status === 'experiment_only')).toBe(true);
    expect(report.globalProofGate.runs.minimumRunsPerArm).toBe(4);
    expect(report.globalProofGate.primaryMetrics).toEqual(
      expect.arrayContaining(['readCount', 'grepCount', 'answerCompleteness', 'wallClockMs', 'mcpCalls', 'payloadBytes', 'sourceFidelity']),
    );
    expect(report.globalProofGate.absoluteKillConditions).toEqual(
      expect.arrayContaining(['fabricated_source_path', 'unsupported_inferred_edge', 'stale_file_regression', 'ambiguity_regression']),
    );
    expect(report.exclusions).toEqual(expect.arrayContaining(killedMechanisms));
  });

  it('runs a local deterministic evaluation report covering all follow-up gates', () => {
    const result = runHelper('--run-local');

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schemaName: string;
      reportKind: string;
      measuredLocally: string[];
      externalAbPlaceholders: string[];
      failureSituations: Array<{
        id: string;
        failureType: string;
        state: string;
        evidence: { files: string[]; symbols: string[]; sourceLinked: boolean; syntheticFixture: boolean };
        transitions: unknown[];
      }>;
      stabilityOverlap: { runs: Array<{ runId: string; citedFiles: string[]; citedSymbols: string[] }>; fileOverlap: number; symbolOverlap: number; stable: boolean };
      rawCountBaseline: { arms: Array<{ arm: string; readCount: number; grepCount: number; mcpCalls: number; payloadBytes: number }> };
      highFanoutPayloadPain: { decision: string; reason: string; measuredPayloadBytes: number; fallbackReadsCausedByPayload: boolean };
      overheadGate: {
        productionAdoptionClaim: boolean;
        predictedAdditionalAgentToolCalls: number;
        fallbackReadGrepRisk: number;
        creationUseAdditionalLatencyMs: number;
        mcpCalls: { currentMain: number; candidate: number; maxAllowedCandidate: number };
        syntheticLatencyMs: { median: number; p95: number; maxMedian: number; maxP95: number };
      };
      semanticNegativeControls: Array<{ id: string; mode: string; sourceEvidence: boolean; productionTraversal: boolean }>;
      candidateGates: Array<{ candidate: string; status: string; decision: string; reason: string }>;
      forbiddenMechanisms: string[];
    };

    expect(report.schemaName).toBe('solidkg.cog-local-evaluation.v1');
    expect(report.reportKind).toBe('local-deterministic-evaluation');
    expect(report.measuredLocally).toEqual(
      expect.arrayContaining([
        'failure-situations',
        'stability-overlap',
        'raw-count-baseline',
        'high-fanout-payload-pain',
        'tool-call-latency-gate',
        'semantic-negative-controls',
        'candidate-gates',
      ]),
    );
    expect(report.externalAbPlaceholders).toEqual(expect.arrayContaining(['real-agent-read-grep-reduction', 'wall-clock-delta', 'answer-completeness-human-score']));
    expect(report.failureSituations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureType: 'ambiguous-symbol',
          state: 'detected',
          evidence: expect.objectContaining({ files: expect.arrayContaining(['src/payments.ts']), symbols: expect.arrayContaining(['PaymentGateway']) }),
        }),
      ]),
    );
    expect(report.failureSituations.every((situation) => situation.evidence.sourceLinked === false)).toBe(true);
    expect(report.failureSituations.every((situation) => situation.evidence.syntheticFixture === true)).toBe(true);
    expect(report.failureSituations.every((situation) => situation.transitions.length > 0)).toBe(true);
    expect(report.stabilityOverlap.fileOverlap).toBeGreaterThanOrEqual(0);
    expect(report.stabilityOverlap.fileOverlap).toBeLessThanOrEqual(1);
    expect(report.stabilityOverlap.symbolOverlap).toBeGreaterThanOrEqual(0);
    expect(report.stabilityOverlap.symbolOverlap).toBeLessThanOrEqual(1);
    expect(report.rawCountBaseline.arms.map((arm) => arm.arm).sort()).toEqual(['candidate', 'current-main', 'simpler-deterministic-alternative']);
    expect(report.highFanoutPayloadPain.decision).toBe('defer');
    expect(report.highFanoutPayloadPain.fallbackReadsCausedByPayload).toBe(false);
    expect(report.overheadGate.productionAdoptionClaim).toBe(false);
    expect(report.overheadGate.predictedAdditionalAgentToolCalls).toBe(0);
    expect(report.overheadGate.fallbackReadGrepRisk).toBe(0);
    expect(report.overheadGate.creationUseAdditionalLatencyMs).toBe(0);
    expect(report.overheadGate.mcpCalls.candidate).toBeLessThanOrEqual(report.overheadGate.mcpCalls.maxAllowedCandidate);
    expect(report.overheadGate.mcpCalls.candidate).toBeLessThanOrEqual(report.overheadGate.mcpCalls.currentMain);
    expect(report.overheadGate.syntheticLatencyMs.median).toBeLessThanOrEqual(report.overheadGate.syntheticLatencyMs.maxMedian);
    expect(report.overheadGate.syntheticLatencyMs.p95).toBeLessThanOrEqual(report.overheadGate.syntheticLatencyMs.maxP95);
    expect(report.semanticNegativeControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'semantic-only-ranking-control', mode: 'offline-only', sourceEvidence: false, productionTraversal: false }),
      ]),
    );
    expect(report.candidateGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate: 'deterministic-failure-hints', status: 'continue-eval-only', decision: 'test-first' }),
        expect.objectContaining({ candidate: 'deterministic-typed-summaries', status: 'defer', decision: 'do-not-implement-now' }),
        expect.objectContaining({ candidate: 'evidence-utility-diagnostic', status: 'defer', decision: 'offline-only-until-raw-counts-fail' }),
      ]),
    );
    expect(report.candidateGates.every((gate) => gate.status !== 'adoption-ready')).toBe(true);
    expect(report.forbiddenMechanisms).toEqual(expect.arrayContaining(killedMechanisms));
  });

  it('rejects forbidden runtime mechanisms and does not write invalid artifacts', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cog-invalid-'));
    const inputPath = path.join(tempDir, 'invalid.json');
    const outputPath = path.join(tempDir, 'invalid-output.json');
    const report = JSON.parse(execFileSync(process.execPath, [helperPath, '--sample'], { cwd: repoRoot, encoding: 'utf8' }));
    report.exclusions = report.exclusions.filter((item: string) => item !== 'runtime-llm-planning');
    report.candidates.push({
      id: 'runtime-llm-planning',
      status: 'experiment_only',
      primaryMetrics: ['readCount'],
      passGate: 'bad',
      killGate: 'bad',
    });
    fs.writeFileSync(inputPath, JSON.stringify(report, null, 2));

    const result = runHelper('--validate', inputPath, '--out', outputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exclusions must include runtime-llm-planning');
    expect(result.stderr).toContain('candidate runtime-llm-planning is forbidden');
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('rejects extra unknown candidates outside the surviving deterministic set', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cog-unknown-'));
    const inputPath = path.join(tempDir, 'unknown.json');
    const report = JSON.parse(execFileSync(process.execPath, [helperPath, '--sample'], { cwd: repoRoot, encoding: 'utf8' }));
    report.candidates.push({
      id: 'unreviewed-cog-experiment',
      status: 'experiment_only',
      primaryMetrics: ['readCount'],
      passGate: 'bad',
      killGate: 'bad',
    });
    fs.writeFileSync(inputPath, JSON.stringify(report, null, 2));

    const result = runHelper('--validate', inputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('candidate unreviewed-cog-experiment is not in the surviving candidate set');
  });

  it('validates a written local deterministic evaluation report', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cog-local-'));
    const outputPath = path.join(tempDir, 'local-report.json');

    const writeResult = runHelper('--run-local', '--out', outputPath);
    const validateResult = runHelper('--validate', outputPath);

    expect(writeResult.status, writeResult.stderr).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(validateResult.status, validateResult.stderr).toBe(0);
    expect(JSON.parse(validateResult.stdout)).toEqual({
      ok: true,
      schemaName: 'solidkg.cog-local-evaluation.v1',
      validatedCandidates: 5,
      outputPath: null,
    });
  });

  it('rejects unknown and forbidden local candidate gates', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cog-local-gates-'));
    const inputPath = path.join(tempDir, 'local-invalid-gates.json');
    const report = JSON.parse(execFileSync(process.execPath, [helperPath, '--run-local'], { cwd: repoRoot, encoding: 'utf8' }));
    report.candidateGates.push(
      {
        candidate: 'unreviewed-cog-experiment',
        status: 'defer',
        decision: 'bad-local-gate',
        reason: 'unknown candidates must not validate',
        evidence: ['candidate-gates'],
      },
      {
        candidate: 'runtime-llm-planning',
        status: 'defer',
        decision: 'bad-local-gate',
        reason: 'forbidden mechanisms must not validate',
        evidence: ['candidate-gates'],
      },
    );
    fs.writeFileSync(inputPath, JSON.stringify(report, null, 2));

    const result = runHelper('--validate', inputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('candidate gate unreviewed-cog-experiment is not in the surviving candidate set');
    expect(result.stderr).toContain('candidate gate runtime-llm-planning is forbidden');
  });

  it('rejects local reports that add tool-call overhead, latency, or production semantic behavior', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cog-local-overhead-'));
    const inputPath = path.join(tempDir, 'local-invalid-overhead.json');
    const report = JSON.parse(execFileSync(process.execPath, [helperPath, '--run-local'], { cwd: repoRoot, encoding: 'utf8' }));
    report.overheadGate.productionAdoptionClaim = true;
    report.overheadGate.predictedAdditionalAgentToolCalls = 1;
    report.overheadGate.fallbackReadGrepRisk = 1;
    report.overheadGate.creationUseAdditionalLatencyMs = 3;
    report.overheadGate.mcpCalls.candidate = report.overheadGate.mcpCalls.maxAllowedCandidate + 1;
    report.overheadGate.syntheticLatencyMs.p95 = report.overheadGate.syntheticLatencyMs.maxP95 + 1;
    report.semanticNegativeControls[0].sourceEvidence = true;
    report.semanticNegativeControls[0].productionTraversal = true;
    fs.writeFileSync(inputPath, JSON.stringify(report, null, 2));

    const result = runHelper('--validate', inputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('overheadGate.productionAdoptionClaim must be false');
    expect(result.stderr).toContain('overheadGate.predictedAdditionalAgentToolCalls must be 0');
    expect(result.stderr).toContain('overheadGate.fallbackReadGrepRisk must be 0');
    expect(result.stderr).toContain('overheadGate.creationUseAdditionalLatencyMs must be 0');
    expect(result.stderr).toContain('overheadGate.mcpCalls.candidate must not exceed maxAllowedCandidate');
    expect(result.stderr).toContain('overheadGate.syntheticLatencyMs.p95 must not exceed maxP95');
    expect(result.stderr).toContain('semanticNegativeControls[0].sourceEvidence must be false');
    expect(result.stderr).toContain('semanticNegativeControls[0].productionTraversal must be false');
  });

  it.skipIf(!hasReadinessManifest)('registers readiness evidence for sample artifacts', () => {
    const readinessManifest = JSON.parse(fs.readFileSync(readinessManifestPath, 'utf8')) as {
      entries: Array<{ task: string; schemaName: string; evidencePath: string; privacy: string }>;
    };

    expect(readinessManifest.entries).toContainEqual(
      expect.objectContaining({
        task: 'cog-adoption-evaluation',
        schemaName: 'solidkg.cog-adoption-evaluation.v1',
        evidencePath: '.omo/evidence/cog-adoption-evaluation-sample.json',
        privacy: expect.stringContaining('metadata_only'),
      }),
    );
    expect(readinessManifest.entries).toContainEqual(
      expect.objectContaining({
        task: 'cog-local-evaluation',
        schemaName: 'solidkg.cog-local-evaluation.v1',
        evidencePath: '.omo/evidence/cog-adoption-evaluation-local.json',
        privacy: expect.stringContaining('metadata_only'),
      }),
    );
  });

  it('registers synthetic fixtures without approving real corpus fetching', () => {
    const corpusManifest = JSON.parse(fs.readFileSync(corpusManifestPath, 'utf8')) as {
      corpora: unknown[];
      syntheticFixtures?: Array<{ name: string; identity: string; realCorpus: boolean; probeCommand: string }>;
    };

    expect(corpusManifest.corpora).toEqual([]);
    expect(corpusManifest.syntheticFixtures).toContainEqual(
      expect.objectContaining({
        name: 'cog-adoption-evaluation-synthetic',
        identity: 'synthetic://evaluation-corpus/cog-adoption-evaluation',
        realCorpus: false,
        probeCommand: 'node scripts/agent-eval/cog-evaluation.mjs --sample',
      }),
    );
    expect(corpusManifest.syntheticFixtures).toContainEqual(
      expect.objectContaining({
        name: 'cog-local-evaluation-synthetic',
        identity: 'synthetic://evaluation-corpus/cog-local-evaluation',
        realCorpus: false,
        probeCommand: 'node scripts/agent-eval/cog-evaluation.mjs --run-local',
      }),
    );
  });
});
