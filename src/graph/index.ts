/**
 * Graph Module
 *
 * Provides graph traversal and query functionality for the code knowledge graph.
 */

export { GraphTraverser } from './traversal';
export { GraphQueryManager } from './queries';
export { RelationAwareAdjacencyIndex } from './adjacency';
export { absentTraversal, explainPath } from './traversal-primitives';
export type {
  BoundedTraversalOptions,
  GraphCoverageStatus,
  GraphPath,
  GraphRevision,
  GraphTraversalCoverage,
  GraphTraversalDirection,
  GraphTraversalLimit,
  GraphTraversalResult,
  NeighborOptions,
  PathTraversalOptions,
} from './adjacency';
export { buildGraphTraversalPacket, formatGraphTraversalPacketMarkdown } from './answerPacket';
export type { BuildGraphTraversalPacketArgs, GraphTraversalPacket } from './answerPacket';
export { GRAPH_PATTERN_NAMES, isGraphPatternName, runGraphPattern } from './patterns';
export type { GraphPatternName } from './patterns';
