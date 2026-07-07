import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'agent-eval', 'retrieval-plan-gate.mjs');
const fixtureDir = path.join(repoRoot, 'fixtures', 'retrieval-plan');

function runGate(fixtureName: string) {
  return spawnSync(process.execPath, [helperPath, path.join(fixtureDir, fixtureName)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('retrieval improvement plan gate', () => {
  it('accepts a fully evidenced retrieval candidate', () => {
    const result = runGate('valid-candidate.json');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('status: pass');
    expect(result.stdout).toContain('failureClass: dynamic_path_gap');
    expect(result.stdout).toContain('workstream: deterministic_dynamic_connectivity_bridges');
  });

  it('rejects candidates without reproducible evidence and kill criteria', () => {
    const result = runGate('missing-evidence.json');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: fail');
    expect(result.stderr).toContain('reproducibleFailure.observedFailure is required');
    expect(result.stderr).toContain('killCriteria must include at least one item');
  });

  it('rejects workstreams outside the six implementation workstreams', () => {
    const result = runGate('invalid-workstream.json');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: fail');
    expect(result.stderr).toContain('workstream must be one of deterministic_dynamic_connectivity_bridges');
  });

  it('rejects unbounded adaptive policies that can hide evidence or inflate budgets', async () => {
    const gate = await import(new URL(`file://${helperPath.replace(/\\/g, '/')}`).href);
    const candidate = {
      schemaName: 'solidkg.retrieval-improvement-candidate.v1',
      id: 'unsafe-adaptive-policy',
      title: 'Unsafe adaptive policy',
      failureClass: 'trace_explore_insufficiency',
      workstream: 'trace_explore_sufficiency',
      scopeBoundary: 'Diagnostic policy only.',
      reproducibleFailure: { repo: 'repo', repoRevision: 'abc123', prompt: 'Q', observedFailure: 'fallback loop', currentMainCommand: 'node probe.mjs' },
      baselineMetrics: { readCount: 1, grepCount: 1, toolCalls: 6, solidkgToolCalls: 4, wallClockMs: 1000, payloadBytes: 1000, graphGrowthPercent: 0, answerCompleteness: 'partial', sourceReferenceFidelity: 'source_partial' },
      targetMetrics: { readCount: 0, grepCount: 0, toolCalls: 5, solidkgToolCalls: 3, wallClockMs: 900, payloadBytes: 900, graphGrowthPercent: 0, answerCompleteness: 'complete', sourceReferenceFidelity: 'source_linked' },
      controls: [{ repo: 'control', prompt: 'Q', expected: 'no regression' }],
      killCriteria: ['Kill on any hidden fallback metrics.'],
      verificationCommands: { red: 'red', green: 'green', surface: 'surface', evaluation: 'evaluation', regression: 'regression' },
      adaptivePolicy: { enabledByDefault: true, canSuppressFallbackMetrics: true, maxPayloadBytes: 1200 },
    };

    expect(gate.validateCandidate(candidate)).toEqual(expect.arrayContaining([
      'adaptivePolicy.enabledByDefault must be false',
      'adaptivePolicy.canSuppressFallbackMetrics must be false',
      'adaptivePolicy.maxPayloadBytes must not exceed targetMetrics.payloadBytes',
      'adaptivePolicy.allowedStrategies must include at least one item',
      'adaptivePolicy.provenance is required',
    ]));
  });
});
