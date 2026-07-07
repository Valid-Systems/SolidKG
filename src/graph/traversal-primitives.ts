import type { Edge } from '../types';
import type {
  BoundedTraversalOptions,
  GraphPath,
  GraphTraversalLimit,
  GraphTraversalResult,
  GraphCoverageStatus,
  PathTraversalOptions,
  RelationAwareAdjacencyIndex,
} from './adjacency';

function emptyCoverage(status: GraphCoverageStatus) {
  return { status, limitsHit: [], staleInputs: [] };
}

function sortedLimits(limits: ReadonlySet<GraphTraversalLimit>): readonly GraphTraversalLimit[] {
  return [...limits].sort((left, right) => left.localeCompare(right));
}

function traversalStatus(limits: ReadonlySet<GraphTraversalLimit>, hasResult: boolean): GraphCoverageStatus {
  if (limits.size > 0) return 'partial';
  return hasResult ? 'complete' : 'absent';
}

function nextNodeId(edge: Edge, currentNodeId: string): string {
  return edge.source === currentNodeId ? edge.target : edge.source;
}

export function boundedBfs(
  index: RelationAwareAdjacencyIndex,
  startNodeIds: readonly string[],
  options: BoundedTraversalOptions,
): GraphTraversalResult {
  const limitsHit = new Set<GraphTraversalLimit>();
  const startedAt = Date.now();
  const nodeIds: string[] = [];
  const edges: Edge[] = [];
  const visited = new Set<string>();
  const depthByNode = new Map<string, number>();
  const queue: Array<{ readonly nodeId: string; readonly depth: number }> = [];

  for (const nodeId of startNodeIds) {
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    depthByNode.set(nodeId, 0);
    nodeIds.push(nodeId);
    queue.push({ nodeId, depth: 0 });
  }

  while (queue.length > 0) {
    if (Date.now() - startedAt > options.budgetMs) {
      limitsHit.add('budgetMs');
      break;
    }
    const step = queue.shift();
    if (!step) break;
    const neighbors = index.getNeighbors(step.nodeId, options);
    if (step.depth >= options.maxDepth) {
      if (neighbors.length > 0) limitsHit.add('maxDepth');
      continue;
    }
    for (const edge of neighbors) {
      if (edges.length >= options.maxEdges) {
        limitsHit.add('maxEdges');
        break;
      }
      edges.push(edge);
      const nextId = nextNodeId(edge, step.nodeId);
      if (visited.has(nextId)) continue;
      if (nodeIds.length >= options.maxNodes) {
        limitsHit.add('maxNodes');
        continue;
      }
      visited.add(nextId);
      depthByNode.set(nextId, step.depth + 1);
      nodeIds.push(nextId);
      queue.push({ nodeId: nextId, depth: step.depth + 1 });
    }
  }

  return {
    nodeIds,
    edges,
    paths: [],
    depthByNode,
    coverage: {
      status: traversalStatus(limitsHit, nodeIds.length > startNodeIds.length),
      limitsHit: sortedLimits(limitsHit),
      staleInputs: [],
    },
  };
}

export function findPaths(
  index: RelationAwareAdjacencyIndex,
  sourceId: string,
  targetId: string,
  options: PathTraversalOptions,
): GraphTraversalResult {
  const limitsHit = new Set<GraphTraversalLimit>();
  const startedAt = Date.now();
  const visited = new Set<string>();
  const nodeIds: string[] = [sourceId];
  const depthByNode = new Map<string, number>([[sourceId, 0]]);
  const paths: GraphPath[] = [];
  const traversedEdges: Edge[] = [];
  const queue: Array<{ readonly nodeId: string; readonly depth: number; readonly pathNodeIds: readonly string[]; readonly pathEdges: readonly Edge[] }> = [
    { nodeId: sourceId, depth: 0, pathNodeIds: [sourceId], pathEdges: [] },
  ];

  while (queue.length > 0 && paths.length < options.maxPaths) {
    if (Date.now() - startedAt > options.budgetMs) {
      limitsHit.add('budgetMs');
      break;
    }
    const step = queue.shift();
    if (!step) break;
    if (step.nodeId === targetId) {
      paths.push({ nodeIds: step.pathNodeIds, edges: step.pathEdges });
      continue;
    }
    if (visited.has(step.nodeId)) continue;
    visited.add(step.nodeId);
    const neighbors = index.getNeighbors(step.nodeId, options);
    if (step.depth >= options.maxDepth) {
      if (neighbors.length > 0) limitsHit.add('maxDepth');
      continue;
    }
    for (const edge of neighbors) {
      if (traversedEdges.length >= options.maxEdges) {
        limitsHit.add('maxEdges');
        break;
      }
      traversedEdges.push(edge);
      const nextId = nextNodeId(edge, step.nodeId);
      if (step.pathNodeIds.includes(nextId)) continue;
      if (!depthByNode.has(nextId)) {
        if (nodeIds.length >= options.maxNodes) {
          limitsHit.add('maxNodes');
          continue;
        }
        nodeIds.push(nextId);
        depthByNode.set(nextId, step.depth + 1);
      }
      queue.push({
        nodeId: nextId,
        depth: step.depth + 1,
        pathNodeIds: [...step.pathNodeIds, nextId],
        pathEdges: [...step.pathEdges, edge],
      });
    }
  }
  if (paths.length >= options.maxPaths && queue.length > 0) limitsHit.add('maxPaths');

  return {
    nodeIds,
    edges: traversedEdges,
    paths,
    depthByNode,
    coverage: {
      status: traversalStatus(limitsHit, paths.length > 0),
      limitsHit: sortedLimits(limitsHit),
      staleInputs: [],
    },
  };
}

export function explainPath(path: GraphPath): string {
  if (path.edges.length === 0) return 'empty path';
  return path.edges.map((edge) => edge.kind).join(' -> ');
}

export function absentTraversal(startNodeIds: readonly string[]): GraphTraversalResult {
  return {
    nodeIds: [...startNodeIds],
    edges: [],
    paths: [],
    depthByNode: new Map(startNodeIds.map((nodeId) => [nodeId, 0])),
    coverage: emptyCoverage('absent'),
  };
}
