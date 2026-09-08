import {
  canonicalizeArchitectureHealthReport,
  canonicalizeSnapshotHealthDrift,
  type ArchitectureHealthCoverage,
  type ArchitectureHealthEvidenceAnchor,
  type ArchitectureHealthFinding,
  type ArchitectureHealthMetric,
  type ArchitectureHealthMetricDelta,
  type ArchitectureHealthReport,
  type ArchitectureHealthSignalKind,
  type SnapshotHealthDrift,
} from '../analysis';

const CATEGORY_LIMIT = 20;
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatCoverage(kind: ArchitectureHealthSignalKind, coverage: ArchitectureHealthCoverage): string[] {
  const reasons = coverage.reasons.map((reason) => `${reason.code} (${reason.count})`);
  const suffix = reasons.length === 0 ? '' : `: ${reasons.join(', ')}`;
  const lines = [`- ${kind}: ${coverage.status}${suffix}`];
  if (coverage.relevantErrorFilePaths.length > 0) lines.push(`  Error files: ${coverage.relevantErrorFilePaths.join(', ')}`);
  if (coverage.relevantUnresolvedReferenceKeys.length > 0) lines.push(`  Unresolved references: ${coverage.relevantUnresolvedReferenceKeys.join(', ')}`);
  lines.push(`  Provenance: ${coverage.consumedProvenance.join(', ') || 'none'}`);
  lines.push(`  Fingerprint: ${coverage.degradationFingerprint}`);
  return lines;
}

function formatFinding(finding: ArchitectureHealthFinding): string[] {
  const facts = finding.facts.map((fact) => `${fact.key}=${formatValue(fact.value)}`);
  return [`- [${finding.id}] ${finding.scope}: ${finding.subjects.join(', ')}${facts.length === 0 ? '' : ` (${facts.join(', ')})`}`];
}

function formatFindingCategory(name: string, findings: readonly ArchitectureHealthFinding[]): string[] {
  const lines = [`### ${name} (${findings.length})`];
  if (findings.length === 0) return [...lines, 'No findings.', ''];
  lines.push(...findings.slice(0, CATEGORY_LIMIT).flatMap(formatFinding));
  if (findings.length > CATEGORY_LIMIT) lines.push(`- +${findings.length - CATEGORY_LIMIT} more`);
  lines.push('');
  return lines;
}

function formatEvidence(anchor: ArchitectureHealthEvidenceAnchor): string {
  const location = anchor.path === null ? null : `${anchor.path}${anchor.line === null ? '' : `:${anchor.line}`}`;
  const details = [
    location,
    anchor.symbol === null ? null : `symbol=${anchor.symbol}`,
    anchor.source === null ? null : `source=${anchor.source}`,
    anchor.target === null ? null : `target=${anchor.target}`,
    anchor.edgeKind === null ? null : `edgeKind=${anchor.edgeKind}`,
    anchor.provenance === null ? null : `provenance=${anchor.provenance}`,
  ].filter((part): part is string => part !== null);
  return details.join(', ') || 'unspecified';
}

function formatEvidenceAnchors(categories: readonly (readonly ArchitectureHealthFinding[])[]): string[] {
  const displayedFindings = categories.flatMap((findings) => findings.slice(0, CATEGORY_LIMIT));
  const anchors = displayedFindings.flatMap((finding) => finding.evidence.map((anchor) => ({ id: finding.id, anchor })));
  const lines = ['## Evidence Anchors'];
  if (anchors.length === 0) return [...lines, 'No evidence anchors.', ''];
  for (const { id, anchor } of anchors) lines.push(`- [${id}] ${formatEvidence(anchor)}`);
  return [...lines, ''];
}

function formatMetric(metric: ArchitectureHealthMetric): string {
  if (metric.kind === 'scalar') return `- ${metric.key}: ${formatValue(metric.value)}`;
  return `- ${metric.scope} ${metric.name}: Ca=${formatValue(metric.afferentCoupling)} Ce=${formatValue(metric.efferentCoupling)} I=${formatValue(metric.instability)}`;
}

