import { canonicalizeArchitectureHealthReport, canonicalizeSnapshotHealthDrift, canonicalJson, normalizeArchitectureHealthOptions } from './architecture-health-normalization';
import { ARCHITECTURE_HEALTH_ANALYSIS_KIND, ARCHITECTURE_HEALTH_ANALYSIS_VERSION, ARCHITECTURE_HEALTH_SIGNAL_KINDS, type ArchitectureHealthFinding, type ArchitectureHealthMetric, type ArchitectureHealthMetricDelta, type ArchitectureHealthProducerIdentity, type ArchitectureHealthReport, type ArchitectureHealthScalarMetricKey, type ArchitectureHealthSignal, type ArchitectureHealthSignalCoverageRecord, type ArchitectureHealthSignalKind, type SnapshotDiffCounts, type SnapshotHealthComparisonStatus, type SnapshotHealthDrift, type SnapshotHealthDriftReasonCode } from './architecture-health-types';

type CouplingMetric = Extract<ArchitectureHealthMetric, { kind: 'coupling' }>;
type DriftProducerIdentity = Omit<ArchitectureHealthProducerIdentity, 'graphFactPolicy'> & { graphFactPolicy: string };

export interface SnapshotHealthDriftComparableReport extends Omit<ArchitectureHealthReport, 'analysisVersion' | 'producer'> { readonly analysisVersion: number; readonly producer: DriftProducerIdentity; }
export interface SnapshotHealthDriftComparisonInput { readonly baselineLabel: string; readonly baseline: SnapshotHealthDriftComparableReport | null; readonly current: SnapshotHealthDriftComparableReport; readonly graphDiffCounts: SnapshotDiffCounts; }
interface CouplingPair { baseline: CouplingMetric | null; current: CouplingMetric | null; }

const graphFactPolicy = 'all_indexed_architecture_edges_v1' as const;
const scalarMetricKeys = ['indexed_file_count', 'index_error_file_count', 'unresolved_reference_count', 'file_dependency_cycle_count', 'package_dependency_cycle_count', 'layer_dependency_cycle_count', 'package_stable_dependency_violation_count', 'layer_stable_dependency_violation_count', 'manifest_unassigned_file_count', 'layer_unassigned_file_count', 'static_unreferenced_candidate_count'] as const satisfies readonly ArchitectureHealthScalarMetricKey[];
const scalarMetricSignalKinds: Readonly<Partial<Record<ArchitectureHealthScalarMetricKey, ArchitectureHealthSignalKind>>> = { file_dependency_cycle_count: 'file_dependency_cycle', package_dependency_cycle_count: 'package_dependency_cycle', layer_dependency_cycle_count: 'layer_dependency_cycle', package_stable_dependency_violation_count: 'package_stable_dependency_violation', layer_stable_dependency_violation_count: 'layer_stable_dependency_violation', manifest_unassigned_file_count: 'manifest_unassigned_file', layer_unassigned_file_count: 'layer_unassigned_file', static_unreferenced_candidate_count: 'static_unreferenced_candidate' } as const;
const couplingSignalKinds = { package: 'package_coupling', layer: 'layer_coupling' } as const satisfies Record<CouplingMetric['scope'], ArchitectureHealthSignalKind>;
const couplingComponents = [{ metric: 'afferent_coupling', field: 'afferentCoupling' }, { metric: 'efferent_coupling', field: 'efferentCoupling' }, { metric: 'instability', field: 'instability' }] as const;
const zeroCoupling = { afferentCoupling: 0, efferentCoupling: 0, instability: 0 };

function coverageRecords(report: SnapshotHealthDriftComparableReport): ArchitectureHealthSignalCoverageRecord[] {
  return report.signals.map((signal) => ({ signalKind: signal.kind, coverage: signal.coverage }));
}

function buildDrift(input: Omit<SnapshotHealthDrift, 'analysisKind' | 'analysisVersion'>): SnapshotHealthDrift {
  return canonicalizeSnapshotHealthDrift({ analysisKind: ARCHITECTURE_HEALTH_ANALYSIS_KIND, analysisVersion: ARCHITECTURE_HEALTH_ANALYSIS_VERSION, ...input });
}

