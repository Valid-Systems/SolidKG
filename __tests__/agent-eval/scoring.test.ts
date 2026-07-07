import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const scenariosScript = path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs');
const armsScript = path.join(repoRoot, 'scripts', 'agent-eval', 'answer-arms.mjs');
const fixtureDir = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality');
const validScenarios = path.join(fixtureDir, 'sample-scenarios.json');
const invalidScenarios = path.join(fixtureDir, 'invalid-scenarios.json');
const sampleResults = path.join(fixtureDir, 'sample-results.json');
const invalidResults = path.join(fixtureDir, 'invalid-results.json');
const calibrationFixtures = path.join(fixtureDir, 'calibration-ordinal-fixtures.json');
const antiGamingFixtures = path.join(fixtureDir, 'anti-gaming-fixtures.json');

function runNode(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('answer-quality benchmark wave 1 contracts', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('validates answer-quality schemas and calibration planned runs', async () => {
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const arms = await import(pathToFileUrl(armsScript));
    const matrix = scenarios.loadScenarioMatrix(validScenarios);
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));

    expect(scenarios.validateScenarioMatrix(matrix, { profile: 'full' })).toEqual([]);
    expect(scenarios.validateAnswerQualityResults(results)).toEqual([]);
    expect(arms.validateAnswerArms(arms.getAnswerArms())).toEqual([]);
    expect(results.reportSchemaName).toBe('solidkg.llm-answer-quality.report.v1');
    expect(results.schemaName).toBe('solidkg.llm-answer-quality.results.v1');
    expect(results.plannedRunOrder).toHaveLength(5);
    expect(results.maxRuns).toBe(5);
    expect(results.confirmLive).toBe(false);
    expect(results.transcriptCapability.status).toBe('not_checked');
    expect(results.runs.every((run: { blockId?: string }) => typeof run.blockId === 'string' && run.blockId.length > 0)).toBe(true);

    const repoIds = matrix.repoMatrix.map((repo: { id: string }) => repo.id);
    expect(repoIds).toEqual(['ky', 'excalidraw', 'vscode', 'click', 'flask', 'django', 'cobra', 'gin', 'terraform']);
    expect(results.arms.map((arm: { id: string }) => arm.id)).toEqual(['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo']);
  });

  it('builds the required calibration, smoke, and full scenario profiles', () => {
    const calibration = runNode(scenariosScript, '--profile', 'calibration', '--validate');
    const smoke = runNode(scenariosScript, '--profile', 'smoke', '--validate');
    const full = runNode(scenariosScript, '--profile', 'full', '--validate');

    expect(calibration.status, calibration.stderr).toBe(0);
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(full.status, full.stderr).toBe(0);

    const calibrationSummary = JSON.parse(calibration.stdout) as { scenarioCount: number; plannedRunCount: number; plannedRunOrder: string[] };
    const smokeSummary = JSON.parse(smoke.stdout) as { scenarioCount: number; repoIds: string[]; scenarioKinds: string[] };
    const fullSummary = JSON.parse(full.stdout) as { scenarioCount: number; scenarioKinds: string[]; scenarios: Array<{ rubric: { evidenceProvenance: string; secondReviewedBy: string; secondReviewStatus: string } }> };

    expect(calibrationSummary.scenarioCount).toBe(1);
    expect(calibrationSummary.plannedRunCount).toBe(5);
    expect(calibrationSummary.plannedRunOrder).toHaveLength(5);
    expect(smokeSummary.scenarioCount).toBe(9);
    expect(smokeSummary.repoIds).toEqual(['ky', 'excalidraw', 'vscode', 'click', 'flask', 'django', 'cobra', 'gin', 'terraform']);
    expect(smokeSummary.scenarioKinds).toEqual(['architecture_flow']);
    expect(fullSummary.scenarioCount).toBe(27);
    expect(fullSummary.scenarioKinds.sort()).toEqual(['architecture_flow', 'entrypoint_to_core', 'failure_or_edge_path'].sort());
    expect(fullSummary.scenarios.every((scenario) => scenario.rubric.evidenceProvenance.length > 0)).toBe(true);
    expect(fullSummary.scenarios.every((scenario) => scenario.rubric.secondReviewedBy.length > 0)).toBe(true);
    expect(fullSummary.scenarios.every((scenario) => scenario.rubric.secondReviewStatus === 'approved')).toBe(true);
    expect(full.stdout.toLowerCase()).not.toMatch(/todo|draft_gold|placeholder/);
  });

  it('allows custom scenario files to target arbitrary local repo ids', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-custom-scenarios-'));
    const customScenarios = path.join(tempDir, 'custom-scenarios.json');
    fs.writeFileSync(customScenarios, JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.scenarios.v1',
      repoMatrix: [{ id: 'pallets__flask', language: 'Python', size: 'Medium', repoUrl: 'local' }],
      scenarios: [{
        id: 'pallets__flask-architecture_flow',
        repoId: 'pallets__flask',
        kind: 'architecture_flow',
        question: 'How does Flask route a WSGI request to a view function?',
        answerType: 'architecture flow explanation',
        rubric: {
          mustMention: ['wsgi_app', 'full_dispatch_request', 'dispatch_request'],
          expectedEvidence: [
            { id: 'flask-routing-ev1', file: 'src/flask/app.py', symbolHint: 'wsgi_app', claim: 'request enters Flask through wsgi_app' },
            { id: 'flask-routing-ev2', file: 'src/flask/app.py', symbolHint: 'dispatch_request', claim: 'dispatch_request calls the matched endpoint view' },
          ],
          forbiddenClaims: ['Do not claim benchmark performance from this scenario fixture'],
          minEvidenceAnchors: 2,
          evidenceProvenance: 'Authored from local reference corpus for bounded live rerun.',
          goldEvidenceProvenance: 'Offline authored rubric for custom local reference corpus rerun.',
          goldSecondReview: { reviewedBy: 'custom-scenario-reviewer', status: 'approved', reviewedAt: '2026-06-06T00:00:00.000Z', notes: 'Reviewed for source-backed evidence.' },
          secondReviewedBy: 'custom-scenario-reviewer',
          secondReviewStatus: 'approved',
        },
      }],
    }));

    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(customScenarios);
    expect(scenarios.validateScenarioMatrix(matrix, { profile: 'smoke' }).join('\n')).toContain('repoMatrix repo ids must be exactly');
    expect(scenarios.validateScenarioMatrix(matrix, { profile: 'smoke', ...scenarios.validationOptionsForScenarioFile(customScenarios) })).toEqual([]);

    const smoke = runNode(scenariosScript, '--profile', 'smoke', '--from-scenarios', customScenarios, '--validate');
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(JSON.parse(smoke.stdout).repoIds).toEqual(['pallets__flask']);
  });

  it('rejects missing goldSecondReview and unreviewed full-profile gold evidence', async () => {
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(invalidScenarios);
    const errors = scenarios.validateScenarioMatrix(matrix, { profile: 'full' });

    expect(errors.join('\n')).toContain('rubric.goldSecondReview is required');
    expect(errors.join('\n')).toContain('rubric.secondReviewStatus must be approved');
  });

  it('rejects malformed answer-quality input without writing output files', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-quality-invalid-'));
    const result = runNode(scenariosScript, '--from-results', invalidResults, '--out', tempDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reportSchemaName must be solidkg.llm-answer-quality.report.v1');
    expect(result.stderr).toContain('plannedRunOrder must be an array');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('defines exact answer-quality arms and explicit tool policies', async () => {
    const arms = await import(pathToFileUrl(armsScript));
    const definitions = arms.getAnswerArms();

    expect(definitions.map((arm: { id: string }) => arm.id)).toEqual(['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo']);
    for (const arm of definitions as Array<{ allowedTools: string[]; disallowedTools: string[]; policy: string; instructionSurface: string }>) {
      expect(arm.allowedTools.length).toBeGreaterThan(0);
      expect(Array.isArray(arm.disallowedTools)).toBe(true);
      expect(arm.policy.length).toBeGreaterThan(0);
      expect(arm.instructionSurface.length).toBeGreaterThan(0);
    }
    expect(definitions.find((arm: { id: string }) => arm.id === 'grep_read')?.disallowedTools).toEqual(['solidkg_mcp', 'tilth_wrapper', 'cartog_wrapper', 'sverklo_wrapper']);
    expect(definitions.find((arm: { id: string }) => arm.id === 'solidkg')?.allowedTools).toContain('solidkg_mcp');
  });

  it('renders fair scenario-targeted peer commands without hidden gold evidence hints', async () => {
    const arms = await import(pathToFileUrl(armsScript));
    const scenario = {
      repoId: 'gin',
      question: 'How does gin route requests through its middleware chain?',
      rubric: { expectedEvidence: [{ file: 'gin.go', symbolHint: 'handleHTTPRequest' }] },
    };
    const repoPath = 'D:/tmp/solidkg-corpus/gin';

    const tilth = arms.buildArmCommand('tilth', { repoPath, scenario, out: 'D:/tmp/answer-quality' });
    const cartog = arms.buildArmCommand('cartog', { repoPath, scenario, out: 'D:/tmp/answer-quality' });
    const sverklo = arms.buildArmCommand('sverklo', { repoPath, scenario, out: 'D:/tmp/answer-quality' });

    expect(tilth.command.join(' ')).toContain('How does gin route requests through its middleware chain?');
    expect(tilth.command.join(' ')).not.toContain('handleHTTPRequest');
    expect(tilth.command.join(' ')).not.toContain('gin.go');
    expect(cartog.command).toEqual(['cartog', '--db', 'D:/tmp/answer-quality/setup/cartog/gin.db', 'context', 'How does gin route requests through its middleware chain?', '--tokens', '5000']);
    expect(cartog.command.join(' ')).not.toContain('handleHTTPRequest');
    expect(cartog.setupCommand).toBeUndefined();
    expect(sverklo).toMatchObject({ status: 'unsupported', reason: 'scenario_query_not_supported', score: null, command: [] });
  });

  it('marks unsupported Sverklo query targeting and setup failures as reliability statuses', async () => {
    const arms = await import(pathToFileUrl(armsScript));
    const unsupported = arms.buildArmCommand('sverklo', {
      repoPath: 'D:/tmp/repo',
      scenario: { repoId: 'ky', question: 'How?' },
      sverkloSupportsScenarioQuery: false,
    });
    const setupFailed = arms.classifySetupResult('cartog', { statusCode: 1, stderr: 'not found' });
    const setupContract = arms.buildSetupContract('cartog', { repoPath: 'D:/tmp/repo', repoId: 'ky', out: 'D:/tmp/out' });

    expect(unsupported).toMatchObject({ status: 'unsupported', reason: 'scenario_query_not_supported', score: null });
    expect(setupFailed).toMatchObject({ status: 'setup_failed', score: null });
    expect(setupContract).toMatchObject({ armId: 'cartog', setupStatus: 'required', setupDurationMs: 0 });
    expect(setupContract.setupCommand.join(' ')).toContain('D:/tmp/repo');
    expect(setupContract.setupCommand.join(' ')).toContain('D:/tmp/out/setup/cartog/ky.db');
  });
});

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}
describe('answer-quality deterministic scorer', () => {
  it('scores correct evidenced answers highly', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(validScenarios);
    const scenario = matrix.scenarios.find((candidate: { id: string }) => candidate.id === 'ky-architecture_flow');
    const run = {
      status: 'pass',
      answer: 'Ky.create() calls ky.#retry(async () => ky.#fetch()) in source/core/Ky.ts. #calculateRetryDelay() enforces the retry limit, retry methods, retry status codes, shouldRetry, retryOnTimeout, Retry-After, maxRetryAfter, backoffLimit, delay, and jitter. source/utils/normalize.ts defines default retry settings. source/utils/timeout.ts aborts and rejects with TimeoutError when the timeout is exceeded. totalTimeout is tracked by #getRemainingTotalTimeout across hooks, retry delays, and attempts.',
      toolCalls: [{ tool: 'solidkg_trace' }],
      readCount: 0,
      grepCount: 0,
      fallbackLoopCount: 0,
    };

    const scored = scorer.scoreRun(run, scenario);

    expect(scored.score).toBeGreaterThanOrEqual(90);
    expect(scored.components.evidenceCoverage.matchedEvidenceIds).toEqual(['ky-architecture_flow-ev1', 'ky-architecture_flow-ev2', 'ky-architecture_flow-ev3']);
  });


  it('scores source-backed Ky retry and timeout answers against the calibration rubric', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(validScenarios);
    const scenario = matrix.scenarios.find((candidate: { id: string }) => candidate.id === 'ky-architecture_flow');
    const answer = 'Ky.create() calls ky.#retry(async () => ky.#fetch()) in source/core/Ky.ts. #calculateRetryDelay() enforces the retry limit, retry methods, retry status codes, shouldRetry, retryOnTimeout, Retry-After, maxRetryAfter, backoffLimit, delay, and jitter. source/utils/normalize.ts defines default retry settings. #fetch() wraps fetch with source/utils/timeout.ts, which aborts and rejects with TimeoutError. totalTimeout is tracked by #getRemainingTotalTimeout across hooks, retry delays, and attempts.';

    const scored = scorer.scoreRun({ status: 'pass', answer, toolCalls: [{ tool: 'solidkg_context' }], solidkgToolCalls: 1, readCount: 0, grepCount: 0, fallbackLoopCount: 0 }, scenario);

    expect(scored.score).toBeGreaterThanOrEqual(90);
    expect(scored.components.evidenceCoverage.points).toBe(100);
  });

  it('credits live Ky source-backed evidence when claim support is near symbol anchors', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(validScenarios);
    const scenario = matrix.scenarios.find((candidate: { id: string }) => candidate.id === 'ky-architecture_flow');
    const answer = 'Ky implements retries inside source/core/Ky.ts as a wrapper around fetch. Ky.create() runs beforeRequest hooks, then calls ky.#retry(async () => ky.#fetch()). #retry() catches errors from #fetch() and delegates to #retryFromError(). Retry policy is normalized in source/utils/normalize.ts: limit: 2, methods get put head delete options trace, statusCodes 408 413 429 500 502 503 504, delay attempt => 0.3 * (2 ** (attempt - 1)) * 1000, retryOnTimeout false. The retry decision happens in #calculateRetryDelay(): it stops when retryCount >= retry.limit, checks retry methods and status codes, honors shouldRetry, Retry-After, maxRetryAfter, backoffLimit, delay, and jitter, and TimeoutError retries only when retry.retryOnTimeout is true. Timeouts are implemented in source/utils/timeout.ts. #fetch() computes an effectiveTimeout and wraps fetch in timeout(), which aborts the controller and rejects with TimeoutError when the timeout is exceeded.';

    const scored = scorer.scoreRun({ status: 'pass', answer, toolCalls: [{ tool: 'solidkg_context' }], solidkgToolCalls: 1, readCount: 0, grepCount: 0, fallbackLoopCount: 0 }, scenario);

    expect(scored.components.evidenceCoverage.matchedEvidenceIds).toEqual(['ky-architecture_flow-ev1', 'ky-architecture_flow-ev2', 'ky-architecture_flow-ev3']);
    expect(scored.components.evidenceCoverage.points).toBe(100);
  });
  it('does not count generic symbol-only evidence mentions as evidence anchors', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenario = {
      rubric: {
        mustMention: ['dispatch'],
        expectedEvidence: [{ id: 'ev1', file: 'source/core/Ky.ts', symbolHint: 'dispatch', claim: 'dispatches request' }],
        forbiddenClaims: [],
        minEvidenceAnchors: 1,
      },
    };
    const scored = scorer.scoreRun({ status: 'pass', answer: 'This uses dispatch but gives no file or evidence id.', toolCalls: [] }, scenario);

    expect(scored.components.evidenceCoverage.points).toBe(0);
    expect(scored.components.evidenceCoverage.missingEvidenceIds).toEqual(['ev1']);
  });

  it('credits source-backed file and claim evidence without exact evidence ids', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenario = {
      rubric: {
        mustMention: ['executeLiveBenchmark', 'parseOpenCodeTranscriptText', 'scoreResults'],
        expectedEvidence: [
          { id: 'ev1', file: 'scripts/agent-eval/opencode-answer-benchmark.mjs', symbolHint: 'executeLiveBenchmark', claim: 'runs OpenCode, writes run artifacts, parses transcripts, and appends run rows' },
          { id: 'ev2', file: 'scripts/agent-eval/parse-opencode-transcript.mjs', symbolHint: 'parseOpenCodeTranscriptText', claim: 'normalizes OpenCode JSONL into final answers, tool calls, and metrics' },
          { id: 'ev3', file: 'scripts/agent-eval/score-answer-quality.mjs', symbolHint: 'scoreResults', claim: 'converts parsed run rows into deterministic quality scores' },
        ],
        forbiddenClaims: [],
        minEvidenceAnchors: 2,
      },
    };
    const answer = 'opencode-answer-benchmark.mjs runs OpenCode, writes run artifacts, parses transcripts, and appends run rows. parse-opencode-transcript.mjs normalizes OpenCode JSONL into final answers, tool calls, and metrics. score-answer-quality.mjs converts parsed run rows into deterministic quality scores.';

    const scored = scorer.scoreRun({ status: 'pass', answer, toolCalls: [{ tool: 'read' }] }, scenario);

    expect(scored.components.evidenceCoverage.matchedEvidenceIds).toEqual(['ev1', 'ev2', 'ev3']);
    expect(scored.components.evidenceCoverage.points).toBe(100);
    expect(scored.components.evidenceCoverage.matchDetails).toEqual([
      { evidenceId: 'ev1', matchMode: 'file_claim', fileMatched: true, symbolMatched: false, claimMatched: true, idMatched: false },
      { evidenceId: 'ev2', matchMode: 'file_claim', fileMatched: true, symbolMatched: false, claimMatched: true, idMatched: false },
      { evidenceId: 'ev3', matchMode: 'file_claim', fileMatched: true, symbolMatched: false, claimMatched: true, idMatched: false },
    ]);
  });


  it('marks symbolMatched true when the answer explicitly names the symbol hint', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenario = {
      rubric: {
        mustMention: ['executeLiveBenchmark'],
        expectedEvidence: [{ id: 'ev1', file: 'scripts/agent-eval/opencode-answer-benchmark.mjs', symbolHint: 'executeLiveBenchmark', claim: 'writes artifacts, parses transcripts, and appends rows' }],
        forbiddenClaims: [],
        minEvidenceAnchors: 1,
      },
    };

    const scored = scorer.scoreRun({ status: 'pass', answer: 'executeLiveBenchmark in opencode-answer-benchmark.mjs writes artifacts, parses transcripts, and appends rows.', toolCalls: [] }, scenario);

    expect(scored.components.evidenceCoverage.matchedEvidenceIds).toEqual(['ev1']);
    expect(scored.components.evidenceCoverage.matchDetails[0]).toMatchObject({ matchMode: 'file_symbol_claim', fileMatched: true, symbolMatched: true, claimMatched: true, idMatched: false });
  });
  it('penalizes excessive SolidKG over-drilling even without local read fallback', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const toolCalls = Array.from({ length: 34 }, () => ({ tool: 'solidkg_solidkg_context' }));

    const scored = scorer.scoreRun({
      status: 'pass',
      answer: 'executeLiveBenchmark parseOpenCodeTranscriptText scoreResults opencode-answer-benchmark.mjs parse-opencode-transcript.mjs score-answer-quality.mjs',
      toolCalls,
      solidkgToolCalls: 34,
      readCount: 0,
      grepCount: 0,
      bashCount: 0,
      fallbackLoopCount: 0,
    }, {
      rubric: {
        mustMention: ['executeLiveBenchmark', 'parseOpenCodeTranscriptText', 'scoreResults'],
        expectedEvidence: [{ id: 'ev1', file: 'scripts/agent-eval/opencode-answer-benchmark.mjs' }],
        forbiddenClaims: [],
        minEvidenceAnchors: 1,
      },
    });

    expect(scored.components.fallbackEfficiency.points).toBeLessThanOrEqual(45);
    expect(scored.score).toBeLessThanOrEqual(80);
    expect(scored.notes).toContain('excessive_solidkg_tool_calls');
  });

  it('separates answer quality evidence quality tool economy and diagnostic composite lanes', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scored = scorer.scoreRun({
      status: 'pass',
      answer: 'executeLiveBenchmark explains the run loop. It writes artifacts, parses transcripts, and appends rows using opencode-answer-benchmark.mjs.',
      toolCalls: Array.from({ length: 20 }, () => ({ tool: 'solidkg_solidkg_node' })),
      solidkgToolCalls: 20,
      readCount: 0,
      grepCount: 0,
      bashCount: 0,
    }, {
      rubric: {
        mustMention: ['executeLiveBenchmark'],
        expectedEvidence: [{ id: 'ev1', file: 'scripts/agent-eval/opencode-answer-benchmark.mjs', symbolHint: 'executeLiveBenchmark', claim: 'writes artifacts, parses transcripts, and appends rows' }],
        forbiddenClaims: [],
        minEvidenceAnchors: 1,
      },
    });

    expect(scored.answerQualityScore).toBeGreaterThan(0);
    expect(scored.evidenceQualityScore).toBe(100);
    expect(scored.toolEconomyScore).toBeLessThan(100);
    expect(scored.diagnosticCompositeScore).toBe(scored.score);
    expect(scored.lanes).toMatchObject({ answerQualityScore: scored.answerQualityScore, evidenceQualityScore: 100, toolEconomyScore: scored.toolEconomyScore });
  });

  it('rejects fake file-name evidence stuffing without coherent source claims', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenario = {
      rubric: {
        mustMention: ['executeLiveBenchmark'],
        expectedEvidence: [{ id: 'ev1', file: 'scripts/agent-eval/opencode-answer-benchmark.mjs', symbolHint: 'executeLiveBenchmark', claim: 'writes artifacts, parses transcripts, and appends rows' }],
        forbiddenClaims: [],
        minEvidenceAnchors: 1,
      },
    };

    const stuffed = scorer.scoreRun({ status: 'pass', answer: 'executeLiveBenchmark opencode-answer-benchmark.mjs opencode-answer-benchmark.mjs opencode-answer-benchmark.mjs', toolCalls: [] }, scenario);
    const coherent = scorer.scoreRun({ status: 'pass', answer: 'executeLiveBenchmark in opencode-answer-benchmark.mjs writes artifacts, parses transcripts, and appends rows.', toolCalls: [] }, scenario);

    expect(stuffed.evidenceQualityScore).toBe(0);
    expect(stuffed.score).toBeLessThan(coherent.score);
    expect(coherent.evidenceQualityScore).toBe(100);
  });

  it('keeps locked manual calibration ordinal fixtures within expected score bands', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const fixtures = JSON.parse(fs.readFileSync(calibrationFixtures, 'utf8'));
    const fixtureCase = fixtures.cases[0];
    const scores = new Map<string, number>();

    for (const entry of fixtureCase.runs) {
      const scored = scorer.scoreRun(entry.run, fixtureCase.scenario);
      scores.set(entry.id, scored.score);
      expect(scored.score).toBeGreaterThanOrEqual(entry.expectedBand[0]);
      expect(scored.score).toBeLessThanOrEqual(entry.expectedBand[1]);
    }
    for (const [left, op, right] of fixtureCase.expectedComparisons) {
      if (op === '>') expect(scores.get(left)).toBeGreaterThan(scores.get(right));
      else if (op === '>=') expect(scores.get(left)).toBeGreaterThanOrEqual(scores.get(right));
    }
  });

  it('keeps anti-gaming fixtures from rewarding token stuffing', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const fixtures = JSON.parse(fs.readFileSync(antiGamingFixtures, 'utf8'));

    for (const fixture of fixtures.cases) {
      const scored = scorer.scoreRun(fixture.run, fixtures.scenario);
      if (typeof fixture.maxEvidenceQualityScore === 'number') expect(scored.evidenceQualityScore).toBeLessThanOrEqual(fixture.maxEvidenceQualityScore);
      if (typeof fixture.minEvidenceQualityScore === 'number') expect(scored.evidenceQualityScore).toBeGreaterThanOrEqual(fixture.minEvidenceQualityScore);
    }
  });

  it('penalizes forbidden claims', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scenarios = await import(pathToFileUrl(scenariosScript));
    const matrix = scenarios.loadScenarioMatrix(validScenarios);
    const scenario = matrix.scenarios.find((candidate: { id: string }) => candidate.id === 'ky-architecture_flow');
    const run = {
      status: 'pass',
      answer: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence anchors source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 shows ky architecture flow evidence 1, and ky-architecture_flow-ev2 shows ky architecture flow evidence 2. This proves benchmark performance from this scenario fixture and runtime behavior without source evidence.',
      toolCalls: [{ tool: 'read' }, { tool: 'read' }, { tool: 'rg' }, { tool: 'bash' }, { tool: 'read' }, { tool: 'read' }],
      readCount: 4,
      grepCount: 1,
      bashCount: 1,
      fallbackLoopCount: 0,
    };

    const scored = scorer.scoreRun(run, scenario);

    expect(scored.score).toBeLessThanOrEqual(60);
    expect(scored.components.forbiddenClaimAvoidance.forbiddenHits.length).toBeGreaterThan(0);
  });

  it('counts rg launched through bash as grep fallback', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const scored = scorer.scoreRun({ status: 'pass', answer: 'answer text with enough words to avoid tiny-answer penalty', toolCalls: [{ tool: 'bash', input: { command: 'rg "needle" src' } }] }, { rubric: { mustMention: [], expectedEvidence: [], forbiddenClaims: [] } });

    expect(scored.components.fallbackEfficiency.metrics.bashCount).toBe(1);
    expect(scored.components.fallbackEfficiency.metrics.grepCount).toBe(1);
  });

  it('keeps setup failures score-null and counts reliability failure', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const scored = scorer.scoreResults(results);
    const setupFailed = scored.runs.find((run: { status: string }) => run.status === 'setup_failed');
    const cartogReliability = scored.reliability.find((row: { armId: string }) => row.armId === 'cartog');

    expect(setupFailed.score).toBeNull();
    expect(setupFailed.scoring.qualityIncluded).toBe(false);
    expect(cartogReliability.setup_failed).toBe(1);
    expect(cartogReliability.successRate).toBe(0);
  });

  it('excludes fail status from quality averages and keeps it visible in reliability', async () => {
    const scorer = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'score-answer-quality.mjs')));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    results.runs = [{ ...results.runs[0], status: 'fail', reliabilityStatus: 'fail', score: 99 }];
    results.plannedRunOrder = [results.runs[0].id];

    const scored = scorer.scoreResults(results);

    expect(scored.runs[0].score).toBeNull();
    expect(scored.runs[0].scoring.qualityIncluded).toBe(false);
    expect(scored.aggregateQuality.find((row: { armId: string }) => row.armId === scored.runs[0].armId)).toBeUndefined();
    expect(scored.reliability.find((row: { armId: string }) => row.armId === scored.runs[0].armId).fail).toBe(1);
  });
});
