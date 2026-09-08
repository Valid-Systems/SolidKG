import { createHash } from 'crypto';
import type { EdgeKind } from '../types';
import {
  ARCHITECTURE_HEALTH_ANALYSIS_KIND,
  ARCHITECTURE_HEALTH_ANALYSIS_VERSION,
  ARCHITECTURE_HEALTH_SIGNAL_KINDS,
  type ArchitectureHealthCoverage,
  type ArchitectureHealthFinding,
  type ArchitectureHealthMetric,
  type ArchitectureHealthMetricDelta,
  type ArchitectureHealthReport,
  type ArchitectureHealthSignalKind,
  type ArchitectureLayerRule,
  type NormalizedArchitectureHealthOptions,
  type SnapshotHealthDrift,
} from './architecture-health-types';

const byCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const normalizePath = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
const signalIndex = (kind: ArchitectureHealthSignalKind): number => ARCHITECTURE_HEALTH_SIGNAL_KINDS.indexOf(kind);

function isLayerRule(value: unknown): value is ArchitectureLayerRule {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'name' in value
    && typeof value.name === 'string'
    && 'paths' in value
    && Array.isArray(value.paths)
    && value.paths.every((path: unknown): path is string => typeof path === 'string');
}

export function normalizeArchitectureHealthOptions(options: { layers?: readonly ArchitectureLayerRule[] } = {}): NormalizedArchitectureHealthOptions {
  const names = new Set<string>();
  const layers = (options.layers ?? []).map((rule) => {
    const name = rule.name.trim();
    if (!name) throw new Error('layer name must not be empty');
    if (names.has(name)) throw new Error(`duplicate layer name: ${name}`);
    names.add(name);
    const paths = [...new Set(rule.paths.map(normalizePath))].sort(byCodePoint);
    if (paths.length === 0 || paths.some((path) => !path)) throw new Error('layer paths must not be empty');
    return { name, paths };
  });
  return { layers };
}

