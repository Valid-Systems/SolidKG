import SolidKG from '../index';
import {
  CAPABILITY_FOOTPRINT_SCHEMA,
  capabilityAssertionId,
  type CapabilityAssertion,
  type CapabilityCertainty,
  type CapabilityCoverageState,
  type CapabilityOperation,
  type CapabilityOrigin,
  type CapabilityResourceKind,
} from '../capabilities';
import type { HyperedgeRelation, Node } from '../types';

interface CapabilityEvidence {
  readonly assertion: CapabilityAssertion;
  readonly coverage: CapabilityCoverageState;
}

export function formatNodeCapabilityFootprint(cg: SolidKG, node: Node): string {
  const assertions = capabilityAssertionsForNode(cg, node, { includeRelationProjections: true });
  const coverage = capabilityCoverageForFile(cg, node.filePath);
  const lines = ['', `### Capability footprint (${CAPABILITY_FOOTPRINT_SCHEMA})`];
  lines.push(`- Coverage for ${node.filePath}: ${coverage}`);
  if (assertions.length === 0) {
    lines.push('- No capability assertions returned for this symbol.');
    return lines.join('\n');
  }
  for (const assertion of assertions.slice(0, 8)) {
    lines.push(`- ${formatCapabilityAssertion(assertion)}; coverage: ${coverage}`);
  }
  if (assertions.length > 8) lines.push(`- +${assertions.length - 8} more capability assertions`);
  return lines.join('\n');
}

export function formatTraceCapabilityFootprint(cg: SolidKG, nodes: readonly Node[]): string {
  const assertionsByNode = nodes.map((node) => ({
    node,
    coverage: capabilityCoverageForFile(cg, node.filePath),
    assertions: capabilityAssertionsForNode(cg, node, { includeRelationProjections: false }),
  }));
  const returnedEvidence = assertionsByNode.flatMap((entry) => entry.assertions.map((assertion) => ({ assertion, coverage: entry.coverage })));
  const lines = [`### Capability footprint (${CAPABILITY_FOOTPRINT_SCHEMA})`];
  lines.push('Per-hop capability evidence:');
  for (const entry of assertionsByNode) {
    lines.push(`- ${entry.node.name} (${entry.node.filePath}:${entry.node.startLine}); coverage: ${entry.coverage}`);
    if (entry.assertions.length === 0) {
      lines.push('  - No capability assertions returned for this hop.');
      continue;
    }
    for (const assertion of entry.assertions.slice(0, 4)) {
      lines.push(`  - ${formatCapabilityAssertion(assertion)}`);
    }
    if (entry.assertions.length > 4) lines.push(`  - +${entry.assertions.length - 4} more capability assertions`);
  }
  lines.push('May-footprint aggregate:');
  const aggregates = aggregateCapabilityEvidence(returnedEvidence).slice(0, 8);
  if (aggregates.length === 0) lines.push('- No capability assertions returned on this path.');
  for (const aggregate of aggregates) {
    lines.push(`- ${aggregate.label} (${aggregate.count} support${aggregate.count === 1 ? '' : 's'}; coverage: ${aggregate.coverage})`);
  }
  return lines.join('\n');
}

function capabilityAssertionsForNode(
  cg: SolidKG,
  node: Node,
  options: { readonly includeRelationProjections: boolean }
): CapabilityAssertion[] {
  const stored = cg.getCapabilityAssertionsByNodeIds([node.id]);
  const projected = options.includeRelationProjections
    ? cg.getHyperedgesByNode(node.id)
      .map((relation) => projectCapabilityAssertion(relation, node.id))
      .filter((assertion): assertion is CapabilityAssertion => assertion !== null)
    : [];
  const byId = new Map<string, CapabilityAssertion>();
  for (const assertion of [...stored, ...projected]) byId.set(assertion.id, assertion);
  return [...byId.values()].sort((left, right) =>
    left.resourceKind.localeCompare(right.resourceKind) ||
    left.resourceKey.localeCompare(right.resourceKey) ||
    left.operation.localeCompare(right.operation) ||
    left.id.localeCompare(right.id)
  );
}

function projectCapabilityAssertion(relation: HyperedgeRelation, nodeId: string): CapabilityAssertion | null {
  const member = relation.members.find((candidate) => candidate.nodeId === nodeId);
  if (!member) return null;
  const projected = projectedCapabilityShape(relation, member.role);
  if (!projected) return null;
  const sourceLine = relation.hyperedge.line ?? member.node.startLine;
  const base = {
    subjectNodeId: member.node.id,
    operation: projected.operation,
    resourceKind: projected.resourceKind,
    resourceKey: semanticRelationLabel(relation),
    scope: 'relation_scoped',
    filePath: member.node.filePath,
    startLine: sourceLine,
    startColumn: relation.hyperedge.column ?? member.node.startColumn,
    endLine: sourceLine,
    endColumn: relation.hyperedge.column ?? member.node.endColumn,
    origin: capabilityOriginForRelation(relation),
    certainty: capabilityCertaintyForRelation(relation),
    producerId: 'solidkg.hyperedge-projection',
    ruleId: `hyperedge.${relation.hyperedge.kind}.${member.role}`,
    producerVersion: '1',
    supportingHyperedgeId: relation.hyperedge.id,
    metadata: { hyperedgeKind: relation.hyperedge.kind, role: member.role },
  } satisfies Omit<CapabilityAssertion, 'id'>;
  return { id: capabilityAssertionId(base), ...base };
}

