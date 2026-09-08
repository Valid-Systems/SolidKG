import { describe, expect, it } from 'vitest';
import { compareSnapshotHealthDrift } from '../src/analysis/architecture-health-drift';
import {
  ARCHITECTURE_HEALTH_SIGNAL_KINDS,
  type ArchitectureHealthCoverage,
  type ArchitectureHealthFinding,
  type ArchitectureHealthMetric,
  type ArchitectureHealthMetricDelta,
  type ArchitectureHealthObservedGraphFacts,
  type ArchitectureHealthProducerIdentity,
  type ArchitectureHealthReport,
  type ArchitectureHealthSignal,
  type ArchitectureHealthSignalKind,
  type NormalizedArchitectureHealthOptions,
  type SnapshotDiffCounts,
} from '../src/analysis/architecture-health-types';

type DriftProducer = Omit<ArchitectureHealthProducerIdentity, 'graphFactPolicy'> & { graphFactPolicy: string };
type DriftReport = Omit<ArchitectureHealthReport, 'analysisVersion' | 'producer'> & { analysisVersion: number; producer: DriftProducer };
type CouplingTriple = readonly [afferent: number, efferent: number, instability: number];

const graphDiffCounts: SnapshotDiffCounts = { addedNodes: 1, removedNodes: 0, changedNodes: 0, addedEdges: 0, removedEdges: 0, changedEdges: 0, addedHyperedges: 0, removedHyperedges: 0, changedHyperedges: 0, addedHyperedgeMembers: 0, removedHyperedgeMembers: 0, changedHyperedgeMembers: 0 };
const couplingScopeBySignalKind = { package_coupling: 'package', layer_coupling: 'layer' } as const;

function coverage(input: Partial<ArchitectureHealthCoverage> = {}): ArchitectureHealthCoverage {
  return { status: 'complete', reasons: [], relevantErrorFilePaths: [], relevantUnresolvedReferenceKeys: [], consumedProvenance: [], degradationFingerprint: 'complete', ...input };
}

function finding(id: string, signalKind: ArchitectureHealthSignalKind): ArchitectureHealthFinding {
  return { id, signalKind, scope: 'file', subjects: [id], facts: [], evidence: [] };
}

function couplingFinding(input: { id: string; signalKind: keyof typeof couplingScopeBySignalKind; name: string; values: CouplingTriple }): ArchitectureHealthFinding {
  return {
    id: input.id,
    signalKind: input.signalKind,
    scope: couplingScopeBySignalKind[input.signalKind],
    subjects: [input.name],
    facts: [
      { key: 'afferent_coupling', value: input.values[0] },
      { key: 'efferent_coupling', value: input.values[1] },
      { key: 'instability', value: input.values[2] },
    ],
    evidence: [],
  };
}

function signal(input: { kind: ArchitectureHealthSignalKind; coverage?: ArchitectureHealthCoverage; findings?: ArchitectureHealthFinding[] }): ArchitectureHealthSignal {
  return { kind: input.kind, coverage: input.coverage ?? coverage(), findings: input.findings ?? [] };
}

function signalsWith(...replacements: readonly ArchitectureHealthSignal[]): ArchitectureHealthSignal[] {
  const byKind = new Map(replacements.map((replacement) => [replacement.kind, replacement]));
  return ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((kind) => byKind.get(kind) ?? signal({ kind }));
}

function observedGraphFacts(scipStatus: ArchitectureHealthObservedGraphFacts['scip']['status'] = 'unavailable'): ArchitectureHealthObservedGraphFacts {
  return { edgeKinds: [], edgeProvenanceCounts: [], scip: { status: scipStatus, documentCount: 0, occurrenceCount: 0, relationshipCount: 0 } };
}

function report(input: {
  analysisVersion?: number;
  options?: NormalizedArchitectureHealthOptions;
  producer?: DriftProducer;
  observedGraphFacts?: ArchitectureHealthObservedGraphFacts;
  metrics?: readonly ArchitectureHealthMetric[];
  signals?: ArchitectureHealthSignal[];
} = {}): DriftReport {
  return {
    analysisKind: 'architecture_health',
    analysisVersion: input.analysisVersion ?? 1,
    options: input.options ?? { layers: [] },
    producer: input.producer ?? { solidkgVersion: '1.0.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v1' },
    observedGraphFacts: input.observedGraphFacts ?? observedGraphFacts(),
    metrics: [...(input.metrics ?? [])],
    signals: input.signals ?? signalsWith(),
  };
}

