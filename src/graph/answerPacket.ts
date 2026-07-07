import type { Edge, EdgeKind } from '../types';
import type { GraphTraversalCoverage, GraphTraversalDirection, GraphTraversalResult } from './adjacency';
import { explainPath } from './traversal-primitives';

export interface GraphTraversalPacket {
  readonly schemaVersion: 'solidkg.graph-traversal-packet.v1';
  readonly query: {
    readonly kind: string;
    readonly start: readonly string[];
    readonly target?: string;
    readonly edgeKinds: readonly EdgeKind[];
    readonly direction: GraphTraversalDirection;
    readonly maxDepth: number;
    readonly limits: {
      readonly maxNodes?: number;
      readonly maxEdges?: number;
      readonly maxPaths?: number;
      readonly budgetMs?: number;
    };
  };
  readonly result: {
    readonly nodes: readonly string[];
    readonly edges: readonly string[];
    readonly paths: readonly string[];
    readonly summary: string;
    readonly relationCounts: Partial<Record<EdgeKind, number>>;
  };
  readonly evidence: {
    readonly deterministic: readonly string[];
    readonly scip: readonly string[];
    readonly treeSitter: readonly string[];
    readonly heuristic: readonly string[];
    readonly annotation: readonly string[];
  };
  readonly coverage: GraphTraversalCoverage;
  readonly nextQueries: ReadonlyArray<{ readonly tool: string; readonly reason: string; readonly args: Record<string, unknown> }>;
}

export interface BuildGraphTraversalPacketArgs {
  readonly queryKind: string;
  readonly startNodeIds: readonly string[];
  readonly targetNodeId?: string;
  readonly direction: GraphTraversalDirection;
  readonly edgeKinds: readonly EdgeKind[];
  readonly maxDepth: number;
  readonly limits?: GraphTraversalPacket['query']['limits'];
  readonly result: GraphTraversalResult;
  readonly relationCounts?: Partial<Record<EdgeKind, number>>;
}

function edgeLabel(edge: Edge): string {
  return `${edge.kind}: ${edge.source} -> ${edge.target}`;
}

function evidenceFor(edges: readonly Edge[]): GraphTraversalPacket['evidence'] {
  const deterministic: string[] = [];
  const scip: string[] = [];
  const treeSitter: string[] = [];
  const heuristic: string[] = [];
  for (const edge of edges) {
    const label = edgeLabel(edge);
    if (edge.provenance === 'scip') {
      scip.push(label);
    } else if (edge.provenance === 'heuristic') {
      heuristic.push(label);
    } else if (edge.provenance === 'tree-sitter') {
      treeSitter.push(label);
      deterministic.push(label);
    } else {
      deterministic.push(label);
    }
  }
  return {
    deterministic: [...new Set(deterministic)].sort((left, right) => left.localeCompare(right)),
    scip: [...new Set(scip)].sort((left, right) => left.localeCompare(right)),
    treeSitter: [...new Set(treeSitter)].sort((left, right) => left.localeCompare(right)),
    heuristic: [...new Set(heuristic)].sort((left, right) => left.localeCompare(right)),
    annotation: [],
  };
}

export function buildGraphTraversalPacket(args: BuildGraphTraversalPacketArgs): GraphTraversalPacket {
  const edgeLabels = args.result.edges.map(edgeLabel);
  const pathLabels = args.result.paths.map(explainPath);
  const summary = `${args.queryKind}: ${args.result.nodeIds.length} node(s), ${args.result.edges.length} edge(s), coverage ${args.result.coverage.status}`;
  const nextQueries = args.result.coverage.status === 'complete'
    ? []
    : [{ tool: 'solidkg_node', reason: 'Inspect a bounded frontier symbol when traversal coverage is partial or absent.', args: {} }];
  return {
    schemaVersion: 'solidkg.graph-traversal-packet.v1',
    query: {
      kind: args.queryKind,
      start: [...args.startNodeIds],
      ...(args.targetNodeId ? { target: args.targetNodeId } : {}),
      edgeKinds: [...args.edgeKinds],
      direction: args.direction,
      maxDepth: args.maxDepth,
      limits: args.limits ?? {},
    },
    result: {
      nodes: [...args.result.nodeIds],
      edges: edgeLabels,
      paths: pathLabels,
      summary,
      relationCounts: Object.fromEntries(Object.entries(args.relationCounts ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    },
    evidence: evidenceFor(args.result.edges),
    coverage: args.result.coverage,
    nextQueries,
  };
}

export function formatGraphTraversalPacketMarkdown(packet: GraphTraversalPacket): string {
  const lines = [
    '### Graph Traversal Packet',
    `- Schema: ${packet.schemaVersion}`,
    `- Query: ${packet.query.kind}`,
    `- Direction: ${packet.query.direction}`,
    `- Edge kinds: ${packet.query.edgeKinds.length > 0 ? packet.query.edgeKinds.join(', ') : 'all'}`,
    `- Coverage: ${packet.coverage.status}`,
    `- Limits hit: ${packet.coverage.limitsHit.length > 0 ? packet.coverage.limitsHit.join(', ') : 'none'}`,
    `- Summary: ${packet.result.summary}`,
  ];
  const relationCounts = Object.entries(packet.result.relationCounts);
  if (relationCounts.length > 0) {
    lines.push('- Relation counts:');
    for (const [kind, count] of relationCounts) {
      lines.push(`  - ${kind}: ${count}`);
    }
  }
  if (packet.evidence.deterministic.length > 0 || packet.evidence.scip.length > 0 || packet.evidence.heuristic.length > 0) {
    lines.push('- Evidence:');
    if (packet.evidence.deterministic.length > 0) lines.push(`  - deterministic: ${packet.evidence.deterministic.slice(0, 5).join('; ')}`);
    if (packet.evidence.scip.length > 0) lines.push(`  - scip: ${packet.evidence.scip.slice(0, 5).join('; ')}`);
    if (packet.evidence.heuristic.length > 0) lines.push(`  - heuristic: ${packet.evidence.heuristic.slice(0, 5).join('; ')}`);
  }
  if (packet.nextQueries.length > 0) {
    lines.push('- Next queries:');
    for (const next of packet.nextQueries) {
      lines.push(`  - ${next.tool}: ${next.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
