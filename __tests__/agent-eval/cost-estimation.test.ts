import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const estimatorScript = path.join(repoRoot, 'scripts', 'agent-eval', 'estimate-answer-costs.mjs');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function runNode(...args: string[]) {
  return spawnSync(process.execPath, [estimatorScript, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

describe('answer-quality cost estimator', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('estimates input/output tokens and cost from captured run artifacts', async () => {
    const estimator = await import(pathToFileUrl(estimatorScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-cost-'));
    const runDir = path.join(tempDir, 'runs', 'case_solidkg');
    fs.mkdirSync(runDir, { recursive: true });
    const stderrPath = path.join(runDir, 'stderr.txt');
    const transcriptPath = path.join(runDir, 'transcript.jsonl');
    fs.writeFileSync(stderrPath, 'abcdefgh');
    fs.writeFileSync(transcriptPath, 'ijklmnop');
    const results = {
      schemaName: 'solidkg.llm-answer-quality.results.v1',
      model: 'stub-model',
      variant: 'medium',
      runs: [{
        id: 'case:r1:solidkg',
        armId: 'solidkg',
        status: 'pass',
        answer: 'qrstuvwx',
        stderrPath,
        transcriptPath,
        opencode: { argv: ['opencode', 'run', 'abcdefgh'] },
      }],
    };

    const report = estimator.buildCostEstimateReport(results, { charsPerToken: 4, inputUsdPerMTok: 2, outputUsdPerMTok: 6 });

    expect(report.perRunRows[0]).toMatchObject({ armId: 'solidkg', estimatedInputTokens: 6, estimatedOutputTokens: 2 });
    expect(report.perRunRows[0].estimatedCostUsd).toBeCloseTo(0.000024, 9);
    expect(report.aggregateByArm[0]).toMatchObject({ armId: 'solidkg', estimatedInputTokens: 6, estimatedOutputTokens: 2 });
  });

  it('writes JSON and Markdown artifacts from a results file', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-cost-cli-'));
    const runDir = path.join(tempDir, 'runs', 'case_grep');
    fs.mkdirSync(runDir, { recursive: true });
    const resultsPath = path.join(tempDir, 'results.json');
    const stderrPath = path.join(runDir, 'stderr.txt');
    const transcriptPath = path.join(runDir, 'transcript.jsonl');
    fs.writeFileSync(stderrPath, 'tool output');
    fs.writeFileSync(transcriptPath, '{"type":"final","content":"answer"}\n');
    fs.writeFileSync(resultsPath, JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.results.v1',
      model: 'stub-model',
      runs: [{ id: 'case:r1:grep_read', armId: 'grep_read', status: 'pass', answer: 'answer', stderrPath, transcriptPath, opencode: { argv: ['opencode', 'run', 'prompt'] } }],
    }));

    const result = runNode('--from-results', resultsPath, '--out', tempDir, '--input-usd-per-mtok', '2', '--output-usd-per-mtok', '6');

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-cost-estimate.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'llm-answer-cost-estimate.md'), 'utf8')).toContain('Estimated Cost');
  });
});
