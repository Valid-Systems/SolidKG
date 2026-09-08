import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  formatArchitectureHealthReport,
  formatSnapshotHealthDrift,
} from '../src/mcp/architecture-health-formatters';
import type {
  ArchitectureHealthFinding,
  ArchitectureHealthMetricDelta,
  ArchitectureHealthReport,
  ArchitectureHealthSignalKind,
  SnapshotHealthDrift,
} from '../src/analysis';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'architecture-health-v1.json'), 'utf8')) as {
  report: ArchitectureHealthReport;
  drift: SnapshotHealthDrift;
};
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/;

function finding(input: {
  readonly id: string;
  readonly signalKind: ArchitectureHealthSignalKind;
  readonly subject: string;
  readonly efferentCoupling?: number;
  readonly afferentCoupling?: number;
}): ArchitectureHealthFinding {
  const facts = input.efferentCoupling === undefined
    ? []
    : [
      { key: 'afferent_coupling' as const, value: input.afferentCoupling ?? 0 },
      { key: 'efferent_coupling' as const, value: input.efferentCoupling },
    ];
  return {
    id: input.id,
    signalKind: input.signalKind,
    scope: input.signalKind === 'package_coupling' ? 'package' : 'file',
    subjects: [input.subject],
    facts,
    evidence: [],
  };
}

function reportWithFindings(
  signalKind: ArchitectureHealthSignalKind,
  findings: readonly ArchitectureHealthFinding[],
): ArchitectureHealthReport {
  return {
    ...fixture.report,
    signals: fixture.report.signals.map((signal) => signal.kind === signalKind
      ? { ...signal, findings: [...findings] }
      : signal),
  };
}

describe('architecture health formatters', () => {
  it('renders complete and partial reports coverage-first with metrics and evidence', () => {
    const output = formatArchitectureHealthReport(fixture.report);
    const coveragePosition = output.indexOf('## Coverage');
    const metricsPosition = output.indexOf('## Metrics');
    const findingsPosition = output.indexOf('## Findings');

    expect(output).toContain('## Architecture Health');
    expect(output).toContain('Analysis: architecture_health v1');
    expect(output).toContain('## Options');
    expect(coveragePosition).toBeGreaterThan(-1);
    expect(findingsPosition).toBeGreaterThan(coveragePosition);
    expect(metricsPosition).toBeGreaterThan(findingsPosition);
    expect(output).toContain('partial: static_unreferenced_candidate_only (1)');
    expect(output).toContain('packages/app/app.ts:12');
  });

  it('renders an explicit no-findings result without concealing coverage', () => {
    const output = formatArchitectureHealthReport(reportWithFindings('package_stable_dependency_violation', []));

    expect(output).toContain('## Coverage');
    expect(output).toContain('## Findings');
    expect(output).toContain('No findings.');
  });

  it('caps 21 findings at 20 while rendering no remainder at the 20-item boundary', () => {
    const items = Array.from({ length: 21 }, (_, index) => finding({
      id: `item-${String(index).padStart(2, '0')}`,
      signalKind: 'file_dependency_cycle',
      subject: `src/${String(index).padStart(2, '0')}.ts`,
    }));

    const atBoundary = formatArchitectureHealthReport(reportWithFindings('file_dependency_cycle', items.slice(0, 20)));
    const capped = formatArchitectureHealthReport(reportWithFindings('file_dependency_cycle', items));

    expect(atBoundary.match(/- \[item-/g)).toHaveLength(20);
    expect(atBoundary).not.toContain('+1 more');
    expect(capped.match(/- \[item-/g)).toHaveLength(20);
    expect(capped).toContain('- +1 more');
  });

  it('applies coupling rank before the finding cap while retaining subject order for other findings', () => {
    const coupling = [
      finding({ id: 'coupling-a', signalKind: 'package_coupling', subject: 'a', afferentCoupling: 9, efferentCoupling: 1 }),
      finding({ id: 'coupling-z', signalKind: 'package_coupling', subject: 'z', afferentCoupling: 1, efferentCoupling: 2 }),
    ];
    const files = [
      finding({ id: 'file-z', signalKind: 'file_dependency_cycle', subject: 'src/z.ts' }),
      finding({ id: 'file-a', signalKind: 'file_dependency_cycle', subject: 'src/a.ts' }),
    ];

    const couplingOutput = formatArchitectureHealthReport(reportWithFindings('package_coupling', coupling));
    const fileOutput = formatArchitectureHealthReport(reportWithFindings('file_dependency_cycle', files));

    expect(couplingOutput.indexOf('[coupling-z]')).toBeLessThan(couplingOutput.indexOf('[coupling-a]'));
    expect(fileOutput.indexOf('[file-a]')).toBeLessThan(fileOutput.indexOf('[file-z]'));
  });

  it('renders legacy and incompatible drift prominently with graph counts and without semantic sections', () => {
    const legacy = formatSnapshotHealthDrift({
      ...fixture.drift,
      comparisonStatus: 'baseline_analysis_unavailable',
      reasons: ['baseline_analysis_unavailable'],
      baselineCoverage: null,
      introduced: [],
      resolved: [],
      persisting: [],
      metricDeltas: [],
    });
    const incompatible = formatSnapshotHealthDrift({
      ...fixture.drift,
      comparisonStatus: 'incompatible_analysis',
      reasons: ['producer_identity_mismatch'],
      introduced: [],
      resolved: [],
      persisting: [],
      metricDeltas: [],
    });

    expect(legacy).toContain('Comparison: baseline_analysis_unavailable');
    expect(legacy).toContain('baseline_analysis_unavailable');
    expect(incompatible).toContain('Comparison: incompatible_analysis');
    expect(incompatible).toContain('producer_identity_mismatch');
    expect(incompatible).toContain('addedNodes:');
    expect(incompatible).not.toContain('## Introduced');
    expect(incompatible).not.toContain('## Metric Deltas');
  });

  it('renders compatible drift categories with caps and no ANSI escapes', () => {
    const category = (name: string) => Array.from({ length: 21 }, (_, index) => finding({
      id: `${name}-${String(index).padStart(2, '0')}`,
      signalKind: 'file_dependency_cycle',
      subject: `src/${String(index).padStart(2, '0')}.ts`,
    }));
    const metricDeltas: ArchitectureHealthMetricDelta[] = Array.from({ length: 21 }, () => ({
      kind: 'scalar',
      key: 'indexed_file_count',
      baseline: 1,
      current: 2,
      delta: 1,
    }));
    const output = formatSnapshotHealthDrift({
      ...fixture.drift,
      introduced: category('introduced'),
      resolved: category('resolved'),
      persisting: category('persisting'),
      metricDeltas,
    });

    expect(output).toContain('## Introduced (21)');
    expect(output.match(/- \[introduced-/g)).toHaveLength(20);
    expect(output).toContain('- +1 more');
    expect(output.match(/- \[resolved-/g)).toHaveLength(20);
    expect(output.match(/- \[persisting-/g)).toHaveLength(20);
    expect(output.match(/- indexed_file_count:/g)).toHaveLength(20);
    expect(output).not.toMatch(ANSI_ESCAPE_SEQUENCE);
  });
});