function globalCompatibilityReasons(
  baseline: SnapshotHealthDriftComparableReport,
  current: SnapshotHealthDriftComparableReport,
): SnapshotHealthDriftReasonCode[] {
  const reasons: SnapshotHealthDriftReasonCode[] = [];
  if (baseline.analysisVersion !== ARCHITECTURE_HEALTH_ANALYSIS_VERSION || current.analysisVersion !== ARCHITECTURE_HEALTH_ANALYSIS_VERSION) reasons.push('analysis_version_mismatch');
  if (canonicalJson(normalizeArchitectureHealthOptions(baseline.options)) !== canonicalJson(normalizeArchitectureHealthOptions(current.options))) reasons.push('normalized_options_mismatch');
  if (baseline.producer.graphFactPolicy !== graphFactPolicy || current.producer.graphFactPolicy !== graphFactPolicy || baseline.producer.graphFactPolicy !== current.producer.graphFactPolicy) reasons.push('graph_fact_policy_mismatch');
  if (baseline.producer.solidkgVersion !== current.producer.solidkgVersion || baseline.producer.schemaVersion !== current.producer.schemaVersion) reasons.push('producer_identity_mismatch');
  return reasons;
}

function isCurrentReport(report: SnapshotHealthDriftComparableReport): report is ArchitectureHealthReport {
  return report.analysisVersion === ARCHITECTURE_HEALTH_ANALYSIS_VERSION && report.producer.graphFactPolicy === graphFactPolicy;
}

function signalMismatchReasons(input: {
  baseline: ArchitectureHealthSignal;
  current: ArchitectureHealthSignal;
  baselineScipStatus: ArchitectureHealthReport['observedGraphFacts']['scip']['status'];
  currentScipStatus: ArchitectureHealthReport['observedGraphFacts']['scip']['status'];
}): SnapshotHealthDriftReasonCode[] {
  const reasons: SnapshotHealthDriftReasonCode[] = [];
  if (input.baseline.coverage.status !== input.current.coverage.status) reasons.push('coverage_status_mismatch');
  if (canonicalJson(input.baseline.coverage.reasons) !== canonicalJson(input.current.coverage.reasons)) reasons.push('coverage_reason_mismatch');
  if (input.baseline.coverage.degradationFingerprint !== input.current.coverage.degradationFingerprint) reasons.push('coverage_fingerprint_mismatch');
  if ((input.baseline.coverage.consumedProvenance.includes('scip') || input.current.coverage.consumedProvenance.includes('scip')) && input.baselineScipStatus !== input.currentScipStatus) reasons.push('scip_descriptor_mismatch');
  return reasons;
}

function signalMap(report: ArchitectureHealthReport): Map<ArchitectureHealthSignalKind, ArchitectureHealthSignal> {
  const signals = new Map<ArchitectureHealthSignalKind, ArchitectureHealthSignal>();
  for (const signal of report.signals) signals.set(signal.kind, signal);
  return signals;
}

function scalarValues(report: ArchitectureHealthReport): Map<ArchitectureHealthScalarMetricKey, number> {
  const values = new Map<ArchitectureHealthScalarMetricKey, number>();
  for (const metric of report.metrics) {
    if (metric.kind === 'scalar') values.set(metric.key, metric.value);
  }
  return values;
}

function couplingKey(metric: CouplingMetric): string {
  return JSON.stringify([metric.scope, metric.name]);
}

function couplingPairs(baseline: ArchitectureHealthReport, current: ArchitectureHealthReport): Map<string, CouplingPair> {
  const pairs = new Map<string, CouplingPair>();
  for (const metric of baseline.metrics) {
    if (metric.kind === 'coupling') pairs.set(couplingKey(metric), { baseline: metric, current: null });
  }
  for (const metric of current.metrics) {
    if (metric.kind !== 'coupling') continue;
    const existing = pairs.get(couplingKey(metric));
    if (existing === undefined) pairs.set(couplingKey(metric), { baseline: null, current: metric });
    else existing.current = metric;
  }
  return pairs;
}

function metricDeltas(input: {
  baseline: ArchitectureHealthReport;
  current: ArchitectureHealthReport;
  comparableSignalKinds: ReadonlySet<ArchitectureHealthSignalKind>;
}): ArchitectureHealthMetricDelta[] {
  const deltas: ArchitectureHealthMetricDelta[] = [];
  const baselineScalars = scalarValues(input.baseline);
  const currentScalars = scalarValues(input.current);
  for (const key of scalarMetricKeys) {
    const signalKind = scalarMetricSignalKinds[key];
    if (signalKind !== undefined && !input.comparableSignalKinds.has(signalKind)) continue;
    const baselineValue = baselineScalars.get(key);
    const currentValue = currentScalars.get(key);
    if (baselineValue === undefined || currentValue === undefined || baselineValue === currentValue) continue;
    deltas.push({ kind: 'scalar', key, baseline: baselineValue, current: currentValue, delta: currentValue - baselineValue });
  }
  for (const pair of couplingPairs(input.baseline, input.current).values()) {
    const present = pair.baseline ?? pair.current;
    if (present === null || !input.comparableSignalKinds.has(couplingSignalKinds[present.scope])) continue;
    const baselineMetric = pair.baseline ?? zeroCoupling;
    const currentMetric = pair.current ?? zeroCoupling;
    for (const component of couplingComponents) {
      const baselineValue = baselineMetric[component.field];
      const currentValue = currentMetric[component.field];
      if (baselineValue === currentValue) continue;
      deltas.push({ kind: 'coupling', scope: present.scope, name: present.name, metric: component.metric, baseline: baselineValue, current: currentValue, delta: currentValue - baselineValue });
    }
  }
  return deltas;
}

