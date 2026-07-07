import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const judgeScript = path.join(repoRoot, 'scripts', 'agent-eval', 'judge-opencode-answer.mjs');
const reportScript = path.join(repoRoot, 'scripts', 'agent-eval', 'report-answer-quality.mjs');
const sampleResults = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality', 'sample-results.json');
const banned = ['solidkg', 'tilth', 'cartog', 'sverklo', 'grep_read', 'baseline'];

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

describe('blinded OpenCode answer judge', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('blinds arm identity and tool brand names', async () => {
    const judge = await import(pathToFileUrl(judgeScript));
    const run = {
      scenarioId: 'solidkg-baseline-sverklo-case',
      armId: 'solidkg',
      score: 91,
      answer: 'The solidkg answer used tilth, cartog, sverklo, grep_read and baseline labels in source notes.',
    };
    const scenario = {
      id: 'tilth-scenario',
      question: 'Compare solidkg with cartog?',
      answerType: 'flow answer',
      rubric: {
        mustMention: ['solidkg term must be redacted'],
        expectedEvidence: [{ file: 'cartog/file.ts', symbolHint: 'sverklo', claim: 'tilth provenance' }],
        forbiddenClaims: ['baseline claim'],
        evidenceProvenance: 'solidkg tilth cartog sverklo grep_read baseline',
      },
    };

    const packet = judge.buildJudgePacket({ run, scenario });
    const prompt = judge.buildJudgePrompt(packet);
    const lower = prompt.toLowerCase();

    for (const term of banned) expect(lower).not.toContain(term);
  });

  it('attaches judge secondaryScore without overwriting deterministic score', async () => {
    const judge = await import(pathToFileUrl(judgeScript));
    const run = { status: 'pass', score: 87, answer: 'answer' };
    const judged = judge.attachJudgeResult(run, { status: 'pass', secondaryScore: 73, confidence: 0.8, comments: 'secondary only' });

    expect(judged.score).toBe(87);
    expect(judged.judge.secondaryScore).toBe(73);
    expect(judged.judge.status).toBe('pass');
  });

  it('keeps deterministic report when judge fails', async () => {
    const judge = await import(pathToFileUrl(judgeScript));
    const reporter = await import(pathToFileUrl(reportScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-judge-fail-'));
    const results = JSON.parse(fs.readFileSync(sampleResults, 'utf8'));
    const scenario = { id: 'ky-architecture_flow', question: 'Question', answerType: 'flow', rubric: { mustMention: [], expectedEvidence: [], forbiddenClaims: [], minEvidenceAnchors: 1 } };
    const judged = judge.judgeRun({ run: results.runs[0], scenario, opencodeBin: path.join(tempDir, 'missing-opencode.exe'), dryRun: false, confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 });
    results.runs[0] = judged;

    const { report } = reporter.writeAnswerQualityReport({ results, out: tempDir });

    expect(judged.score).toBeUndefined();
    expect(judged.judge.status).toBe('runner_failed');
    expect(report.perRunRows[0].judgeSecondaryScore).toBeNull();
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-quality.json'))).toBe(true);
  });

  it('defaults standalone judge execution to dry-run and blocks live without explicit caps', async () => {
    const judge = await import(pathToFileUrl(judgeScript));
    const run = { status: 'pass', answer: 'answer' };
    const scenario = { id: 'scenario', question: 'Question', rubric: { mustMention: [], expectedEvidence: [], forbiddenClaims: [] } };

    const dry = judge.judgeRun({ run, scenario, opencodeBin: path.join(os.tmpdir(), 'missing-opencode') });
    const blocked = judge.judgeRun({ run, scenario, opencodeBin: path.join(os.tmpdir(), 'missing-opencode'), dryRun: false, confirmLive: true, maxRuns: 1 });

    expect(dry.judge.status).toBe('dry_run');
    expect(blocked.judge.status).toBe('runner_failed');
    expect(blocked.judge.reason).toBe('judge_live_guard_failed');
    expect(blocked.judge.comments).toContain('--max-estimated-cost-usd');
  });
});