function projectedCapabilityShape(
  relation: HyperedgeRelation,
  role: string
): { readonly operation: CapabilityOperation; readonly resourceKind: CapabilityResourceKind } | null {
  if (relation.hyperedge.kind === 'event_channel') {
    if (['emitter', 'publisher', 'producer', 'source'].includes(role)) return { operation: 'emit', resourceKind: 'channel' };
    if (['listener', 'subscriber', 'handler', 'callback'].includes(role)) return { operation: 'subscribe', resourceKind: 'channel' };
  }
  if (relation.hyperedge.kind === 'dynamic_dispatch' && ['callback', 'listener', 'handler', 'target'].includes(role)) {
    return { operation: 'subscribe', resourceKind: 'channel' };
  }
  if (relation.hyperedge.kind === 'ui_render') return { operation: 'send', resourceKind: 'ui' };
  if (relation.hyperedge.kind === 'native_bridge') return { operation: 'send', resourceKind: 'channel' };
  if (relation.hyperedge.kind === 'route_binding' && ['middleware', 'validator'].includes(role) && isAuthRelation(relation)) return { operation: 'guard', resourceKind: 'auth' };
  return null;
}

function isAuthRelation(relation: HyperedgeRelation): boolean {
  const label = semanticRelationLabel(relation).toLowerCase();
  if (label.includes('auth') || label.includes('jwt') || label.includes('session') || label.includes('permission')) return true;
  return relation.members.some((member) => {
    const name = member.node.name.toLowerCase();
    return name.includes('auth') || name.includes('jwt') || name.includes('session') || name.includes('permission');
  });
}

function capabilityOriginForRelation(relation: HyperedgeRelation): CapabilityOrigin {
  switch (relation.hyperedge.provenance) {
    case 'scip': return 'scip';
    case 'tree-sitter': return 'ast';
    case 'heuristic':
    case 'manual':
    case undefined:
      return 'semantic_synthesis';
  }
}

function capabilityCertaintyForRelation(relation: HyperedgeRelation): CapabilityCertainty {
  switch (relation.hyperedge.provenance) {
    case 'scip': return 'precise';
    case 'tree-sitter': return 'static';
    case 'heuristic': return 'heuristic';
    case 'manual':
    case undefined:
      return 'unverified';
  }
}

function capabilityCoverageForFile(cg: SolidKG, filePath: string): CapabilityCoverageState {
  const runs = cg.getCapabilityAnalysisRuns([filePath]);
  if (runs.length === 0) return 'not_run';
  const file = cg.getFiles().find((candidate) => candidate.path === filePath);
  if (file && runs.some((run) => run.sourceHash !== file.contentHash)) return 'stale';
  if (runs.some((run) => run.status === 'failed')) return 'failed';
  if (runs.some((run) => run.status === 'partial')) return 'partial';
  if (runs.every((run) => run.status === 'unsupported')) return 'unsupported';
  return 'complete';
}

function aggregateCapabilityEvidence(evidence: readonly CapabilityEvidence[]): Array<{ readonly label: string; readonly count: number; readonly coverage: CapabilityCoverageState }> {
  const aggregates = new Map<string, { label: string; count: number; coverage: CapabilityCoverageState }>();
  for (const { assertion, coverage } of evidence) {
    const key = `${assertion.operation}:${assertion.resourceKind}:${assertion.resourceKey}`;
    const existing = aggregates.get(key);
    if (existing) {
      existing.count += 1;
      existing.coverage = leastCompleteCoverage(existing.coverage, coverage);
    } else {
      aggregates.set(key, { label: formatCapabilityResource(assertion), count: 1, coverage });
    }
  }
  return [...aggregates.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function leastCompleteCoverage(left: CapabilityCoverageState, right: CapabilityCoverageState): CapabilityCoverageState {
  const rank: Record<CapabilityCoverageState, number> = {
    failed: 0,
    stale: 1,
    partial: 2,
    not_run: 3,
    unsupported: 4,
    complete: 5,
  };
  return rank[left] <= rank[right] ? left : right;
}

function formatCapabilityAssertion(assertion: CapabilityAssertion): string {
  const source = sanitizeInlineText(`${assertion.filePath}:${assertion.startLine}:${assertion.startColumn}`);
  return `${formatCapabilityResource(assertion)} — scope: ${assertion.scope}; origin: ${assertion.origin}; certainty: ${assertion.certainty}; source: ${source}; id: ${assertion.id}`;
}

function formatCapabilityResource(assertion: Pick<CapabilityAssertion, 'operation' | 'resourceKind' | 'resourceKey'>): string {
  return `${assertion.operation} ${assertion.resourceKind} \`${sanitizeCodeSpan(assertion.resourceKey)}\``;
}

function sanitizeCodeSpan(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').replace(/`/g, '\u02cb');
}

function sanitizeInlineText(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ');
}

function semanticRelationLabel(relation: HyperedgeRelation): string {
  const metadata = relation.hyperedge.metadata ?? {};
  for (const key of ['channel', 'event', 'eventName', 'route', 'path', 'method', 'name', 'synthesizedBy']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  if (relation.hyperedge.sourceFile) return relation.hyperedge.line ? `${relation.hyperedge.sourceFile}:${relation.hyperedge.line}` : relation.hyperedge.sourceFile;
  return relation.hyperedge.id;
}