function formatMetricDelta(delta: ArchitectureHealthMetricDelta): string {
  if (delta.kind === 'scalar') return `- ${delta.key}: ${formatValue(delta.baseline)} -> ${formatValue(delta.current)} (delta=${formatValue(delta.delta)})`;
  return `- ${delta.scope} ${delta.name} ${delta.metric}: ${formatValue(delta.baseline)} -> ${formatValue(delta.current)} (delta=${formatValue(delta.delta)})`;
}

function formatOptions(report: ArchitectureHealthReport): string[] {
  const lines = ['## Options'];
  if (report.options.layers.length === 0) return [...lines, 'Layers: none', ''];
  for (const layer of report.options.layers) lines.push(`- ${layer.name}: ${layer.paths.join(', ')}`);
  return [...lines, ''];
}

export function formatArchitectureHealthReport(input: ArchitectureHealthReport): string {
  const report = canonicalizeArchitectureHealthReport(input);
  const lines = [
    '## Architecture Health',
    '',
    `Analysis: ${report.analysisKind} v${report.analysisVersion}`,
    `Producer: solidkg=${report.producer.solidkgVersion}, schema=${report.producer.schemaVersion}, graphFactPolicy=${report.producer.graphFactPolicy}`,
    '',
    ...formatOptions(report),
    '## Coverage',
  ];
  for (const signal of report.signals) lines.push(...formatCoverage(signal.kind, signal.coverage));
  lines.push('', '## Findings');
  for (const signal of report.signals) lines.push(...formatFindingCategory(signal.kind, signal.findings));
  lines.push('## Metrics');
  for (const metric of report.metrics) lines.push(formatMetric(metric));
  lines.push('', ...formatEvidenceAnchors(report.signals.map((signal) => signal.findings)));
  return lines.join('\n').replace(ANSI_ESCAPE_SEQUENCE, '');
}

function formatDriftCoverage(label: string, records: SnapshotHealthDrift['currentCoverage'] | null): string[] {
  const lines = [`### ${label}`];
  if (records === null) return [...lines, 'Unavailable.', ''];
  for (const record of records) lines.push(...formatCoverage(record.signalKind, record.coverage));
  return [...lines, ''];
}

export function formatSnapshotHealthDrift(input: SnapshotHealthDrift): string {
  const drift = canonicalizeSnapshotHealthDrift(input);
  const semanticResultsAvailable = drift.comparisonStatus === 'comparable' || drift.comparisonStatus === 'partially_compatible';
  const lines = [
    `## Snapshot Health Drift: ${drift.baselineLabel}`,
    '',
    `Analysis: ${drift.analysisKind} v${drift.analysisVersion}`,
    `Comparison: ${drift.comparisonStatus}`,
    `Reasons: ${drift.reasons.length === 0 ? 'none' : drift.reasons.join(', ')}`,
    '',
    '## Coverage',
    ...formatDriftCoverage('Baseline', drift.baselineCoverage),
    ...formatDriftCoverage('Current', drift.currentCoverage),
  ];
  if (drift.omittedSignals.length > 0) {
    lines.push('### Omitted Signals');
    for (const signal of drift.omittedSignals) lines.push(`- ${signal.signalKind}: ${signal.reasons.join(', ')}`);
    lines.push('');
  }
  if (semanticResultsAvailable) {
    lines.push('## Findings', ...formatFindingCategory('Introduced', drift.introduced), ...formatFindingCategory('Resolved', drift.resolved), ...formatFindingCategory('Persisting', drift.persisting));
  }
  lines.push('## Metrics', '### Graph Diff Counts');
  for (const [key, value] of Object.entries(drift.graphDiffCounts)) lines.push(`- ${key}: ${formatValue(value)}`);
  if (semanticResultsAvailable) {
    lines.push('', '### Metric Deltas');
    if (drift.metricDeltas.length === 0) lines.push('No metric deltas.');
    else {
      for (const delta of drift.metricDeltas.slice(0, CATEGORY_LIMIT)) lines.push(formatMetricDelta(delta));
      if (drift.metricDeltas.length > CATEGORY_LIMIT) lines.push(`- +${drift.metricDeltas.length - CATEGORY_LIMIT} more`);
    }
  }
  const findings = semanticResultsAvailable ? [drift.introduced, drift.resolved, drift.persisting] : [];
  lines.push('', ...formatEvidenceAnchors(findings));
  return lines.join('\n').replace(ANSI_ESCAPE_SEQUENCE, '');
}
