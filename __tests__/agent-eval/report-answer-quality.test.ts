import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const reportScript = path.join(repoRoot, 'scripts', 'agent-eval', 'report-answer-quality.mjs');
const sampleResults = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality', 'sample-results.json');
const methodologyDoc = path.join(repoRoot, 'docs', 'benchmarks', 'llm-answer-quality-benchmark.md');
const hasMethodologyDoc = fs.existsSync(methodologyDoc);

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function runNode(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

const scenarioFixture = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality', 'sample-scenarios.json');
const benchmarkEntry = path.join(repoRoot, 'scripts', 'agent-eval', 'opencode-answer-benchmark.mjs');

function sha256File(filePath: string) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function writeEvidenceDossier(dir: string, run: { id?: string; scenarioId?: string; armId?: string; repeat?: number; blockId?: string }, label: string): string {
  const runDir = path.join(dir, label);
  const payloadDir = path.join(runDir, 'tool-results');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, '0000-solidkg_context.json');
  const payload = '{"ok":true}\n';
  fs.writeFileSync(payloadPath, payload);
  const hash = require('crypto').createHash('sha256').update(payload).digest('hex');
  const dossierPath = path.join(runDir, 'evidence-dossier.json');
  fs.writeFileSync(dossierPath, `${JSON.stringify({
    schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
    runId: run.id ?? label,
    scenarioId: run.scenarioId ?? 'scenario',
    armId: run.armId ?? 'arm',
    repeat: run.repeat ?? 1,
    blockId: run.blockId ?? label,
    toolResults: [{ seq: 0, tool: 'solidkg_context', requestId: `${label}:request`, resultId: `${label}:result`, rawPayloadPath: payloadPath, rawPayloadSha256: hash, sizeBytes: Buffer.byteLength(payload) }],
  }, null, 2)}\n`);
  return dossierPath;
}

