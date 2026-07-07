import type { QueryBuilder } from '../db/queries';
import type { Edge, EdgeKind } from '../types';
import { boundedBfs, findPaths } from './traversal-primitives';

export type GraphTraversalDirection = 'forward' | 'reverse' | 'both';
export type GraphCoverageStatus = 'complete' | 'partial' | 'absent' | 'stale';
export type GraphTraversalLimit = 'maxDepth' | 'maxNodes' | 'maxEdges' | 'maxPaths' | 'budgetMs' | 'result_limit';

export interface GraphRevision {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly maxNodeUpdatedAt: number;
  readonly maxEdgeId: number;
}

export interface NeighborOptions {
  readonly direction: GraphTraversalDirection;
  readonly edgeKinds?: readonly EdgeKind[];
}

export interface BoundedTraversalOptions extends NeighborOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly budgetMs: number;
}

export interface PathTraversalOptions extends BoundedTraversalOptions {
  readonly maxPaths: number;
}

export interface GraphTraversalCoverage {
  readonly status: GraphCoverageStatus;
  readonly limitsHit: readonly GraphTraversalLimit[];
  readonly staleInputs: readonly string[];
}

export interface GraphPath {
  readonly nodeIds: readonly string[];
  readonly edges: readonly Edge[];
}

export interface GraphTraversalResult {
  readonly nodeIds: readonly string[];
  readonly edges: readonly Edge[];
  readonly paths: readonly GraphPath[];
  readonly depthByNode: ReadonlyMap<string, number>;
  readonly coverage: GraphTraversalCoverage;
}

type EdgeBuckets = Map<EdgeKind, Map<string, Edge[]>>;

const EMPTY_EDGES: readonly Edge[] = [];

function compareEdge(left: Edge, right: Edge): number {
  return left.kind.localeCompare(right.kind)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || (left.line ?? -1) - (right.line ?? -1)
    || (left.column ?? -1) - (right.column ?? -1)
    || (left.provenance ?? '').localeCompare(right.provenance ?? '')
    || JSON.stringify(left.metadata ?? {}).localeCompare(JSON.stringify(right.metadata ?? {}));
}

function addEdge(bucket: EdgeBuckets, key: string, edge: Edge): void {
  let byNode = bucket.get(edge.kind);
  if (!byNode) {
    byNode = new Map();
    bucket.set(edge.kind, byNode);
  }
  const edges = byNode.get(key) ?? [];
  edges.push(edge);
  byNode.set(key, edges);
}

export class RelationAwareAdjacencyIndex {
  private constructor(
    readonly revision: GraphRevision,
    private readonly forward: EdgeBuckets,
    private readonly reverse: EdgeBuckets,
  ) {}

  static build(queries: QueryBuilder): RelationAwareAdjacencyIndex {
    const edges = queries.getAllEdges();
    const forward: EdgeBuckets = new Map();
    const reverse: EdgeBuckets = new Map();
    for (const edge of edges) {
      addEdge(forward, edge.source, edge);
      addEdge(reverse, edge.target, edge);
    }
    for (const bucket of [forward, reverse]) {
      for (const byNode of bucket.values()) {
        for (const edgesForNode of byNode.values()) {
          edgesForNode.sort(compareEdge);
        }
      }
    }
    return new RelationAwareAdjacencyIndex(queries.getGraphRevision(), forward, reverse);
  }

  isFresh(revision: GraphRevision): boolean {
    return this.revision.nodeCount === revision.nodeCount
      && this.revision.edgeCount === revision.edgeCount
      && this.revision.maxNodeUpdatedAt === revision.maxNodeUpdatedAt
      && this.revision.maxEdgeId === revision.maxEdgeId;
  }

  getNeighbors(nodeId: string, options: NeighborOptions): Edge[] {
    const kinds = options.edgeKinds && options.edgeKinds.length > 0
      ? [...options.edgeKinds].sort((left, right) => left.localeCompare(right))
      : this.allKindsFor(nodeId, options.direction);
    const edges: Edge[] = [];
    for (const kind of kinds) {
      if (options.direction === 'forward' || options.direction === 'both') {
        edges.push(...(this.forward.get(kind)?.get(nodeId) ?? EMPTY_EDGES));
      }
      if (options.direction === 'reverse' || options.direction === 'both') {
        edges.push(...(this.reverse.get(kind)?.get(nodeId) ?? EMPTY_EDGES));
      }
    }
    return edges.sort(compareEdge);
  }

  getRelationCounts(nodeId: string): Partial<Record<EdgeKind, number>> {
    const counts: Partial<Record<EdgeKind, number>> = {};
    for (const direction of ['forward', 'reverse'] as const) {
      for (const edge of this.getNeighbors(nodeId, { direction })) {
        counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
  }

  boundedBfs(startNodeIds: readonly string[], options: BoundedTraversalOptions): GraphTraversalResult {
    return boundedBfs(this, startNodeIds, options);
  }

  findPaths(sourceId: string, targetId: string, options: PathTraversalOptions): GraphTraversalResult {
    return findPaths(this, sourceId, targetId, options);
  }

  private allKindsFor(nodeId: string, direction: GraphTraversalDirection): EdgeKind[] {
    const kinds = new Set<EdgeKind>();
    const addKinds = (bucket: EdgeBuckets): void => {
      for (const [kind, byNode] of bucket) {
        if (byNode.has(nodeId)) kinds.add(kind);
      }
    };
    if (direction === 'forward' || direction === 'both') addKinds(this.forward);
    if (direction === 'reverse' || direction === 'both') addKinds(this.reverse);
    return [...kinds].sort((left, right) => left.localeCompare(right));
  }
}
