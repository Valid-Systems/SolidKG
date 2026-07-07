import type { EdgeKind } from '../types';
import type { BoundedTraversalOptions, GraphTraversalDirection, GraphTraversalResult, RelationAwareAdjacencyIndex } from './adjacency';

export const GRAPH_PATTERN_NAMES = [
  'direct_callers',
  'direct_callees',
  'transitive_callers',
  'transitive_callees',
  'import_dependents',
  'dependency_closure',
  'symbol_references',
  'implementation_paths',
  'test_impact',
  'config_impact',
  'neighborhood_summary',
] as const;

export type GraphPatternName = (typeof GRAPH_PATTERN_NAMES)[number];

interface PatternSpec {
  readonly direction: GraphTraversalDirection;
  readonly edgeKinds: readonly EdgeKind[];
  readonly maxDepth: number;
}

const PATTERNS: Record<GraphPatternName, PatternSpec> = {
  direct_callers: { direction: 'reverse', edgeKinds: ['calls'], maxDepth: 1 },
  direct_callees: { direction: 'forward', edgeKinds: ['calls'], maxDepth: 1 },
  transitive_callers: { direction: 'reverse', edgeKinds: ['calls', 'references', 'imports'], maxDepth: 5 },
  transitive_callees: { direction: 'forward', edgeKinds: ['calls', 'references', 'imports'], maxDepth: 5 },
  import_dependents: { direction: 'reverse', edgeKinds: ['imports'], maxDepth: 3 },
  dependency_closure: { direction: 'forward', edgeKinds: ['imports', 'references', 'calls'], maxDepth: 5 },
  symbol_references: { direction: 'reverse', edgeKinds: ['references', 'calls', 'type_of', 'returns'], maxDepth: 2 },
  implementation_paths: { direction: 'both', edgeKinds: ['implements', 'extends', 'overrides', 'calls'], maxDepth: 4 },
  test_impact: { direction: 'reverse', edgeKinds: ['imports', 'references', 'calls'], maxDepth: 4 },
  config_impact: { direction: 'reverse', edgeKinds: ['imports', 'references'], maxDepth: 3 },
  neighborhood_summary: { direction: 'both', edgeKinds: ['calls', 'references', 'imports', 'contains'], maxDepth: 1 },
};

export function isGraphPatternName(value: string): value is GraphPatternName {
  return GRAPH_PATTERN_NAMES.includes(value as GraphPatternName);
}

export function runGraphPattern(
  index: RelationAwareAdjacencyIndex,
  pattern: string,
  startNodeIds: readonly string[],
  options: Partial<Pick<BoundedTraversalOptions, 'maxNodes' | 'maxEdges' | 'budgetMs'>> = {},
): GraphTraversalResult {
  if (!isGraphPatternName(pattern)) {
    throw new Error(`Unsupported graph pattern: ${pattern}`);
  }
  const spec = PATTERNS[pattern];
  return index.boundedBfs(startNodeIds, {
    direction: spec.direction,
    edgeKinds: spec.edgeKinds,
    maxDepth: spec.maxDepth,
    maxNodes: options.maxNodes ?? 1000,
    maxEdges: options.maxEdges ?? 5000,
    budgetMs: options.budgetMs ?? 100,
  });
}