function couplingMetric(scope: 'package' | 'layer', name: string, values: CouplingTriple): ArchitectureHealthMetric {
  return { kind: 'coupling', scope, name, afferentCoupling: values[0], efferentCoupling: values[1], instability: values[2] };
}

function couplingDeltas(scope: 'package' | 'layer', name: string, baseline: CouplingTriple, current: CouplingTriple): ArchitectureHealthMetricDelta[] {
  return [
    { kind: 'coupling', scope, name, metric: 'afferent_coupling', baseline: baseline[0], current: current[0], delta: current[0] - baseline[0] },
    { kind: 'coupling', scope, name, metric: 'efferent_coupling', baseline: baseline[1], current: current[1], delta: current[1] - baseline[1] },
    { kind: 'coupling', scope, name, metric: 'instability', baseline: baseline[2], current: current[2], delta: current[2] - baseline[2] },
  ];
}

function compare(baseline: DriftReport | null, current: DriftReport) {
  return compareSnapshotHealthDrift({ baselineLabel: 'baseline', baseline, current, graphDiffCounts });
}

describe('snapshot health drift contracts', () => {
  it('suppresses semantic results with every exact global mismatch reason', () => {
    const drift = compare(
      report({
        analysisVersion: 2,
        options: { layers: [{ name: 'app', paths: ['src/**'] }] },
        producer: { solidkgVersion: '0.9.0', schemaVersion: 10, graphFactPolicy: 'legacy_policy' },
      }),
      report(),
    );

    expect(drift.comparisonStatus).toBe('incompatible_analysis');
    expect(drift.reasons).toEqual(['analysis_version_mismatch', 'graph_fact_policy_mismatch', 'normalized_options_mismatch', 'producer_identity_mismatch']);
    expect(drift.graphDiffCounts).toEqual(graphDiffCounts);
    expect([drift.omittedSignals, drift.introduced, drift.resolved, drift.persisting, drift.metricDeltas]).toEqual([[], [], [], [], []]);
  });

  it('omits only a signal with all coverage mismatch reasons in canonical order', () => {
    const scipCoverage = coverage({
      status: 'partial',
      reasons: [{ code: 'unresolved_references_present', count: 1 }],
      consumedProvenance: ['scip'],
      degradationFingerprint: 'baseline-degradation',
    });
    const visible = finding('visible', 'package_dependency_cycle');
    const drift = compare(
      report({ observedGraphFacts: observedGraphFacts('unavailable'), signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: scipCoverage })) }),
      report({
        observedGraphFacts: observedGraphFacts('linked'),
        signals: signalsWith(
          signal({ kind: 'file_dependency_cycle', coverage: coverage({ status: 'complete', consumedProvenance: ['scip'], degradationFingerprint: 'current-degradation' }) }),
          signal({ kind: 'package_dependency_cycle', findings: [visible] }),
        ),
      }),
    );

    expect(drift.comparisonStatus).toBe('partially_compatible');
    expect(drift.omittedSignals).toEqual([{
      signalKind: 'file_dependency_cycle',
      reasons: ['coverage_fingerprint_mismatch', 'coverage_reason_mismatch', 'coverage_status_mismatch', 'scip_descriptor_mismatch'],
    }]);
    expect(drift.introduced).toEqual([visible]);
  });

  it('compares identically covered signals when their input reason order differs', () => {
    const first = coverage({
      status: 'partial',
      reasons: [{ code: 'unresolved_references_present', count: 1 }, { code: 'index_errors_present', count: 2 }],
      degradationFingerprint: 'same-degradation',
    });
    const second = coverage({
      status: 'partial',
      reasons: [{ code: 'index_errors_present', count: 2 }, { code: 'unresolved_references_present', count: 1 }],
      degradationFingerprint: 'same-degradation',
    });
    const introduced = finding('introduced', 'file_dependency_cycle');
    const drift = compare(
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: first })) }),
      report({ signals: signalsWith(signal({ kind: 'file_dependency_cycle', coverage: second, findings: [introduced] })) }),
    );

    expect(drift.comparisonStatus).toBe('comparable');
    expect(drift.introduced).toEqual([introduced]);
  });

  it('orders layer and package deltas, zero-fills one-sided entries, and fully reverses them', () => {
    const zero: CouplingTriple = [0, 0, 0];
    const layerRemoved: CouplingTriple = [5, 4, 0.4];
    const layerAdded: CouplingTriple = [2, 1, 0.2];
    const packageRemoved: CouplingTriple = [7, 6, 0.6];
    const packageAdded: CouplingTriple = [4, 3, 0.3];
    const baseline = report({ metrics: [
      couplingMetric('package', 'Z', packageRemoved),
      couplingMetric('layer', 'isolated', zero),
      couplingMetric('layer', 'Z', layerRemoved),
      couplingMetric('package', 'isolated', zero),
    ] });
    const current = report({ metrics: [
      couplingMetric('package', 'a', packageAdded),
      couplingMetric('layer', 'a', layerAdded),
      couplingMetric('package', 'isolated', zero),
      couplingMetric('layer', 'isolated', zero),
    ] });
    const expectedForward = [
      ...couplingDeltas('layer', 'Z', layerRemoved, zero),
      ...couplingDeltas('layer', 'a', zero, layerAdded),
      ...couplingDeltas('package', 'Z', packageRemoved, zero),
      ...couplingDeltas('package', 'a', zero, packageAdded),
    ];
    const expectedReverse = [
      ...couplingDeltas('layer', 'Z', zero, layerRemoved),
      ...couplingDeltas('layer', 'a', layerAdded, zero),
      ...couplingDeltas('package', 'Z', zero, packageRemoved),
      ...couplingDeltas('package', 'a', packageAdded, zero),
    ];

    const forward = compare(baseline, current);
    const reverse = compare(current, baseline);

    expect(forward.comparisonStatus).toBe('comparable');
    expect(forward.metricDeltas).toEqual(expectedForward);
    expect(reverse.metricDeltas).toEqual(expectedReverse);
    expect(forward.metricDeltas.some((delta) => delta.kind === 'coupling' && delta.name === 'isolated')).toBe(false);
  });

  it('orders every layer-coupling finding set from its emitted payload', () => {
    const baselinePersistentA = couplingFinding({ id: 'persistent-a', signalKind: 'layer_coupling', name: 'persistent-a', values: [1, 1, 0] });
    const baselinePersistentZ = couplingFinding({ id: 'persistent-Z', signalKind: 'layer_coupling', name: 'persistent-Z', values: [1, 1, 0] });
    const currentPersistentA = couplingFinding({ id: 'persistent-a', signalKind: 'layer_coupling', name: 'persistent-a', values: [2, 2, 0] });
    const currentPersistentZ = couplingFinding({ id: 'persistent-Z', signalKind: 'layer_coupling', name: 'persistent-Z', values: [2, 2, 0] });
    const drift = compare(
      report({ signals: signalsWith(signal({ kind: 'layer_coupling', findings: [
        couplingFinding({ id: 'resolved-a', signalKind: 'layer_coupling', name: 'resolved-a', values: [1, 4, 0] }),
        couplingFinding({ id: 'resolved-Z', signalKind: 'layer_coupling', name: 'resolved-Z', values: [1, 4, 0] }),
        baselinePersistentA,
        baselinePersistentZ,
      ] })) }),
      report({ signals: signalsWith(signal({ kind: 'layer_coupling', findings: [
        couplingFinding({ id: 'introduced-a', signalKind: 'layer_coupling', name: 'introduced-a', values: [1, 4, 0] }),
        couplingFinding({ id: 'introduced-Z', signalKind: 'layer_coupling', name: 'introduced-Z', values: [1, 4, 0] }),
        currentPersistentA,
        currentPersistentZ,
      ] })) }),
    );

    expect(drift.introduced.map((item) => item.id)).toEqual(['introduced-Z', 'introduced-a']);
    expect(drift.resolved.map((item) => item.id)).toEqual(['resolved-Z', 'resolved-a']);
    expect(drift.persisting).toEqual([currentPersistentZ, currentPersistentA]);
  });
});
