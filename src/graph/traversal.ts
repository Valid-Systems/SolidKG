/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the code knowledge graph.
 */

import {
  Node,
  Edge,
  Subgraph,
  TraversalOptions,
  EdgeKind,
  HyperedgeKind,
  HyperedgeRelation,
  NodeKind,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { RelationAwareAdjacencyIndex, type GraphTraversalResult } from './adjacency';
import { relatedNodesFromTraversal, type RelatedNodeTraversalResult } from './traversal-results';

/**
 * Default traversal options
 */
interface NormalizedTraversalOptions {
  maxDepth: number;
  edgeKinds: EdgeKind[];
  nodeKinds: NodeKind[];
  direction: 'outgoing' | 'incoming' | 'both';
  limit: number;
  includeStart: boolean;
  includeHyperedges: boolean;
  hyperedgeKinds: HyperedgeKind[];
  hyperedgeExpansion: 'members' | 'ordered-flow';
  maxHyperedges: number;
}

const DEFAULT_OPTIONS: NormalizedTraversalOptions = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
  includeHyperedges: false,
  hyperedgeKinds: [],
  hyperedgeExpansion: 'members',
  maxHyperedges: 20,
};

interface HyperedgeTraversalState {
  included: Map<string, HyperedgeRelation>;
}

function compareHyperedgeRelations(a: HyperedgeRelation, b: HyperedgeRelation): number {
  return a.hyperedge.kind.localeCompare(b.hyperedge.kind) || a.hyperedge.id.localeCompare(b.hyperedge.id);
}

function compareHyperedgeMembers(
  a: HyperedgeRelation['members'][number],
  b: HyperedgeRelation['members'][number]
): number {
  return a.ordinal - b.ordinal
    || a.role.localeCompare(b.role)
    || a.node.name.localeCompare(b.node.name)
    || a.nodeId.localeCompare(b.nodeId);
}

/**
 * Result of a single traversal step
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/**
 * Graph traverser for BFS and DFS traversal
 */
export class GraphTraverser {
  private queries: QueryBuilder;
  private adjacencyIndex: RelationAwareAdjacencyIndex | null = null;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  private getAdjacencyIndex(): RelationAwareAdjacencyIndex {
    const revision = this.queries.getGraphRevision();
    if (!this.adjacencyIndex || !this.adjacencyIndex.isFresh(revision)) {
      this.adjacencyIndex = RelationAwareAdjacencyIndex.build(this.queries);
    }
    return this.adjacencyIndex;
  }

  /**
   * Traverse the graph using breadth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = this.normalizeOptions(options);
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const hyperedgeState = this.createHyperedgeState(opts);
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      // Add edge to result
      if (edge) {
        edges.push(edge);
      }

      // Check depth limit
      if (depth >= opts.maxDepth) {
        continue;
      }

      // Get adjacent edges, prioritizing structural edges (contains, calls)
      // over reference edges so BFS discovers internal structure before
      // fanning out to external references (e.g., component usages in templates).
      const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => {
        const priority = (e: Edge) => e.kind === 'contains' ? 0 : e.kind === 'calls' ? 1 : 2;
        return priority(a) - priority(b);
      });

      // Batch-fetch the unvisited neighbors in one query (was N+1 per BFS step).
      const wantIds = adjacentEdges
        .map((e) => (e.source === node.id ? e.target : e.source))
        .filter((id) => !visited.has(id));
      const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const adjEdge of adjacentEdges) {
        if (nodes.size >= opts.limit) break;

        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
        if (visited.has(nextNodeId)) continue;

        const nextNode = neighborNodes.get(nextNodeId);
        if (!nextNode) continue;

        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        nodes.set(nextNode.id, nextNode);
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }

      if (hyperedgeState) {
        const hyperedgeNeighbors = this.getHyperedgeNeighbors(node.id, opts, hyperedgeState);
        for (const nextNode of hyperedgeNeighbors) {
          if (visited.has(nextNode.id) || nodes.size >= opts.limit) continue;
          if (!this.matchesNodeKind(nextNode, opts)) continue;

          nodes.set(nextNode.id, nextNode);
          queue.push({ node: nextNode, edge: null, depth: depth + 1 });
        }
      }
    }

    const subgraph: Subgraph = {
      nodes,
      edges,
      roots: [startId],
    };
    this.attachHyperedges(subgraph, hyperedgeState);
    return subgraph;
  }

  /**
   * Traverse the graph using depth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = this.normalizeOptions(options);
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const hyperedgeState = this.createHyperedgeState(opts);

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    this.dfsRecursive(startNode, 0, opts, nodes, edges, visited, hyperedgeState);

    const subgraph: Subgraph = {
      nodes,
      edges,
      roots: [startId],
    };
    this.attachHyperedges(subgraph, hyperedgeState);
    return subgraph;
  }

  /**
   * Recursive DFS helper
   */
  private dfsRecursive(
    node: Node,
    depth: number,
    opts: NormalizedTraversalOptions,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>,
    hyperedgeState?: HyperedgeTraversalState
  ): void {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    // Get adjacent edges
    const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

    // Batch-fetch unvisited neighbors (was N+1 per DFS step).
    const wantIds = adjacentEdges
      .map((e) => (e.source === node.id ? e.target : e.source))
      .filter((id) => !visited.has(id));
    const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

    for (const edge of adjacentEdges) {
      if (nodes.size >= opts.limit) break;

      const nextNodeId = edge.source === node.id ? edge.target : edge.source;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

      // Apply node kind filter
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      // Add node and edge to result
      nodes.set(nextNode.id, nextNode);
      edges.push(edge);

      // Recurse
      this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited, hyperedgeState);
    }

