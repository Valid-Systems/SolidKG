import type { QueryBuilder } from '../db/queries';
import type { Edge, EdgeKind, Node } from '../types';
import type { GraphTraversalDirection, GraphTraversalResult, GraphTraversalLimit } from './adjacency';

export interface RelatedNodeTraversalResult {
  readonly entries: ReadonlyArray<{ readonly node: Node; readonly edge: Edge }>;
  readonly traversal: GraphTraversalResult;
  readonly relationCounts: Partial<Record<EdgeKind, number>>;
}

export function relatedNodesFromTraversal(
  queries: QueryBuilder,
  traversal: GraphTraversalResult,
  startNodeIds: readonly string[],
  direction: Exclude<GraphTraversalDirection, 'both'>,
): RelatedNodeTraversalResult {
  const startIds = new Set(startNodeIds);
  const firstEdgeByNode = new Map<string, Edge>();
  for (const edge of traversal.edges) {
    const nodeId = direction === 'forward' ? edge.target : edge.source;
    if (!startIds.has(nodeId) && !firstEdgeByNode.has(nodeId)) {
      firstEdgeByNode.set(nodeId, edge);
    }
  }
  const orderedNodeIds = traversal.nodeIds.filter((nodeId) => !startIds.has(nodeId));
  const nodes = queries.getNodesByIds(orderedNodeIds);
  const entries: Array<{ readonly node: Node; readonly edge: Edge }> = [];
  for (const nodeId of orderedNodeIds) {
    const node = nodes.get(nodeId);
    const edge = firstEdgeByNode.get(nodeId);
    if (node && edge) entries.push({ node, edge });
  }
  return { entries, traversal, relationCounts: relationCountsForEdges(traversal.edges) };
}

export function relationCountsForEdges(edges: readonly Edge[]): Partial<Record<EdgeKind, number>> {
  const counts: Partial<Record<EdgeKind, number>> = {};
  for (const edge of edges) {
    counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function mergeTraversalResults(startNodeIds: readonly string[], traversals: readonly GraphTraversalResult[]): GraphTraversalResult {
  const nodeIds = new Set<string>(startNodeIds);
  const edges = new Map<string, Edge>();
  const depthByNode = new Map<string, number>(startNodeIds.map((nodeId) => [nodeId, 0]));
  const limits = new Set<GraphTraversalLimit>();
  for (const traversal of traversals) {
    for (const nodeId of traversal.nodeIds) nodeIds.add(nodeId);
    for (const edge of traversal.edges) {
      edges.set(`${edge.source}->${edge.target}:${edge.kind}:${edge.line ?? ''}:${edge.column ?? ''}`, edge);
    }
    for (const [nodeId, depth] of traversal.depthByNode) {
      const existing = depthByNode.get(nodeId);
      if (existing === undefined || depth < existing) depthByNode.set(nodeId, depth);
    }
    for (const limit of traversal.coverage.limitsHit) limits.add(limit);
  }
  const hasResult = nodeIds.size > startNodeIds.length;
  return {
    nodeIds: [...nodeIds],
    edges: [...edges.values()],
    paths: [],
    depthByNode,
    coverage: {
      status: limits.size > 0 ? 'partial' : hasResult ? 'complete' : 'absent',
      limitsHit: [...limits].sort((left, right) => left.localeCompare(right)),
      staleInputs: [],
    },
  };
}

export function mergeRelationCounts(values: readonly Partial<Record<EdgeKind, number>>[]): Partial<Record<EdgeKind, number>> {
  const merged: Partial<Record<EdgeKind, number>> = {};
  for (const counts of values) {
    for (const [kind, count] of Object.entries(counts)) {
      const edgeKind = kind as EdgeKind;
      merged[edgeKind] = (merged[edgeKind] ?? 0) + (count ?? 0);
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

export function mergeLimits(values: readonly GraphTraversalResult[]): readonly GraphTraversalLimit[] {
  const limits = new Set<GraphTraversalLimit>();
  for (const value of values) {
    for (const limit of value.coverage.limitsHit) limits.add(limit);
  }
  return [...limits].sort((left, right) => left.localeCompare(right));
}