export function compareSnapshotHealthDrift(input: SnapshotHealthDriftComparisonInput): SnapshotHealthDrift {
  const currentCoverage = coverageRecords(input.current);
  if (input.baseline === null) {
    return buildDrift({
      baselineLabel: input.baselineLabel,
      comparisonStatus: 'baseline_analysis_unavailable',
      reasons: ['baseline_analysis_unavailable'],
      graphDiffCounts: input.graphDiffCounts,
      baselineCoverage: null,
      currentCoverage,
      omittedSignals: [],
      introduced: [],
      resolved: [],
      persisting: [],
      metricDeltas: [],
    });
  }

  const baselineCoverage = coverageRecords(input.baseline);
  const globalReasons = globalCompatibilityReasons(input.baseline, input.current);
  if (globalReasons.length > 0 || !isCurrentReport(input.baseline) || !isCurrentReport(input.current)) {
    return buildDrift({
      baselineLabel: input.baselineLabel,
      comparisonStatus: 'incompatible_analysis',
      reasons: globalReasons,
      graphDiffCounts: input.graphDiffCounts,
      baselineCoverage,
      currentCoverage,
      omittedSignals: [],
      introduced: [],
      resolved: [],
      persisting: [],
      metricDeltas: [],
    });
  }

  const baseline = canonicalizeArchitectureHealthReport(input.baseline);
  const current = canonicalizeArchitectureHealthReport(input.current);
  const baselineSignals = signalMap(baseline);
  const currentSignals = signalMap(current);
  const comparableSignalKinds = new Set<ArchitectureHealthSignalKind>();
  const omittedSignals: SnapshotHealthDrift['omittedSignals'] = [];
  const introduced: ArchitectureHealthFinding[] = [];
  const resolved: ArchitectureHealthFinding[] = [];
  const persisting: ArchitectureHealthFinding[] = [];

  for (const kind of ARCHITECTURE_HEALTH_SIGNAL_KINDS) {
    const baselineSignal = baselineSignals.get(kind);
    const currentSignal = currentSignals.get(kind);
    if (baselineSignal === undefined || currentSignal === undefined) continue;
    const reasons = signalMismatchReasons({
      baseline: baselineSignal,
      current: currentSignal,
      baselineScipStatus: baseline.observedGraphFacts.scip.status,
      currentScipStatus: current.observedGraphFacts.scip.status,
    });
    if (reasons.length > 0) {
      omittedSignals.push({ signalKind: kind, reasons });
      continue;
    }
    comparableSignalKinds.add(kind);
    const baselineFindings = new Map(baselineSignal.findings.map((finding) => [finding.id, finding]));
    const currentFindings = new Map(currentSignal.findings.map((finding) => [finding.id, finding]));
    for (const finding of currentSignal.findings) {
      if (baselineFindings.has(finding.id)) persisting.push(finding);
      else introduced.push(finding);
    }
    for (const finding of baselineSignal.findings) {
      if (!currentFindings.has(finding.id)) resolved.push(finding);
    }
  }

  const comparisonStatus: SnapshotHealthComparisonStatus = comparableSignalKinds.size === 0
    ? 'incompatible_analysis'
    : omittedSignals.length === 0 ? 'comparable' : 'partially_compatible';
  const deltas = comparisonStatus === 'incompatible_analysis'
    ? []
    : metricDeltas({ baseline, current, comparableSignalKinds });
  return buildDrift({
    baselineLabel: input.baselineLabel,
    comparisonStatus,
    reasons: [],
    graphDiffCounts: input.graphDiffCounts,
    baselineCoverage: coverageRecords(baseline),
    currentCoverage: coverageRecords(current),
    omittedSignals,
    introduced: comparisonStatus === 'incompatible_analysis' ? [] : introduced,
    resolved: comparisonStatus === 'incompatible_analysis' ? [] : resolved,
    persisting: comparisonStatus === 'incompatible_analysis' ? [] : persisting,
    metricDeltas: deltas,
  });
}
