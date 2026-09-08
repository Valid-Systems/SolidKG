import type { ArchitectureReport } from '../index';
import type { EdgeKind } from '../types';

export const ARCHITECTURE_HEALTH_ANALYSIS_KIND = 'architecture_health' as const;
export const ARCHITECTURE_HEALTH_ANALYSIS_VERSION = 1 as const;

export const ARCHITECTURE_HEALTH_SIGNAL_KINDS = [
  'file_dependency_cycle', 'package_dependency_cycle', 'layer_dependency_cycle',
  'package_stable_dependency_violation', 'layer_stable_dependency_violation',
  'package_coupling', 'layer_coupling', 'manifest_unassigned_file',
  'layer_unassigned_file', 'static_unreferenced_candidate',
] as const;
export type ArchitectureHealthSignalKind = (typeof ARCHITECTURE_HEALTH_SIGNAL_KINDS)[number];
export type ArchitectureHealthCoverageStatus = 'complete' | 'partial' | 'not_run' | 'unsupported';
export type ArchitectureHealthSignalReasonCode = 'index_errors_present' | 'unresolved_references_present' | 'layer_rules_not_configured' | 'static_unreferenced_candidate_only' | 'unsupported_signal';
export type SnapshotHealthDriftReasonCode = 'baseline_analysis_unavailable' | 'analysis_version_mismatch' | 'normalized_options_mismatch' | 'graph_fact_policy_mismatch' | 'producer_identity_mismatch' | 'scip_descriptor_mismatch' | 'coverage_status_mismatch' | 'coverage_reason_mismatch' | 'coverage_fingerprint_mismatch';
export type SnapshotHealthComparisonStatus = 'comparable' | 'partially_compatible' | 'incompatible_analysis' | 'baseline_analysis_unavailable';

export interface ArchitectureLayerRule { name: string; paths: string[]; }
export interface NormalizedArchitectureHealthOptions { layers: ArchitectureLayerRule[]; }
export interface ArchitectureHealthProducerIdentity { solidkgVersion: string; schemaVersion: number; graphFactPolicy: 'all_indexed_architecture_edges_v1'; }
export type ArchitectureHealthProvenance = 'tree-sitter' | 'scip' | 'heuristic' | 'unspecified';
export interface ArchitectureHealthObservedGraphFacts {
  edgeKinds: EdgeKind[];
  edgeProvenanceCounts: Array<{ provenance: ArchitectureHealthProvenance; count: number }>;
  scip: { status: 'unavailable' | 'imported_unlinked' | 'linked'; documentCount: number; occurrenceCount: number; relationshipCount: number };
}
export interface ArchitectureHealthCoverage {
  status: ArchitectureHealthCoverageStatus;
  reasons: Array<{ code: ArchitectureHealthSignalReasonCode; count: number }>;
  relevantErrorFilePaths: string[];
  relevantUnresolvedReferenceKeys: string[];
  consumedProvenance: ArchitectureHealthProvenance[];
  degradationFingerprint: string;
}
export type ArchitectureHealthFindingFactKey = 'afferent_coupling' | 'efferent_coupling' | 'instability' | 'source_afferent_coupling' | 'source_efferent_coupling' | 'source_instability' | 'target_afferent_coupling' | 'target_efferent_coupling' | 'target_instability';
export interface ArchitectureHealthEvidenceAnchor { path: string | null; line: number | null; symbol: string | null; source: string | null; target: string | null; edgeKind: EdgeKind | null; provenance: ArchitectureHealthProvenance | null; }
export interface ArchitectureHealthFinding { id: string; signalKind: ArchitectureHealthSignalKind; scope: 'file' | 'package' | 'layer' | 'symbol'; subjects: string[]; facts: Array<{ key: ArchitectureHealthFindingFactKey; value: number }>; evidence: ArchitectureHealthEvidenceAnchor[]; }
export interface ArchitectureHealthSignal { kind: ArchitectureHealthSignalKind; coverage: ArchitectureHealthCoverage; findings: ArchitectureHealthFinding[]; }
export type ArchitectureHealthScalarMetricKey = 'indexed_file_count' | 'index_error_file_count' | 'unresolved_reference_count' | 'file_dependency_cycle_count' | 'package_dependency_cycle_count' | 'layer_dependency_cycle_count' | 'package_stable_dependency_violation_count' | 'layer_stable_dependency_violation_count' | 'manifest_unassigned_file_count' | 'layer_unassigned_file_count' | 'static_unreferenced_candidate_count';
export type ArchitectureHealthMetric = { kind: 'scalar'; key: ArchitectureHealthScalarMetricKey; value: number } | { kind: 'coupling'; scope: 'package' | 'layer'; name: string; afferentCoupling: number; efferentCoupling: number; instability: number };
export interface ArchitectureHealthReport { analysisKind: 'architecture_health'; analysisVersion: 1; options: NormalizedArchitectureHealthOptions; producer: ArchitectureHealthProducerIdentity; observedGraphFacts: ArchitectureHealthObservedGraphFacts; metrics: ArchitectureHealthMetric[]; signals: ArchitectureHealthSignal[]; }
export interface SnapshotArchitectureHealthBundle { options: NormalizedArchitectureHealthOptions; architecture: ArchitectureReport; health: ArchitectureHealthReport; }
interface StoredSnapshotAnalysisRow { snapshotLabel: string; analysisKind: 'architecture_health'; analysisVersion: 1; optionsJson: string; payloadJson: string; }
export interface SnapshotDiffCounts { addedNodes: number; removedNodes: number; changedNodes: number; addedEdges: number; removedEdges: number; changedEdges: number; addedHyperedges: number; removedHyperedges: number; changedHyperedges: number; addedHyperedgeMembers: number; removedHyperedgeMembers: number; changedHyperedgeMembers: number; }
export interface ArchitectureHealthSignalCoverageRecord { signalKind: ArchitectureHealthSignalKind; coverage: ArchitectureHealthCoverage; }
export type ArchitectureHealthMetricDelta = { kind: 'scalar'; key: ArchitectureHealthScalarMetricKey; baseline: number; current: number; delta: number } | { kind: 'coupling'; scope: 'package' | 'layer'; name: string; metric: 'afferent_coupling' | 'efferent_coupling' | 'instability'; baseline: number; current: number; delta: number };
export interface SnapshotHealthDrift { analysisKind: 'architecture_health'; analysisVersion: 1; baselineLabel: string; comparisonStatus: SnapshotHealthComparisonStatus; reasons: SnapshotHealthDriftReasonCode[]; graphDiffCounts: SnapshotDiffCounts; baselineCoverage: ArchitectureHealthSignalCoverageRecord[] | null; currentCoverage: ArchitectureHealthSignalCoverageRecord[]; omittedSignals: Array<{ signalKind: ArchitectureHealthSignalKind; reasons: SnapshotHealthDriftReasonCode[] }>; introduced: ArchitectureHealthFinding[]; resolved: ArchitectureHealthFinding[]; persisting: ArchitectureHealthFinding[]; metricDeltas: ArchitectureHealthMetricDelta[]; }

export type { StoredSnapshotAnalysisRow };