    if (hyperedgeState) {
      const hyperedgeNeighbors = this.getHyperedgeNeighbors(node.id, opts, hyperedgeState);
      for (const nextNode of hyperedgeNeighbors) {
        if (visited.has(nextNode.id) || nodes.size >= opts.limit) continue;
        if (!this.matchesNodeKind(nextNode, opts)) continue;

        nodes.set(nextNode.id, nextNode);
        this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited, hyperedgeState);
      }
    }
  }

  /**
   * Get adjacent edges based on direction
   */
  private getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): Edge[] {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      // Both directions
      const outgoing = this.queries.getOutgoingEdges(nodeId, kinds);
      const incoming = this.queries.getIncomingEdges(nodeId, kinds);
      return [...outgoing, ...incoming];
    }
  }

  private normalizeOptions(options: TraversalOptions): NormalizedTraversalOptions {
    const hyperedgeOptions = options as Partial<Pick<NormalizedTraversalOptions,
      'includeHyperedges' | 'hyperedgeKinds' | 'hyperedgeExpansion' | 'maxHyperedges'
    >>;
    return {
      ...DEFAULT_OPTIONS,
      ...options,
      edgeKinds: options.edgeKinds ?? DEFAULT_OPTIONS.edgeKinds,
      nodeKinds: options.nodeKinds ?? DEFAULT_OPTIONS.nodeKinds,
      includeHyperedges: hyperedgeOptions.includeHyperedges === true,
      hyperedgeKinds: hyperedgeOptions.hyperedgeKinds ?? DEFAULT_OPTIONS.hyperedgeKinds,
      hyperedgeExpansion: hyperedgeOptions.hyperedgeExpansion ?? DEFAULT_OPTIONS.hyperedgeExpansion,
      maxHyperedges: hyperedgeOptions.maxHyperedges ?? DEFAULT_OPTIONS.maxHyperedges,
    };
  }

  private createHyperedgeState(opts: NormalizedTraversalOptions): HyperedgeTraversalState | undefined {
    if (!opts.includeHyperedges || opts.maxHyperedges <= 0) {
      return undefined;
    }
    return { included: new Map() };
  }

  private attachHyperedges(subgraph: Subgraph, state?: HyperedgeTraversalState): void {
    if (!state || state.included.size === 0) {
      return;
    }
    subgraph.hyperedges = Array.from(state.included.values()).sort(compareHyperedgeRelations);
  }

  private getHyperedgeNeighbors(
    nodeId: string,
    opts: NormalizedTraversalOptions,
    state: HyperedgeTraversalState
  ): Node[] {
    const relations = this.queries
      .getHyperedgesByNode(nodeId)
      .filter((relation) => this.matchesHyperedgeKind(relation, opts))
      .sort(compareHyperedgeRelations);
    const neighbors: Node[] = [];
    const seen = new Set<string>();

    for (const relation of relations) {
      const relationId = relation.hyperedge.id;
      if (!state.included.has(relationId)) {
        if (state.included.size >= opts.maxHyperedges) {
          continue;
        }
        state.included.set(relationId, this.sortedRelation(relation));
      }

      const members = this.sortedRelation(relation).members;
      const currentMembers = members.filter((member) => member.nodeId === nodeId);
      if (currentMembers.length === 0) continue;

      const candidates = opts.hyperedgeExpansion === 'ordered-flow'
        ? members.filter((member) => currentMembers.some((current) => member.ordinal > current.ordinal))
        : members.filter((member) => member.nodeId !== nodeId);

      for (const member of candidates) {
        if (seen.has(member.nodeId)) continue;
        seen.add(member.nodeId);
        neighbors.push(member.node);
      }
    }

    return neighbors;
  }

  private matchesHyperedgeKind(relation: HyperedgeRelation, opts: NormalizedTraversalOptions): boolean {
    return opts.hyperedgeKinds.length === 0 || opts.hyperedgeKinds.includes(relation.hyperedge.kind);
  }

  private matchesNodeKind(node: Node, opts: NormalizedTraversalOptions): boolean {
    return opts.nodeKinds.length === 0 || opts.nodeKinds.includes(node.kind);
  }

  private sortedRelation(relation: HyperedgeRelation): HyperedgeRelation {
    return {
      hyperedge: relation.hyperedge,
      members: [...relation.members].sort(compareHyperedgeMembers),
    };
  }

  /**
   * Find all callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return [...this.getCallersDetailed(nodeId, maxDepth).entries];
  }

  getCallersDetailed(nodeId: string, maxDepth: number = 1): RelatedNodeTraversalResult {
    const index = this.getAdjacencyIndex();
    const traversal = index.boundedBfs([nodeId], {
      direction: 'reverse',
      edgeKinds: ['calls'],
      maxDepth,
      maxNodes: 1000,
      maxEdges: 5000,
      budgetMs: 100,
    });
    return relatedNodesFromTraversal(this.queries, traversal, [nodeId], 'reverse');
  }

  /**
   * Find all functions/methods called by a function
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return [...this.getCalleesDetailed(nodeId, maxDepth).entries];
  }

  getCalleesDetailed(nodeId: string, maxDepth: number = 1): RelatedNodeTraversalResult {
    const index = this.getAdjacencyIndex();
    const traversal = index.boundedBfs([nodeId], {
      direction: 'forward',
      edgeKinds: ['calls'],
      maxDepth,
      maxNodes: 1000,
      maxEdges: 5000,
      budgetMs: 100,
    });
    return relatedNodesFromTraversal(this.queries, traversal, [nodeId], 'forward');
  }

  /**
   * Get the call graph for a function (both callers and callees)
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get callers
    const callers = this.getCallers(nodeId, depth);
    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    // Get callees
    const callees = this.getCallees(nodeId, depth);
    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get ancestors (what this extends/implements)
    this.getTypeAncestors(nodeId, nodes, edges, visited);

    // Get descendants (what extends/implements this)
    this.getTypeDescendants(nodeId, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getTypeAncestors(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['extends', 'implements']);
    if (outgoingEdges.length === 0) return;
    const parents = this.queries.getNodesByIds(outgoingEdges.map((e) => e.target));

    for (const edge of outgoingEdges) {
      const parentNode = parents.get(edge.target);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private getTypeDescendants(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['extends', 'implements']);
    if (incomingEdges.length === 0) return;
    const children = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const childNode = children.get(edge.source);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  /**
   * Find all usages of a symbol
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    // Get all incoming edges (references, calls, type_of, etc.)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return result;

    // Batch-fetch source nodes (was N+1).
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));
    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode) result.push({ node: sourceNode, edge });
    }

    return result;
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Traverse incoming edges to find all dependents
    this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // For container nodes (classes, interfaces, structs, etc.), also traverse
    // into their children so that callers of contained methods appear in impact
    const focalNode = this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
        if (containsEdges.length > 0) {
          const children = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.target);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              // Recurse into children at the same depth (they're part of the same symbol)
              this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    // Get all incoming edges (things that depend on this node)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return;
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = []
  ): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    const result = this.getAdjacencyIndex().findPaths(fromId, toId, {
      direction: 'forward',
      edgeKinds,
      maxDepth: 50,
      maxNodes: 5000,
      maxEdges: 20000,
      maxPaths: 1,
      budgetMs: 500,
    });
    const path = result.paths[0];
    if (!path) return null;
    const pathNodes = this.queries.getNodesByIds(path.nodeIds);
    const steps: Array<{ node: Node; edge: Edge | null }> = [];
    for (let index = 0; index < path.nodeIds.length; index++) {
      const nodeId = path.nodeIds[index];
      if (!nodeId) return null;
      const node = pathNodes.get(nodeId);
      if (!node) return null;
      steps.push({ node, edge: index === 0 ? null : path.edges[index - 1] ?? null });
    }
    return steps;
  }

  getImpactTraversal(nodeId: string, maxDepth: number = 3): GraphTraversalResult {
    return this.getAdjacencyIndex().boundedBfs([nodeId], {
      direction: 'reverse',
      edgeKinds: [],
      maxDepth,
      maxNodes: 1000,
      maxEdges: 5000,
      budgetMs: 100,
    });
  }

  findPathDetailed(fromId: string, toId: string, edgeKinds: EdgeKind[] = []): GraphTraversalResult {
    return this.getAdjacencyIndex().findPaths(fromId, toId, {
      direction: 'forward',
      edgeKinds,
      maxDepth: 50,
      maxNodes: 5000,
      maxEdges: 20000,
      maxPaths: 1,
      budgetMs: 500,
    });
  }

  /**
   * Get the containment hierarchy for a node (ancestors)
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      // Look for 'contains' edges pointing to this node
      const containingEdges = this.queries.getIncomingEdges(currentId, ['contains']);

      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      // Typically there should be at most one containing parent
      const parentNode = this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
    if (containsEdges.length === 0) return [];

    // Batch-fetch (was N+1).
    const childNodes = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}
