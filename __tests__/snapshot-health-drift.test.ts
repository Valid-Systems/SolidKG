import { describe, expect, it } from 'vitest';
import { compareSnapshotHealthDrift } from '../src/analysis/architecture-health-drift';
import { createCoverageFingerprint } from '../src/analysis/architecture-health-normalization';
import { ARCHITECTURE_HEALTH_SIGNAL_KINDS, type ArchitectureHealthCoverage, type ArchitectureHealthFinding, type ArchitectureHealthMetric, type ArchitectureHealthObservedGraphFacts, type ArchitectureHealthProducerIdentity, type ArchitectureHealthReport, type ArchitectureHealthScalarMetricKey, type ArchitectureHealthSignal, type ArchitectureHealthSignalKind, type NormalizedArchitectureHealthOptions, type SnapshotDiffCounts, type SnapshotHealthDriftReasonCode } from '../src/analysis/architecture-health-types';

type DriftProducer = Omit<ArchitectureHealthProducerIdentity, 'graphFactPolicy'> & { graphFactPolicy: string };
type DriftReport = Omit<ArchitectureHealthReport, 'analysisVersion' | 'producer'> & { analysisVersion: number; producer: DriftProducer };
type CouplingMetric = Extract<ArchitectureHealthMetric, { kind: 'coupling' }>;

const scalarKeys = ['indexed_file_count', 'index_error_file_count', 'unresolved_reference_count', 'file_dependency_cycle_count', 'package_dependency_cycle_count', 'layer_dependency_cycle_count', 'package_stable_dependency_violation_count', 'layer_stable_dependency_violation_count', 'manifest_unassigned_file_count', 'layer_unassigned_file_count', 'static_unreferenced_candidate_count'] as const satisfies readonly ArchitectureHealthScalarMetricKey[];

const graphDiffCounts: SnapshotDiffCounts = { addedNodes: 1, removedNodes: 2, changedNodes: 3, addedEdges: 4, removedEdges: 5, changedEdges: 6, addedHyperedges: 7, removedHyperedges: 8, changedHyperedges: 9, addedHyperedgeMembers: 10, removedHyperedgeMembers: 11, changedHyperedgeMembers: 12 };

function coverage(input: {
  status?: ArchitectureHealthCoverage['status'];
  reasons?: ArchitectureHealthCoverage['reasons'];
  relevantErrorFilePaths?: ArchitectureHealthCoverage['relevantErrorFilePaths'];
  relevantUnresolvedReferenceKeys?: ArchitectureHealthCoverage['relevantUnresolvedReferenceKeys'];
  consumedProvenance?: ArchitectureHealthCoverage['consumedProvenance'];
} = {}): ArchitectureHealthCoverage {
  const status = input.status ?? 'complete';
  const reasons = input.reasons ?? [];
  const relevantErrorFilePaths = input.relevantErrorFilePaths ?? [];
  const relevantUnresolvedReferenceKeys = input.relevantUnresolvedReferenceKeys ?? [];
  return {
    status,
    reasons,
    relevantErrorFilePaths,
    relevantUnresolvedReferenceKeys,
    consumedProvenance: input.consumedProvenance ?? [],
    degradationFingerprint: createCoverageFingerprint(
      status,
      reasons,
      relevantErrorFilePaths,
      relevantUnresolvedReferenceKeys,
    ),
  };
}

function finding(input: {
  id: string;
  signalKind: ArchitectureHealthSignalKind;
  scope?: ArchitectureHealthFinding['scope'];
  subjects?: string[];
  facts?: ArchitectureHealthFinding['facts'];
}): ArchitectureHealthFinding {
  return { id: input.id, signalKind: input.signalKind, scope: input.scope ?? 'file', subjects: input.subjects ?? [input.id], facts: input.facts ?? [], evidence: [] };
}

function couplingFinding(input: { id: string; name: string; afferent: number; efferent: number; instability?: number }): ArchitectureHealthFinding {
  return finding({
    id: input.id,
    signalKind: 'package_coupling',
    scope: 'package',
    subjects: [input.name],
    facts: [
      { key: 'afferent_coupling', value: input.afferent },
      { key: 'efferent_coupling', value: input.efferent },
      { key: 'instability', value: input.instability ?? 0 },
    ],
  });
}

function signal(input: { kind: ArchitectureHealthSignalKind; coverage?: ArchitectureHealthCoverage; findings?: ArchitectureHealthFinding[] }): ArchitectureHealthSignal {
  return { kind: input.kind, coverage: input.coverage ?? coverage(), findings: input.findings ?? [] };
}