async function claimGradeReportFixture(tempDir: string) {
  const passport = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'benchmark-passport.mjs')));
  const sample = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
  const solidkgRun = sample.runs.find((run: { armId: string }) => run.armId === 'solidkg');
  const grepRun = sample.runs.find((run: { armId: string }) => run.armId === 'grep_read');
  const runs = ['solidkg', 'grep_read'].flatMap((armId) => [1, 2, 3, 4].map((repeat) => ({
    ...(armId === 'solidkg' ? solidkgRun : grepRun),
    id: `ky-architecture_flow:r${repeat}:${armId}`,
    blockId: `ky-architecture_flow:r${repeat}`,
    scenarioId: 'ky-architecture_flow',
    repoId: 'ky',
    armId,
    repeat,
    status: 'pass',
    reliabilityStatus: 'pass',
    score: 85,
  })));
  const results = {
    ...sample,
    profile: 'full',
    runs: runs.map((run) => ({ ...run, evidenceDossierPath: writeEvidenceDossier(tempDir, run, `${run.armId}-r${run.repeat ?? 1}`) })),
    plannedRunOrder: runs.map((run) => run.id),
  };
  results.benchmarkPassport = passport.buildBenchmarkPassport({
    results,
    benchmarkScriptPath: benchmarkEntry,
    scenarioFile: scenarioFixture,
    solidkgBin: 'solidkg',
    solidkgProbe: { configuredBin: 'solidkg', statusCode: 0, stdout: '0.0.0-test' },
    indexes: [{ repoId: 'ky', dataDir: path.join(tempDir, 'index'), status: 'available' }],
  });
  return results;
}
describe('answer quality report writer', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('writes JSON, Markdown, and HTML artifacts with required schema', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-'));
    const result = runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-quality.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-quality.md'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-quality.html'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-quality.json'), 'utf8'));
    expect(report.schemaName).toBe('solidkg.llm-answer-quality.report.v1');
    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toContain('missing_benchmark_passport');
  });

  it('renders caveats and setup statuses', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-caveat-'));
    runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);
    const md = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.md'), 'utf8');
    const report = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-quality.json'), 'utf8'));

    expect(md).toContain('Scores compare measured scenarios only and do not prove universal superiority.');
    expect(md).toContain('setup_failed');
    expect(report.reliabilityByArm.find((row: { armId: string }) => row.armId === 'cartog').counts.setup_failed).toBe(1);
    expect(report.readiness.readyForLiveFullRun).toBe(false);
    expect(report.readiness.claim.toLowerCase()).not.toContain('ready for live full run');
  });

  it('renders SVG and table rows for all five arms', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-html-'));
    runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);
    const html = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.html'), 'utf8');

    expect(html).toContain('<svg');
    for (const armId of ['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo']) {
      expect(html).toContain(`data-arm-id="${armId}"`);
    }
  });

  it('preserves run order, paired deltas, medians, fallback metrics, and judge scores', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    results.model = 'openai/gpt-5.5';
    results.variant = 'medium';
    const report = reporter.buildAnswerQualityReport(results);

    expect(report.runConfig.plannedRunOrder).toEqual(results.plannedRunOrder);
    expect(report.runConfig.model).toBe('openai/gpt-5.5');
    expect(report.runConfig.variant).toBe('medium');
    expect(report.pairedBlocks[0].scenarioId).toBe('ky-architecture_flow');
    expect(report.pairedBlocks[0].deltasVsGrepRead).toHaveProperty('solidkg');
    expect(report.aggregateByArm.find((row: { armId: string }) => row.armId === 'solidkg').medianReadCount).toBe(1);
    expect(report.perRunRows.some((row: { judgeSecondaryScore: number | null }) => row.judgeSecondaryScore === 94)).toBe(true);
  });

  it('surfaces tool-call metrics and scoring component breakdown in JSON Markdown and HTML', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-metrics-'));
    runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);
    const report = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-quality.json'), 'utf8'));
    const md = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.md'), 'utf8');
    const html = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.html'), 'utf8');
    const solidkgRow = report.perRunRows.find((row: { armId: string }) => row.armId === 'solidkg');

    expect(solidkgRow).toHaveProperty('toolCallCount');
    expect(solidkgRow).toHaveProperty('solidkgToolCalls');
    expect(solidkgRow).toHaveProperty('peerWrapperCalls');
    expect(solidkgRow).toHaveProperty('fallbackLoopCount');
    expect(solidkgRow.scoringComponents).toHaveProperty('correctness');
    expect(solidkgRow.scoringComponents).toHaveProperty('evidenceCoverage');
    expect(report.aggregateByArm.find((row: { armId: string }) => row.armId === 'solidkg')).toHaveProperty('medianSolidKGMcpCalls');
    expect(md).toContain('Median SolidKG MCP');
    expect(md).toContain('Correctness');
    expect(html).toContain('SolidKG MCP');
    expect(html).toContain('Peer wrappers');
    expect(md).toContain('## Benchmark Passport');
    expect(html).toContain('Benchmark Passport');
  });

  it('surfaces scoring notes for over-drilled runs in report outputs', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const solidkgRun = results.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    solidkgRun.toolCalls = Array.from({ length: 34 }, () => ({ tool: 'solidkg_solidkg_context' }));
    solidkgRun.solidkgToolCalls = 34;
    solidkgRun.readCount = 0;
    solidkgRun.grepCount = 0;
    solidkgRun.bashCount = 0;
    solidkgRun.fallbackLoopCount = 0;

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);
    const html = reporter.renderHtml(report);
    const row = report.perRunRows.find((candidate: { armId: string }) => candidate.armId === 'solidkg');

    expect(row.scoringNotes).toContain('excessive_solidkg_tool_calls');
    expect(md).toContain('excessive_solidkg_tool_calls');
    expect(html).toContain('excessive_solidkg_tool_calls');
  });

  it('surfaces separated score lanes in JSON Markdown and HTML reports', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);
    const html = reporter.renderHtml(report);
    const row = report.perRunRows.find((candidate: { armId: string; score: number | null }) => candidate.armId === 'solidkg' && typeof candidate.score === 'number');

    expect(row.answerQualityScore).toBeGreaterThan(0);
    expect(row.evidenceQualityScore).toBeGreaterThanOrEqual(0);
    expect(row.toolEconomyScore).toBeGreaterThanOrEqual(0);
    expect(row.diagnosticCompositeScore).toBe(row.score);
    expect(report.aggregateByArm.find((candidate: { armId: string }) => candidate.armId === 'solidkg')).toHaveProperty('medianAnswerQualityScore');
    expect(md).toContain('Answer quality');
    expect(md).toContain('Tool economy');
    expect(html).toContain('Answer quality');
    expect(html).toContain('Tool economy');
  });

  it('surfaces tool-call sequence diagnostics in report outputs', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const solidkgRun = results.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    solidkgRun.toolCalls = Array.from({ length: 11 }, () => ({ tool: 'solidkg_solidkg_node' }))
      .concat([{ tool: 'solidkg_solidkg_context' }, { tool: 'solidkg_solidkg_explore' }]);
    solidkgRun.solidkgToolCalls = 13;

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);
    const html = reporter.renderHtml(report);
    const row = report.perRunRows.find((candidate: { armId: string }) => candidate.armId === 'solidkg');

    expect(row.toolCallSequenceSummary).toMatchObject({ solidkgNodeCalls: 11, totalCalls: 13 });
    expect(row.toolCallSequenceSummary.classifications).toContain('repeated_solidkg_node_calls');
    expect(md).toContain('repeated_solidkg_node_calls');
    expect(html).toContain('repeated_solidkg_node_calls');
  });

  it('renders a detailed HTML report with run context, status guide, deltas, and per-run details', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-rich-html-'));
    runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);
    const html = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.html'), 'utf8');

    expect(html).toContain('Run Configuration');
    expect(html).toContain('Generated at');
    expect(html).toContain('Planned runs');
    expect(html).toContain('Transcript capability');
    expect(html).toContain('Status Guide');
    expect(html).toContain('setup_failed: Required setup or preflight failed');
    expect(html).toContain('Reliability counts are not quality scores');
    expect(html).toContain('Paired Scenario Deltas');
    expect(html).toContain('Deltas vs grep_read');
    expect(html).toContain('Run Details');
    expect(html).toContain('Reason: cartog_setup_unavailable');
    expect(html).toContain('Reason: scenario_query_not_supported');
    expect(html).toContain('Answer excerpt');
    expect(html).toContain('Tool calls');
    expect(html).toContain('solidkg_trace, read');
  });

  it('flags sparse fixture results as incomplete benchmark coverage', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-coverage-'));
    runNode(reportScript, '--from-results', sampleResults, '--out', tempDir);
    const report = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-quality.json'), 'utf8'));
    const md = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.md'), 'utf8');
    const html = fs.readFileSync(path.join(tempDir, 'llm-answer-quality.html'), 'utf8');

    expect(report.benchmarkCoverage.decisionReady).toBe(false);
    expect(report.benchmarkCoverage.zeroScoreableArms).toContain('cartog');
    expect(report.benchmarkCoverage.zeroScoreableArms).toContain('sverklo');
    expect(report.benchmarkCoverage.singleScoreableArms).toEqual(expect.arrayContaining(['solidkg', 'grep_read', 'tilth']));
    expect(html).toContain('Benchmark Coverage');
    expect(html).toContain('Not decision-ready');
    expect(html).toContain('cartog has 0 scoreable measurements');
    expect(html).toContain('sverklo has 0 scoreable measurements');
    expect(html).toContain('solidkg has only 1 scoreable measurement');
    expect(html).toContain('data-arm-score="cartog">n/a</text>');
    expect(html).toContain('data-arm-score="sverklo">n/a</text>');
    expect(md).toContain('## Benchmark Coverage');
    expect(md).toContain('Not decision-ready');
    expect(md).toContain('cartog has 0 scoreable measurements');
  });

  it('renders a professional shareable report when measured arms have adequate coverage', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-evidence-'));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const solidkgRun = results.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    const grepRun = results.runs.find((run: { armId: string }) => run.armId === 'grep_read');
    results.seed = 'professional-report-fixture';
    results.maxRuns = 4;
    results.plannedRunOrder = [
      'ky-architecture_flow:r1:solidkg',
      'ky-architecture_flow:r1:grep_read',
      'ky-architecture_flow:r2:solidkg',
      'ky-architecture_flow:r2:grep_read',
    ];
    results.runs = [
      { ...solidkgRun, repeat: 1, blockId: 'ky-architecture_flow:r1', rawToolResultPayloadBytes: 1200, truncatedToolResultCount: 0 },
      { ...grepRun, repeat: 1, blockId: 'ky-architecture_flow:r1', rawToolResultPayloadBytes: 3000, truncatedToolResultCount: 0 },
      { ...solidkgRun, repeat: 2, blockId: 'ky-architecture_flow:r2', queryDurationMs: 840, costUsd: 0.023, rawToolResultPayloadBytes: 1800, truncatedToolResultCount: 1 },
      { ...grepRun, repeat: 2, blockId: 'ky-architecture_flow:r2', queryDurationMs: 1510, costUsd: 0.027, rawToolResultPayloadBytes: 3500, truncatedToolResultCount: 0 },
    ];
    results.runs = results.runs.map((run: { id?: string; armId: string; repeat?: number }) => ({
      ...run,
      evidenceDossierPath: writeEvidenceDossier(tempDir!, run, `${run.armId}-r${run.repeat ?? 1}`),
    }));

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);
    const html = reporter.renderHtml(report);

    expect(report.benchmarkCoverage.decisionReady).toBe(true);
    expect(report.benchmarkCoverage.measuredArmIds).toEqual(['solidkg', 'grep_read']);
    expect(report.benchmarkCoverage.excludedArmIds).toEqual(['tilth', 'cartog', 'sverklo']);
    expect(report.benchmarkCoverage.byArm.find((row: { armId: string }) => row.armId === 'solidkg').scoreableRuns).toBe(2);
    expect(report.benchmarkCoverage.byArm.find((row: { armId: string }) => row.armId === 'grep_read').scoreableRuns).toBe(2);
    expect(report.aggregateByArm.find((row: { armId: string }) => row.armId === 'solidkg').medianRawToolResultPayloadBytes).toBe(1500);
    expect(report.aggregateByArm.find((row: { armId: string }) => row.armId === 'grep_read').medianRawToolResultPayloadBytes).toBe(3250);
    expect(report.perRunRows.find((row: { armId: string; repeat: number }) => row.armId === 'solidkg' && row.repeat === 2).truncatedToolResultCount).toBe(1);
    expect(md).toContain('## Objective');
    expect(md).toContain('Median raw payload bytes');
    expect(md).toContain('Truncated payloads');
    expect(md).toContain('Measured objective: Compare structural code-intelligence tool surfaces for SolidKG MCP against Grep/Read Baseline on measured OpenCode answer-quality runs.');
    expect(md).toContain('## Methodology');
    expect(md).toContain('Excluded arms: tilth, cartog, sverklo');
    expect(html).toContain('Professional Shareability');
    expect(html).toContain('Raw payload bytes');
    expect(html).toContain('Decision-ready for measured objective');
    expect(html).toContain('Measured objective');
    expect(html).toContain('structural code-intelligence tool surfaces');
  });

  it('keeps reports diagnostic-only when scoreable runs lack raw evidence sidecars', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const solidkgRun = results.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    const grepRun = results.runs.find((run: { armId: string }) => run.armId === 'grep_read');
    results.maxRuns = 4;
    results.plannedRunOrder = [
      'ky-architecture_flow:r1:solidkg',
      'ky-architecture_flow:r1:grep_read',
      'ky-architecture_flow:r2:solidkg',
      'ky-architecture_flow:r2:grep_read',
    ];
    results.runs = [
      { ...solidkgRun, repeat: 1, blockId: 'ky-architecture_flow:r1' },
      { ...grepRun, repeat: 1, blockId: 'ky-architecture_flow:r1' },
      { ...solidkgRun, repeat: 2, blockId: 'ky-architecture_flow:r2' },
      { ...grepRun, repeat: 2, blockId: 'ky-architecture_flow:r2' },
    ];

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);

    expect(report.benchmarkCoverage.decisionReady).toBe(false);
    expect(report.benchmarkCoverage.rawEvidenceReady).toBe(false);
    expect(report.benchmarkCoverage.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(md).toContain('raw_tool_outputs_unavailable');
  });

  it('marks live smoke reports ready for full-run guard when calibration is implied by live execution', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const baseRun = results.runs.find((run: { status: string }) => run.status === 'pass');
    const scoreableRuns = ['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo'].flatMap((armId) => [1, 2].map((repeat) => ({
      ...baseRun,
      id: `ky-architecture_flow:r${repeat}:${armId}`,
      blockId: `ky-architecture_flow:r${repeat}`,
      armId,
      repeat,
      status: 'pass',
      reliabilityStatus: 'pass',
      score: 50,
    })));
    results.profile = 'smoke';
    results.confirmLive = true;
    results.runs = scoreableRuns;
    results.plannedRunOrder = results.runs.map((run: { id: string }) => run.id);

    const report = reporter.buildAnswerQualityReport(results);

    expect(report.readiness.calibrationStatus).toBe('successful');
    expect(report.readiness.smokeStatus).toBe('successful');
    expect(report.readiness.readyForLiveFullRun).toBe(true);
  });

  it('flags partial live result files when planned runs are missing', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    results.plannedRunOrder = ['ky-architecture_flow:r1:solidkg', 'ky-architecture_flow:r1:grep_read', 'ky-architecture_flow:r1:tilth'];
    results.runs = [results.runs[0], results.runs[1]];

    const report = reporter.buildAnswerQualityReport(results);
    const md = reporter.renderMarkdown(report);

    expect(report.benchmarkCoverage.decisionReady).toBe(false);
    expect(report.benchmarkCoverage.plannedRunCount).toBe(3);
    expect(report.benchmarkCoverage.resultRowCount).toBe(2);
    expect(report.benchmarkCoverage.missingPlannedRunCount).toBe(1);
    expect(md).toContain('1 planned runs have no result row');
  });

  it('keeps runner_failed and parse_failed rows score-null and visible in reports', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    results.runs = [
      { ...results.runs[0], status: 'runner_failed', reliabilityStatus: 'runner_failed', score: 77, answer: '', toolCalls: [] },
      { ...results.runs[1], status: 'parse_failed', reliabilityStatus: 'parse_failed', score: 88, answer: '', toolCalls: [] },
    ];
    results.plannedRunOrder = results.runs.map((run: { id: string }) => run.id);

    const report = reporter.buildAnswerQualityReport(results);

    expect(report.perRunRows.map((row: { status: string }) => row.status)).toEqual(['runner_failed', 'parse_failed']);
    expect(report.perRunRows.every((row: { score: number | null }) => row.score === null)).toBe(true);
    expect(report.reliabilityByArm.some((row: { counts: { runner_failed: number } }) => row.counts.runner_failed > 0)).toBe(true);
    expect(report.reliabilityByArm.some((row: { counts: { parse_failed: number } }) => row.counts.parse_failed > 0)).toBe(true);
  });

  it('marks reports claim-grade only when passport and raw evidence gates pass', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-passport-'));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const solidkgRun = results.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    const grepRun = results.runs.find((run: { armId: string }) => run.armId === 'grep_read');
    results.profile = 'full';
    results.runs = ['solidkg', 'grep_read'].flatMap((armId) => [1, 2, 3, 4].map((repeat) => ({
      ...(armId === 'solidkg' ? solidkgRun : grepRun),
      id: `ky-architecture_flow:r${repeat}:${armId}`,
      blockId: `ky-architecture_flow:r${repeat}`,
      armId,
      repeat,
      status: 'pass',
      reliabilityStatus: 'pass',
      score: 85,
    })));
    results.plannedRunOrder = results.runs.map((run: { id: string }) => run.id);
    results.runs = results.runs.map((run: { id?: string; armId: string; repeat?: number }) => ({
      ...run,
      evidenceDossierPath: writeEvidenceDossier(tempDir!, run, `${run.armId}-r${run.repeat ?? 1}`),
    }));
    results.benchmarkPassport = {
      schemaName: 'solidkg.llm-answer-quality.benchmark-passport.v1',
      diagnosticOnly: false,
      requiredRepeatCount: 4,
      benchmarkCode: { path: 'scripts/agent-eval/opencode-answer-benchmark.mjs', sha256: 'hash-opencode-answer-benchmark.mjs' },
      benchmarkImplementation: {
        rootDir: 'scripts/agent-eval',
        requiredFiles: ['answer-arms.mjs', 'answer-evidence-contract.mjs', 'answer-scenarios.mjs', 'benchmark-passport.mjs', 'opencode-answer-benchmark.mjs', 'opencode-runner.mjs', 'parse-opencode-transcript.mjs', 'report-answer-quality.mjs', 'score-answer-quality.mjs'],
        files: [
          { relativePath: 'answer-arms.mjs', path: 'scripts/agent-eval/answer-arms.mjs', sha256: 'hash-answer-arms.mjs' },
          { relativePath: 'answer-evidence-contract.mjs', path: 'scripts/agent-eval/answer-evidence-contract.mjs', sha256: 'hash-answer-evidence-contract.mjs' },
          { relativePath: 'answer-scenarios.mjs', path: 'scripts/agent-eval/answer-scenarios.mjs', sha256: 'hash-answer-scenarios.mjs' },
          { relativePath: 'benchmark-passport.mjs', path: 'scripts/agent-eval/benchmark-passport.mjs', sha256: 'hash-benchmark-passport.mjs' },
          { relativePath: 'opencode-answer-benchmark.mjs', path: 'scripts/agent-eval/opencode-answer-benchmark.mjs', sha256: 'hash-opencode-answer-benchmark.mjs' },
          { relativePath: 'opencode-runner.mjs', path: 'scripts/agent-eval/opencode-runner.mjs', sha256: 'hash-opencode-runner.mjs' },
          { relativePath: 'parse-opencode-transcript.mjs', path: 'scripts/agent-eval/parse-opencode-transcript.mjs', sha256: 'hash-parse-opencode-transcript.mjs' },
          { relativePath: 'report-answer-quality.mjs', path: 'scripts/agent-eval/report-answer-quality.mjs', sha256: 'hash-report-answer-quality.mjs' },
          { relativePath: 'score-answer-quality.mjs', path: 'scripts/agent-eval/score-answer-quality.mjs', sha256: 'hash-score-answer-quality.mjs' }
        ],
        missingFiles: [],
      },
      scenarios: { path: 'fixtures/agent-eval/answer-quality/sample-scenarios.json', sha256: 'captured-scenario-hash' },
      solidkg: { configuredBin: 'solidkg', statusCode: 0, stdout: '0.0.0-test' },
      indexes: [{ repoId: 'ky', dataDir: path.join(tempDir!, 'index'), status: 'available' }],
    };

    const report = reporter.buildAnswerQualityReport(results, undefined, { currentBenchmarkScriptPath: benchmarkEntry, currentScenarioFile: scenarioFixture });
    const md = reporter.renderMarkdown(report);
    const html = reporter.renderHtml(report);

    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toEqual(expect.arrayContaining(['benchmark_code_hash_mismatch', 'scenario_hash_mismatch']));
    expect(md).toContain('Passport status: Diagnostic only');
    expect(html).toContain('Diagnostic only');
  });


  it('keeps direct report evaluation diagnostic-only without current benchmark and scenario verification paths', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-direct-paths-'));
    const results = await claimGradeReportFixture(tempDir);

    const report = reporter.buildAnswerQualityReport(results);

    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toEqual(expect.arrayContaining(['benchmark_verification_path_missing', 'scenario_verification_path_missing']));
  });
  it('detects report-time benchmark implementation hash drift', async () => {
    const reporter = await import(pathToFileUrl(reportScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-impl-drift-'));
    const results = await claimGradeReportFixture(tempDir);
    const scoreHash = results.benchmarkPassport.benchmarkImplementation.files.find((file: { relativePath: string }) => file.relativePath === 'score-answer-quality.mjs');
    scoreHash.sha256 = 'stale-score-hash';

    const report = reporter.buildAnswerQualityReport(results, undefined, { currentBenchmarkScriptPath: benchmarkEntry, currentScenarioFile: scenarioFixture });

    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toContain('benchmark_code_hash_mismatch');
    expect(report.passportReadiness.benchmarkImplementation.mismatchedFiles.map((file: { relativePath: string }) => file.relativePath)).toContain('score-answer-quality.mjs');
  });

  it('detects report-time scenario hash drift from --from-results', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-report-scenario-drift-'));
    const results = await claimGradeReportFixture(tempDir);
    const staleScenario = path.join(tempDir, 'stale-scenarios.json');
    fs.writeFileSync(staleScenario, `${fs.readFileSync(scenarioFixture, 'utf8')}\n`);
    results.benchmarkPassport.scenarios = { path: staleScenario, sha256: sha256File(staleScenario), source: 'file' };
    const resultsPath = path.join(tempDir, 'results.json');
    fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

    const result = runNode(reportScript, '--from-results', resultsPath, '--from-scenarios', scenarioFixture, '--out', tempDir);
    const report = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-quality.json'), 'utf8'));

    expect(result.status, result.stderr).toBe(0);
    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toContain('scenario_hash_mismatch');
  });
  it.skipIf(!hasMethodologyDoc)('methodology docs include required commands', () => {
    const doc = fs.readFileSync(methodologyDoc, 'utf8');

    expect(doc).toContain('node scripts/agent-eval/opencode-answer-benchmark.mjs --profile calibration --dry-run');
    expect(doc).toContain('node scripts/agent-eval/opencode-answer-benchmark.mjs --profile smoke --dry-run');
    expect(doc).toContain('node scripts/agent-eval/opencode-answer-benchmark.mjs --from-results fixtures/agent-eval/answer-quality/sample-results.json');
    expect(doc).toContain('node scripts/agent-eval/opencode-answer-benchmark.mjs --profile smoke --out');
    expect(doc).toContain('node scripts/agent-eval/opencode-answer-benchmark.mjs --profile full --out');
    expect(doc).toContain('--confirm-live');
    expect(doc).toContain('--max-runs');
    expect(doc).toContain('--max-estimated-cost-usd');
    expect(doc).toContain('--variant medium');
    expect(doc).toContain('scenario-targeted wrapper');
    expect(doc).toContain('answer quality, evidence quality, and tool economy lanes');
    expect(doc).toContain('raw evidence status');
    expect(doc).toContain('cause codes');
    expect(doc).toContain('Tool-call sequence diagnostics');
  });

  it.skipIf(!hasMethodologyDoc)('methodology avoids universal claims', () => {
    const doc = fs.readFileSync(methodologyDoc, 'utf8');

    expect(doc).toContain('Scores compare measured scenarios only and do not prove universal superiority.');
    expect(doc).not.toMatch(/always better/i);
    expect(doc).not.toMatch(/SolidKG wins/i);
    expect(doc).not.toMatch(/guarantees/i);
    expect(doc).not.toMatch(/proves SolidKG/i);
  });
});