export function parseLayerRules(value: unknown): ArchitectureLayerRule[] | string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'layersJson must be a JSON string';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return 'layersJson must be a JSON array';
    if (!parsed.every(isLayerRule)) return 'each layer rule must have a string name and string[] paths';
    return normalizeArchitectureHealthOptions({ layers: parsed }).layers;
  } catch (error) {
    return `layersJson is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function canonicalJson(value: unknown): string { return JSON.stringify(value); }
export function createFindingId(signalKind: ArchitectureHealthSignalKind, scope: ArchitectureHealthFinding['scope'], identityParts: readonly unknown[]): string {
  const normalized = identityParts.map((part, index) => typeof part === 'string' && (signalKind === 'static_unreferenced_candidate' && index === 0) ? normalizePath(part) : part);
  const parts = signalKind.endsWith('_dependency_cycle') ? [...normalized].sort((left, right) => byCodePoint(String(left), String(right))) : normalized;
  return createHash('sha256').update(JSON.stringify([ARCHITECTURE_HEALTH_ANALYSIS_VERSION, signalKind, scope, parts]), 'utf8').digest('hex').slice(0, 24);
}
export function createCoverageFingerprint(status: ArchitectureHealthCoverage['status'], reasons: ArchitectureHealthCoverage['reasons'], errorPaths: readonly string[], unresolvedKeys: readonly string[]): string {
  const sortedReasons = [...reasons].sort((left, right) => byCodePoint(left.code, right.code)).map(({ code, count }) => ({ code, count }));
  return createHash('sha256').update(JSON.stringify([status, sortedReasons, [...errorPaths].map(normalizePath).sort(byCodePoint), [...unresolvedKeys].sort(byCodePoint)]), 'utf8').digest('hex').slice(0, 24);
}

function canonicalCoverage(coverage: ArchitectureHealthCoverage): ArchitectureHealthCoverage {
  const reasons = [...coverage.reasons]
    .sort((left, right) => byCodePoint(left.code, right.code))
    .map(({ code, count }) => ({ code, count }));
  const relevantErrorFilePaths = [...coverage.relevantErrorFilePaths]
    .map(normalizePath)
    .sort(byCodePoint);
  const relevantUnresolvedReferenceKeys = [...coverage.relevantUnresolvedReferenceKeys]
    .sort(byCodePoint);
  return {
    status: coverage.status,
    reasons,
    relevantErrorFilePaths,
    relevantUnresolvedReferenceKeys,
    consumedProvenance: [...coverage.consumedProvenance].sort(byCodePoint),
    degradationFingerprint: createCoverageFingerprint(
      coverage.status,
      reasons,
      relevantErrorFilePaths,
      relevantUnresolvedReferenceKeys,
    ),
  };
}
function findingOrder(left: ArchitectureHealthFinding, right: ArchitectureHealthFinding): number {
  if (left.signalKind === 'package_coupling' || left.signalKind === 'layer_coupling') {
    const facts = (finding: ArchitectureHealthFinding, key: string): number => finding.facts.find((fact) => fact.key === key)?.value ?? 0;
    return facts(right, 'efferent_coupling') - facts(left, 'efferent_coupling') || facts(right, 'afferent_coupling') - facts(left, 'afferent_coupling') || byCodePoint(left.subjects[0] ?? '', right.subjects[0] ?? '');
  }
  return byCodePoint(left.scope, right.scope) || byCodePoint(left.subjects.join('\u0000'), right.subjects.join('\u0000'));
}
function canonicalFinding(finding: ArchitectureHealthFinding): ArchitectureHealthFinding {
  const subjects = finding.scope === 'file'
    ? finding.subjects.map(normalizePath)
    : finding.scope === 'symbol'
      ? finding.subjects.map((subject, index) => index === 0 ? normalizePath(subject) : subject)
      : [...finding.subjects];
  const normalizeEndpoints = finding.scope === 'file';
  return {
    id: finding.id,
    signalKind: finding.signalKind,
    scope: finding.scope,
    subjects,
    facts: [...finding.facts]
      .sort((left, right) => byCodePoint(left.key, right.key))
      .map(({ key, value }) => ({ key, value })),
    evidence: [...finding.evidence]
      .map((anchor) => ({
        path: anchor.path === null ? null : normalizePath(anchor.path),
        line: anchor.line,
        symbol: anchor.symbol,
        source: anchor.source === null
          ? null
          : normalizeEndpoints ? normalizePath(anchor.source) : anchor.source,
        target: anchor.target === null
          ? null
          : normalizeEndpoints ? normalizePath(anchor.target) : anchor.target,
        edgeKind: anchor.edgeKind as EdgeKind | null,
        provenance: anchor.provenance,
      }))
      .sort((left, right) => byCodePoint(left.path ?? '', right.path ?? '')
        || (left.line ?? -1) - (right.line ?? -1)
        || byCodePoint(left.symbol ?? '', right.symbol ?? '')
        || byCodePoint(left.source ?? '', right.source ?? '')
        || byCodePoint(left.target ?? '', right.target ?? '')
        || byCodePoint(left.edgeKind ?? '', right.edgeKind ?? '')
        || byCodePoint(left.provenance ?? '', right.provenance ?? '')),
  };
}
function metricOrder(left: ArchitectureHealthMetric, right: ArchitectureHealthMetric): number {
  if (left.kind !== right.kind) return left.kind === 'scalar' ? -1 : 1;
  if (left.kind === 'scalar' && right.kind === 'scalar') return scalarKeys.indexOf(left.key) - scalarKeys.indexOf(right.key);
  if (left.kind === 'coupling' && right.kind === 'coupling') return right.efferentCoupling - left.efferentCoupling || right.afferentCoupling - left.afferentCoupling || byCodePoint(left.name, right.name) || byCodePoint(left.scope, right.scope);
  return 0;
}
const scalarKeys = ['indexed_file_count', 'index_error_file_count', 'unresolved_reference_count', 'file_dependency_cycle_count', 'package_dependency_cycle_count', 'layer_dependency_cycle_count', 'package_stable_dependency_violation_count', 'layer_stable_dependency_violation_count', 'manifest_unassigned_file_count', 'layer_unassigned_file_count', 'static_unreferenced_candidate_count'] as const;
const snapshotDiffCountKeys = ['addedNodes', 'removedNodes', 'changedNodes', 'addedEdges', 'removedEdges', 'changedEdges', 'addedHyperedges', 'removedHyperedges', 'changedHyperedges', 'addedHyperedgeMembers', 'removedHyperedgeMembers', 'changedHyperedgeMembers'] as const;

function canonicalSnapshotDiffCounts(value: unknown): SnapshotHealthDrift['graphDiffCounts'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('graphDiffCounts must be an object');
  const counts = value as Record<string, unknown>;
  for (const key of snapshotDiffCountKeys) {
    if (typeof counts[key] !== 'number' || !Number.isFinite(counts[key])) throw new Error(`graphDiffCounts.${key} must be a finite number`);
  }
  return Object.fromEntries(snapshotDiffCountKeys.map((key) => [key, counts[key]])) as unknown as SnapshotHealthDrift['graphDiffCounts'];
}

export function canonicalizeArchitectureHealthReport(report: ArchitectureHealthReport): ArchitectureHealthReport {
  if (report.analysisKind !== ARCHITECTURE_HEALTH_ANALYSIS_KIND || report.analysisVersion !== ARCHITECTURE_HEALTH_ANALYSIS_VERSION) throw new Error('unsupported architecture health report');
  return { analysisKind: ARCHITECTURE_HEALTH_ANALYSIS_KIND, analysisVersion: ARCHITECTURE_HEALTH_ANALYSIS_VERSION, options: normalizeArchitectureHealthOptions(report.options), producer: { solidkgVersion: report.producer.solidkgVersion, schemaVersion: report.producer.schemaVersion, graphFactPolicy: report.producer.graphFactPolicy }, observedGraphFacts: { edgeKinds: [...report.observedGraphFacts.edgeKinds].sort(byCodePoint), edgeProvenanceCounts: [...report.observedGraphFacts.edgeProvenanceCounts].sort((left, right) => byCodePoint(left.provenance, right.provenance)).map(({ provenance, count }) => ({ provenance, count })), scip: { status: report.observedGraphFacts.scip.status, documentCount: report.observedGraphFacts.scip.documentCount, occurrenceCount: report.observedGraphFacts.scip.occurrenceCount, relationshipCount: report.observedGraphFacts.scip.relationshipCount } }, metrics: [...report.metrics].sort(metricOrder), signals: [...report.signals].sort((left, right) => signalIndex(left.kind) - signalIndex(right.kind)).map((signal) => ({ kind: signal.kind, coverage: canonicalCoverage(signal.coverage), findings: [...signal.findings].map(canonicalFinding).sort(findingOrder) })) };
}
export function canonicalizeSnapshotHealthDrift(drift: SnapshotHealthDrift): SnapshotHealthDrift {
  if (drift.analysisKind !== ARCHITECTURE_HEALTH_ANALYSIS_KIND || drift.analysisVersion !== ARCHITECTURE_HEALTH_ANALYSIS_VERSION) throw new Error('unsupported snapshot health drift');
  const coverageRecord = (record: { signalKind: ArchitectureHealthSignalKind; coverage: ArchitectureHealthCoverage }) => ({ signalKind: record.signalKind, coverage: canonicalCoverage(record.coverage) });
  const deltaOrder = (left: ArchitectureHealthMetricDelta, right: ArchitectureHealthMetricDelta): number => {
    if (left.kind !== right.kind) return left.kind === 'scalar' ? -1 : 1;
    if (left.kind === 'scalar' && right.kind === 'scalar') return scalarKeys.indexOf(left.key) - scalarKeys.indexOf(right.key);
    if (left.kind === 'coupling' && right.kind === 'coupling') return byCodePoint(left.scope, right.scope) || byCodePoint(left.name, right.name) || ['afferent_coupling', 'efferent_coupling', 'instability'].indexOf(left.metric) - ['afferent_coupling', 'efferent_coupling', 'instability'].indexOf(right.metric);
    return 0;
  };
  return { analysisKind: ARCHITECTURE_HEALTH_ANALYSIS_KIND, analysisVersion: ARCHITECTURE_HEALTH_ANALYSIS_VERSION, baselineLabel: drift.baselineLabel, comparisonStatus: drift.comparisonStatus, reasons: [...drift.reasons].sort(byCodePoint), graphDiffCounts: canonicalSnapshotDiffCounts(drift.graphDiffCounts), baselineCoverage: drift.baselineCoverage === null ? null : [...drift.baselineCoverage].sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind)).map(coverageRecord), currentCoverage: [...drift.currentCoverage].sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind)).map(coverageRecord), omittedSignals: [...drift.omittedSignals].sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind)).map(({ signalKind, reasons }) => ({ signalKind, reasons: [...reasons].sort(byCodePoint) })), introduced: [...drift.introduced].map(canonicalFinding).sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind) || findingOrder(left, right)), resolved: [...drift.resolved].map(canonicalFinding).sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind) || findingOrder(left, right)), persisting: [...drift.persisting].map(canonicalFinding).sort((left, right) => signalIndex(left.signalKind) - signalIndex(right.signalKind) || findingOrder(left, right)), metricDeltas: [...drift.metricDeltas].sort(deltaOrder) };
}