function signalsWith(...replacements: ArchitectureHealthSignal[]): ArchitectureHealthSignal[] {
  const byKind = new Map(replacements.map((replacement) => [replacement.kind, replacement]));
  return ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((kind) => byKind.get(kind) ?? signal({ kind }));
}

function observedGraphFacts(input: Partial<ArchitectureHealthObservedGraphFacts> = {}): ArchitectureHealthObservedGraphFacts {
  return {
    edgeKinds: input.edgeKinds ?? [],
    edgeProvenanceCounts: input.edgeProvenanceCounts ?? [],
    scip: input.scip ?? { status: 'unavailable', documentCount: 0, occurrenceCount: 0, relationshipCount: 0 },
  };
}

function report(input: {
  analysisVersion?: number;
  options?: NormalizedArchitectureHealthOptions;
  producer?: DriftProducer;
  observedGraphFacts?: ArchitectureHealthObservedGraphFacts;
  scalars?: Partial<Record<ArchitectureHealthScalarMetricKey, number>>;
  coupling?: CouplingMetric[];
  signals?: ArchitectureHealthSignal[];
} = {}): DriftReport {
  const metrics: ArchitectureHealthMetric[] = scalarKeys.map((key): ArchitectureHealthMetric => ({ kind: 'scalar', key, value: input.scalars?.[key] ?? 0 }));
  metrics.push(...(input.coupling ?? []));
  return {
    analysisKind: 'architecture_health',
    analysisVersion: input.analysisVersion ?? 1,
    options: input.options ?? { layers: [] },
    producer: input.producer ?? { solidkgVersion: '1.0.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v1' },
    observedGraphFacts: input.observedGraphFacts ?? observedGraphFacts(),
    metrics,
    signals: input.signals ?? signalsWith(),
  };
}

function compare(baseline: DriftReport | null, current: DriftReport) {
  return compareSnapshotHealthDrift({ baselineLabel: 'baseline', baseline, current, graphDiffCounts });
}

