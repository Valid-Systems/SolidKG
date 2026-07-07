import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'agent-eval', 'peer-structural-benchmark.mjs');
const validFixture = path.join(repoRoot, 'fixtures', 'peer-benchmark', 'sample-results.json');
const invalidFixture = path.join(repoRoot, 'fixtures', 'peer-benchmark', 'invalid-results.json');

function runHelper(...args: string[]) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('peer structural benchmark report', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('generates JSON, Markdown, and HTML artifacts from a valid structural-results fixture', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-peer-bench-'));

    const result = runHelper('--from-results', validFixture, '--out', tempDir);

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { ok: boolean; artifacts: { json: string; markdown: string; html: string } };
    expect(summary.ok).toBe(true);
    expect(fs.existsSync(summary.artifacts.json)).toBe(true);
    expect(fs.existsSync(summary.artifacts.markdown)).toBe(true);
    expect(fs.existsSync(summary.artifacts.html)).toBe(true);

    const report = JSON.parse(fs.readFileSync(summary.artifacts.json, 'utf8')) as {
      schemaName: string;
      peers: Array<{ id: string }>;
      scenarioSummaries: Array<{
        id: string;
        winnerPeerIds: string[];
        peerScores: Array<{ peerId: string; referenceCount: number; structuralScore: number; status: string }>;
        comparableReferences: boolean;
      }>;
      aggregateScores: Array<{ peerId: string; measuredScenarios: number }>;
      findings: string[];
      cleanup: { doNotRemoveAutomatically: string[] };
    };
    expect(report.schemaName).toBe('solidkg.peer-structural-benchmark.report.v1');
    expect(report.peers.map((peer) => peer.id).sort()).toEqual(['cartog', 'solidkg', 'sverklo', 'tilth']);
    const expectedPeers = ['cartog', 'solidkg', 'sverklo', 'tilth'];
    expect(report.scenarioSummaries).toHaveLength(10);
    for (const scenario of report.scenarioSummaries) {
      expect(scenario.peerScores).toHaveLength(4);
      expect(scenario.peerScores.map((score) => score.peerId).sort()).toEqual(expectedPeers);
      expect(scenario.peerScores.every((score) => score.status !== 'not_run')).toBe(true);
    }
    for (const aggregate of report.aggregateScores) {
      expect(aggregate.measuredScenarios).toBe(10);
    }
    expect(report.scenarioSummaries.find((scenario) => scenario.id === 'symbol-source-getNodeText')?.winnerPeerIds).toContain('sverklo');
    const impactScenario = report.scenarioSummaries.find((scenario) => scenario.id === 'impact-getNodeText');
    expect(impactScenario?.comparableReferences).toBe(false);
    expect(impactScenario?.peerScores.find((score) => score.peerId === 'solidkg')?.referenceCount).toBe(168);
    expect(report.findings.join('\n')).toContain('Fairness fix');
    expect(report.cleanup.doNotRemoveAutomatically).toContain('C:/Users/Me/.sverklo');

    const markdown = fs.readFileSync(summary.artifacts.markdown, 'utf8');
    const html = fs.readFileSync(summary.artifacts.html, 'utf8');
    expect(markdown).toContain('Peer Structural Benchmark');
    expect(markdown).toContain('Speed is secondary');
    expect(html).toContain('<svg');
    expect(html).toContain('Structural score');
  });

  it('rejects malformed input and writes no report artifacts', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-peer-bench-invalid-'));

    const result = runHelper('--from-results', invalidFixture, '--out', tempDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('peers must include at least one peer');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('preserves adjacent measured gaps instead of normalizing them away', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-peer-bench-gap-'));
    const result = runHelper('--from-results', validFixture, '--out', tempDir);
    expect(result.status, result.stderr).toBe(0);

    const summary = JSON.parse(result.stdout) as { artifacts: { json: string } };
    const report = JSON.parse(fs.readFileSync(summary.artifacts.json, 'utf8')) as {
      scenarioSummaries: Array<{
        id: string;
        peerScores: Array<{ peerId: string; referenceCount: number; structuralScore: number; notes: string[] }>;
      }>;
      findings: string[];
    };
    const callerScenario = report.scenarioSummaries.find((scenario) => scenario.id === 'callers-findRelevantContext');
    const solidkg = callerScenario?.peerScores.find((score) => score.peerId === 'solidkg');
    const tilth = callerScenario?.peerScores.find((score) => score.peerId === 'tilth');

    expect(solidkg?.referenceCount).toBe(1);
    expect(tilth?.referenceCount).toBe(6);
    expect((tilth?.structuralScore ?? 0)).toBeGreaterThan(solidkg?.structuralScore ?? 0);
    expect(report.findings.join('\n')).toContain('SolidKG gap');
  });

  it('keeps the existing offline realistic-baselines fixture runnable', () => {
    const output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'agent-eval', 'realistic-baselines.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as { schemaName: string; arms: Array<{ baselineKind: string }> };

    expect(parsed.schemaName).toBe('solidkg.realistic-agent-baselines.v1');
    expect(parsed.arms.map((arm) => arm.baselineKind).sort()).toEqual(['diff_read', 'rg_read', 'solidkg_context']);
  });
});


