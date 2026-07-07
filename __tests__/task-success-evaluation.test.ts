import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'agent-eval', 'task-success.mjs');
const passFixture = path.join(repoRoot, 'fixtures', 'task-success', 'pass-results.json');
const fallbackFixture = path.join(repoRoot, 'fixtures', 'task-success', 'fallback-results.json');
const invalidFixture = path.join(repoRoot, 'fixtures', 'task-success', 'invalid-results.json');

function runHelper(...args: string[]) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('task-success evaluation harness', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('scores a fixture as pass when expected evidence is present and fallback is bounded', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-task-success-pass-'));
    const result = runHelper('--from-results', passFixture, '--out', tempDir);

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { ok: boolean; artifacts: { json: string; markdown: string } };
    expect(summary.ok).toBe(true);
    const report = JSON.parse(fs.readFileSync(summary.artifacts.json, 'utf8')) as {
      schemaName: string;
      status: string;
      fallbackMetrics: { readCount: number; grepCount: number; solidkgCalls: number; fallbackRate: number; fallbackBreach: boolean };
      scenarioSummaries: Array<{ id: string; status: string; evidenceCoverage: number }>;
    };

    expect(report.schemaName).toBe('solidkg.task-success-eval.v1');
    expect(report.status).toBe('pass');
    expect(report.fallbackMetrics).toMatchObject({
      readCount: 0,
      grepCount: 0,
      solidkgCalls: 2,
      fallbackRate: 0,
      fallbackBreach: false,
    });
    expect(report.scenarioSummaries).toEqual([
      expect.objectContaining({ id: 'tiny-context-happy-path', status: 'pass', evidenceCoverage: 1 }),
    ]);
    expect(fs.readFileSync(summary.artifacts.markdown, 'utf8')).toContain('Task Success Evaluation');
  });

  it('keeps valid fallback-heavy results parseable while marking the run as fail', () => {
    const result = runHelper('--from-results', fallbackFixture);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      status: string;
      fallbackMetrics: { readCount: number; grepCount: number; fallbackBreach: boolean };
      scenarioSummaries: Array<{ status: string; missingEvidenceIds: string[] }>;
    };
    expect(report.status).toBe('fail');
    expect(report.fallbackMetrics).toMatchObject({ readCount: 2, grepCount: 1, fallbackBreach: true });
    expect(report.scenarioSummaries[0]).toMatchObject({
      status: 'fail',
      missingEvidenceIds: ['ev_checkout_submit_order'],
    });
  });

  it('rejects malformed task-success fixtures with bounded validation errors', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-task-success-invalid-'));
    const result = runHelper('--from-results', invalidFixture, '--out', tempDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('schemaName must be solidkg.task-success-results.v1');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