describe('snapshot health drift', () => {
  it('returns an unavailable baseline result without semantic deltas', () => {
    const current = report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', findings: [finding({ id: 'current', signalKind: 'file_dependency_cycle' })] })) });

    const drift = compare(null, current);

    expect(drift.comparisonStatus).toBe('baseline_analysis_unavailable');
    expect(drift.reasons).toEqual(['baseline_analysis_unavailable']);
    expect(drift.baselineCoverage).toBeNull();
    expect(drift.currentCoverage).toHaveLength(ARCHITECTURE_HEALTH_SIGNAL_KINDS.length);
    expect(drift.graphDiffCounts).toEqual(graphDiffCounts);
    expect([drift.omittedSignals, drift.introduced, drift.resolved, drift.persisting, drift.metricDeltas]).toEqual([[], [], [], [], []]);
  });

  const globalMismatchCases: Array<{ title: string; baseline: DriftReport; current: DriftReport; reason: SnapshotHealthDriftReasonCode }> = [
    { title: 'analyzer version', baseline: report({ analysisVersion: 2 }), current: report(), reason: 'analysis_version_mismatch' },
    { title: 'normalized options', baseline: report({ options: { layers: [{ name: 'app', paths: ['src/**'] }] } }), current: report(), reason: 'normalized_options_mismatch' },
    { title: 'graph fact policy', baseline: report({ producer: { solidkgVersion: '1.0.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v1' } }), current: report({ producer: { solidkgVersion: '1.0.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v2' } }), reason: 'graph_fact_policy_mismatch' },
    { title: 'SolidKG producer identity', baseline: report({ producer: { solidkgVersion: '0.9.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v1' } }), current: report(), reason: 'producer_identity_mismatch' },
    { title: 'schema producer identity', baseline: report({ producer: { solidkgVersion: '1.0.0', schemaVersion: 10, graphFactPolicy: 'all_indexed_architecture_edges_v1' } }), current: report(), reason: 'producer_identity_mismatch' },
  ];

  for (const mismatch of globalMismatchCases) {
    it(`suppresses semantic results for a ${mismatch.title} mismatch`, () => {
      const drift = compare(mismatch.baseline, mismatch.current);

      expect(drift.comparisonStatus).toBe('incompatible_analysis');
      expect(drift.reasons).toEqual([mismatch.reason]);
      expect(drift.graphDiffCounts).toEqual(graphDiffCounts);
      expect([drift.omittedSignals, drift.introduced, drift.resolved, drift.persisting, drift.metricDeltas]).toEqual([[], [], [], [], []]);
    });
  }

  it('keeps source drift comparable when observed graph facts and unused SCIP state change', () => {
    const introduced = finding({ id: 'introduced', signalKind: 'file_dependency_cycle', subjects: ['src/new.ts'] });
    const baseline = report({ observedGraphFacts: observedGraphFacts({ scip: { status: 'unavailable', documentCount: 0, occurrenceCount: 0, relationshipCount: 0 } }) });
    const current = report({
      observedGraphFacts: observedGraphFacts({ edgeKinds: ['calls'], edgeProvenanceCounts: [{ provenance: 'heuristic', count: 3 }], scip: { status: 'linked', documentCount: 2, occurrenceCount: 3, relationshipCount: 4 } }),
      signals: signalsWith(signal({ kind: 'file_dependency_cycle', findings: [introduced] })),
    });

    const drift = compare(baseline, current);

    expect(drift.comparisonStatus).toBe('comparable');
    expect(drift.reasons).toEqual([]);
    expect(drift.introduced).toEqual([introduced]);
  });

  it('omits only SCIP-consuming signals when SCIP status changes', () => {
    const scipCoverage = coverage({ consumedProvenance: ['scip'] });
    const visible = finding({ id: 'visible', signalKind: 'package_dependency_cycle', subjects: ['package-visible'] });
    const baseline = report({
      observedGraphFacts: observedGraphFacts({ scip: { status: 'unavailable', documentCount: 0, occurrenceCount: 0, relationshipCount: 0 } }),
      signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: scipCoverage })),
    });
    const current = report({
      observedGraphFacts: observedGraphFacts({ scip: { status: 'linked', documentCount: 1, occurrenceCount: 2, relationshipCount: 3 } }),
      signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: scipCoverage }), signal({ kind: 'package_dependency_cycle', findings: [visible] })),
    });

    const drift = compare(baseline, current);

    expect(drift.comparisonStatus).toBe('partially_compatible');
    expect(drift.omittedSignals).toEqual([{ signalKind: 'file_dependency_cycle', reasons: ['scip_descriptor_mismatch'] }]);
    expect(drift.introduced).toEqual([visible]);
  });

  it('compares equal partial degradation and omits unequal degradation with exact reasons', () => {
    const partial = coverage({ status: 'partial', reasons: [{ code: 'index_errors_present', count: 1 }] });
    const introduced = finding({ id: 'partial-introduced', signalKind: 'file_dependency_cycle' });
    const equal = compare(
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: partial })) }),
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: partial, findings: [introduced] })) }),
    );
    const unequal = compare(
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: partial })) }),
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: coverage({ status: 'complete' }), findings: [introduced] })) }),
    );

    expect(equal.comparisonStatus).toBe('comparable');
    expect(equal.introduced).toEqual([introduced]);
    expect(unequal.comparisonStatus).toBe('partially_compatible');
    expect(unequal.omittedSignals).toEqual([{
      signalKind: 'file_dependency_cycle',
      reasons: ['coverage_fingerprint_mismatch', 'coverage_reason_mismatch', 'coverage_status_mismatch'],
    }]);
    expect(unequal.introduced).toEqual([]);
  });

  it('uses current payloads and current coupling rank while reversing direction on input swap', () => {
    const resolved = finding({ id: 'resolved-file', signalKind: 'file_dependency_cycle', subjects: ['src/resolved.ts'] });
    const persistentBaseline = finding({ id: 'persistent-file', signalKind: 'file_dependency_cycle', subjects: ['src/persistent.ts'], facts: [{ key: 'instability', value: 1 }] });
    const persistentCurrent = finding({ id: 'persistent-file', signalKind: 'file_dependency_cycle', subjects: ['src/persistent.ts'], facts: [{ key: 'instability', value: 2 }] });
    const introduced = finding({ id: 'introduced-file', signalKind: 'file_dependency_cycle', subjects: ['src/introduced.ts'] });
    const baseline = report({
      scalars: { indexed_file_count: 10 },
      coupling: [
        { kind: 'coupling', scope: 'package', name: 'removed', afferentCoupling: 2, efferentCoupling: 1, instability: 0.5 },
        { kind: 'coupling', scope: 'package', name: 'shared', afferentCoupling: 1, efferentCoupling: 2, instability: 0.25 },
      ],
      signals: signalsWith(
        signal({ kind: 'file_dependency_cycle', findings: [resolved, persistentBaseline] }),
        signal({ kind: 'package_coupling', findings: [
          couplingFinding({ id: 'persistent-a', name: 'persistent-a', afferent: 3, efferent: 4 }),
          couplingFinding({ id: 'persistent-b', name: 'persistent-b', afferent: 1, efferent: 1 }),
          couplingFinding({ id: 'resolved-a', name: 'resolved-a', afferent: 2, efferent: 3 }),
          couplingFinding({ id: 'resolved-z', name: 'resolved-z', afferent: 1, efferent: 3 }),
        ] }),
      ),
    });
    const current = report({
      scalars: { indexed_file_count: 12 },
      coupling: [
        { kind: 'coupling', scope: 'package', name: 'added', afferentCoupling: 4, efferentCoupling: 3, instability: 0.75 },
        { kind: 'coupling', scope: 'package', name: 'shared', afferentCoupling: 1, efferentCoupling: 2, instability: 0.25 },
      ],
      signals: signalsWith(
        signal({ kind: 'file_dependency_cycle', findings: [persistentCurrent, introduced] }),
        signal({ kind: 'package_coupling', findings: [
          couplingFinding({ id: 'persistent-a', name: 'persistent-a', afferent: 1, efferent: 1 }),
          couplingFinding({ id: 'persistent-b', name: 'persistent-b', afferent: 3, efferent: 4 }),
          couplingFinding({ id: 'introduced-a', name: 'introduced-a', afferent: 2, efferent: 3 }),
          couplingFinding({ id: 'introduced-z', name: 'introduced-z', afferent: 1, efferent: 3 }),
        ] }),
      ),
    });

    const forward = compare(baseline, current);
    const reverse = compare(current, baseline);

    expect(forward.comparisonStatus).toBe('comparable');
    expect(forward.introduced.map((item) => item.id)).toEqual(['introduced-file', 'introduced-a', 'introduced-z']);
    expect(forward.resolved.map((item) => item.id)).toEqual(['resolved-file', 'resolved-a', 'resolved-z']);
    expect(forward.persisting.map((item) => item.id)).toEqual(['persistent-file', 'persistent-b', 'persistent-a']);
    expect(forward.persisting.find((item) => item.id === 'persistent-file')).toEqual(persistentCurrent);
    expect(forward.metricDeltas).toEqual([
      { kind: 'scalar', key: 'indexed_file_count', baseline: 10, current: 12, delta: 2 },
      { kind: 'coupling', scope: 'package', name: 'added', metric: 'afferent_coupling', baseline: 0, current: 4, delta: 4 },
      { kind: 'coupling', scope: 'package', name: 'added', metric: 'efferent_coupling', baseline: 0, current: 3, delta: 3 },
      { kind: 'coupling', scope: 'package', name: 'added', metric: 'instability', baseline: 0, current: 0.75, delta: 0.75 },
      { kind: 'coupling', scope: 'package', name: 'removed', metric: 'afferent_coupling', baseline: 2, current: 0, delta: -2 },
      { kind: 'coupling', scope: 'package', name: 'removed', metric: 'efferent_coupling', baseline: 1, current: 0, delta: -1 },
      { kind: 'coupling', scope: 'package', name: 'removed', metric: 'instability', baseline: 0.5, current: 0, delta: -0.5 },
    ]);
    expect(reverse.introduced.map((item) => item.id)).toEqual(forward.resolved.map((item) => item.id));
    expect(reverse.resolved.map((item) => item.id)).toEqual(forward.introduced.map((item) => item.id));
    expect(reverse.persisting.map((item) => item.id)).toEqual(['persistent-file', 'persistent-a', 'persistent-b']);
    expect(reverse.persisting.find((item) => item.id === 'persistent-file')).toEqual(persistentBaseline);
    expect(reverse.metricDeltas.map((item) => item.delta)).toEqual([-2, -4, -3, -0.75, 2, 1, 0.5]);
  });

  it('returns empty semantic drift for unchanged compatible reports and incompatible per-signal coverage', () => {
    const unchanged = compare(report(), report());
    const baselineCoverage = coverage({
      status: 'partial',
      reasons: [{ code: 'index_errors_present', count: 1 }],
      relevantErrorFilePaths: ['src/baseline-error.ts'],
    });
    const currentCoverage = coverage({
      status: 'partial',
      reasons: [{ code: 'index_errors_present', count: 1 }],
      relevantErrorFilePaths: ['src/current-error.ts'],
    });
    const baseline = report({ signals: signalsWith(...ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((kind) => signal({ kind, coverage: baselineCoverage }))) });
    const current = report({ signals: signalsWith(...ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((kind) => signal({ kind, coverage: currentCoverage }))) });
    const incompatible = compare(baseline, current);

    expect(unchanged.comparisonStatus).toBe('comparable');
    expect([unchanged.introduced, unchanged.resolved, unchanged.persisting, unchanged.metricDeltas]).toEqual([[], [], [], []]);
    expect(incompatible.comparisonStatus).toBe('incompatible_analysis');
    expect(incompatible.omittedSignals).toEqual(ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((signalKind) => ({ signalKind, reasons: ['coverage_fingerprint_mismatch'] })));
    expect([incompatible.introduced, incompatible.resolved, incompatible.persisting, incompatible.metricDeltas]).toEqual([[], [], [], []]);
  });
});
