import type { QueryBuilder } from '../db/queries';
import type {
  Edge,
  FrameworkRelationHintRef,
  HyperedgeKind,
  HyperedgeMember,
  HyperedgeRelation,
  Node,
} from '../types';
import { hyperedgeId, type StableJsonValue } from './id';

export interface SemanticHyperedgeSynthesisOptions {
  changedFiles?: readonly string[];
}

type HeuristicMapping = {
  kind: HyperedgeKind;
  sourceRole: string;
  targetRole: string;
};

const HEURISTIC_MAPPINGS: Record<string, HeuristicMapping> = {
  callback: { kind: 'event_channel', sourceRole: 'dispatcher', targetRole: 'callback' },
  'event-emitter': { kind: 'event_channel', sourceRole: 'emitter', targetRole: 'listener' },
  'rn-event-channel': { kind: 'event_channel', sourceRole: 'emitter', targetRole: 'listener' },
  'react-render': { kind: 'ui_render', sourceRole: 'state_mutator', targetRole: 'render_method' },
  'flutter-build': { kind: 'ui_render', sourceRole: 'state_mutator', targetRole: 'render_method' },
  'jsx-render': { kind: 'ui_render', sourceRole: 'render_parent', targetRole: 'render_child' },
  'vue-handler': { kind: 'ui_render', sourceRole: 'template_event', targetRole: 'event_handler' },
  'cpp-override': { kind: 'dynamic_dispatch', sourceRole: 'abstract_target', targetRole: 'implementation' },
  'interface-impl': { kind: 'dynamic_dispatch', sourceRole: 'interface_method', targetRole: 'implementation' },
  'fabric-native-impl': { kind: 'native_bridge', sourceRole: 'js_surface', targetRole: 'native_implementation' },
};

const ROUTE_TARGET_EDGE_KINDS: Edge['kind'][] = ['references'];

export function synthesizeSemanticHyperedges(
  queries: QueryBuilder,
  options: SemanticHyperedgeSynthesisOptions = {}
): number {
  for (const filePath of options.changedFiles ?? []) {
    queries.deleteHyperedgesForFile(filePath);
  }

  const relations = [
    ...routeBindingRelations(queries),
    ...heuristicEdgeRelations(queries),
    ...scipImplementationRelations(queries),
  ];

  queries.insertHyperedgeRelations(relations);
  return relations.length;
}

function scipImplementationRelations(queries: QueryBuilder): HyperedgeRelation[] {
  const relations: HyperedgeRelation[] = [];
  for (const relationship of queries.getScipImplementationRelationships()) {
    const implementation = queries.getNodeByScipSymbol(relationship.sourceSymbol);
    const contract = queries.getNodeByScipSymbol(relationship.targetSymbol);
    if (!implementation || !contract) continue;

    const id = hyperedgeId('dynamic_dispatch', {
      scipRelationship: relationship.id,
      source: implementation.id,
      target: contract.id,
    });
    const now = Date.now();
    relations.push({
      hyperedge: {
        id,
        kind: 'dynamic_dispatch',
        sourceFile: implementation.filePath,
        line: implementation.startLine,
        column: implementation.startColumn,
        provenance: 'scip',
        confidence: 1,
        metadata: { scipRelationship: relationship.id },
        createdAt: now,
        updatedAt: now,
      },
      members: [
        member(id, contract, 'contract', 0),
        member(id, implementation, 'implementation', 1),
      ],
    });
  }
  return relations;
}

function routeBindingRelations(queries: QueryBuilder): HyperedgeRelation[] {
  const relations: HyperedgeRelation[] = [];
  const hintedRelations = hintedRouteBindingRelations(queries);
  const hintedRouteIds = new Set(
    hintedRelations
      .map((relation) => relation.members.find((entry) => entry.role === 'route')?.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId))
  );
  relations.push(...hintedRelations);

  for (const route of queries.getNodesByKind('route')) {
    if (hintedRouteIds.has(route.id)) continue;
    const targets = uniqueNodes(
      queries
        .getOutgoingEdges(route.id, ROUTE_TARGET_EDGE_KINDS)
        .map((edge) => queries.getNodeById(edge.target))
        .filter((node): node is Node => Boolean(node))
    ).sort(compareRouteTargets);

    if (targets.length === 0) continue;

    const id = hyperedgeId('route_binding', {
      route: route.id,
      targets: targets.map((target) => target.id),
    });
    const now = Date.now();
    relations.push({
      hyperedge: {
        id,
        kind: 'route_binding',
        sourceFile: route.filePath,
        line: route.startLine,
        column: route.startColumn,
        provenance: 'heuristic',
        confidence: 1,
        metadata: { synthesizedBy: 'route-binding' },
        createdAt: now,
        updatedAt: now,
      },
      members: [
        member(id, route, 'route', 0),
        ...targets.map((target, index) => member(id, target, routeTargetRole(target), index + 1)),
      ],
    });
  }

  return relations;
}

function hintedRouteBindingRelations(queries: QueryBuilder): HyperedgeRelation[] {
  const relations: HyperedgeRelation[] = [];

  for (const route of queries.getNodesByKind('route')) {
    const byHint = new Map<string, Array<{ edge: Edge; hint: FrameworkRelationHintRef; target: Node }>>();
    for (const edge of queries.getOutgoingEdges(route.id, ROUTE_TARGET_EDGE_KINDS)) {
      const hint = edgeRelationHint(edge);
      if (!hint || hint.relationKind !== 'route_binding' || hint.kind !== 'route_chain') continue;
      const target = queries.getNodeById(edge.target);
      if (!target) continue;
      const entries = byHint.get(hint.id) ?? [];
      entries.push({ edge, hint, target });
      byHint.set(hint.id, entries);
    }

    for (const [hintId, entries] of byHint) {
      const ordered = entries.sort((left, right) => left.hint.ordinal - right.hint.ordinal || left.target.id.localeCompare(right.target.id));
      const targetMembers = uniqueHintMembers(ordered.map((entry) => ({
        role: entry.hint.role,
        ordinal: entry.hint.ordinal,
        node: entry.target,
      })));
      if (targetMembers.length === 0) continue;

      const id = hyperedgeId('route_binding', {
        hint: hintId,
        route: route.id,
        members: targetMembers.map((entry) => ({ role: entry.role, node: entry.node.id, ordinal: entry.ordinal })),
      });
      const now = Date.now();
      relations.push({
        hyperedge: {
          id,
          kind: 'route_binding',
          sourceFile: route.filePath,
          line: route.startLine,
          column: route.startColumn,
          provenance: 'heuristic',
          confidence: 1,
          metadata: { synthesizedBy: 'framework-relation-hint', hintId, hintKind: 'route_chain' },
          createdAt: now,
          updatedAt: now,
        },
        members: [
          member(id, route, 'route', 0),
          ...targetMembers.map((entry) => member(id, entry.node, entry.role, entry.ordinal)),
        ],
      });
    }
  }

  return relations;
}

function edgeRelationHint(edge: Edge): FrameworkRelationHintRef | null {
  const hint = edge.metadata?.relationHint;
  if (!hint || typeof hint !== 'object') return null;
  const candidate = hint as Partial<FrameworkRelationHintRef>;
  if (
    typeof candidate.id === 'string' &&
    candidate.kind === 'route_chain' &&
    candidate.relationKind === 'route_binding' &&
    typeof candidate.role === 'string' &&
    typeof candidate.ordinal === 'number'
  ) {
    return candidate as FrameworkRelationHintRef;
  }
  return null;
}

function uniqueHintMembers(entries: Array<{ role: string; ordinal: number; node: Node }>): Array<{ role: string; ordinal: number; node: Node }> {
  const seen = new Set<string>();
  const unique: Array<{ role: string; ordinal: number; node: Node }> = [];
  for (const entry of entries) {
    const key = `${entry.role}:${entry.node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function heuristicEdgeRelations(queries: QueryBuilder): HyperedgeRelation[] {
  const relations: HyperedgeRelation[] = [];

  for (const edge of queries.getEdgesByProvenance('heuristic')) {
    if (edge.kind !== 'calls') continue;

    const synthesizedBy = typeof edge.metadata?.synthesizedBy === 'string'
      ? edge.metadata.synthesizedBy
      : null;
    if (!synthesizedBy) continue;

    const mapping = HEURISTIC_MAPPINGS[synthesizedBy];
    if (!mapping) continue;

    const source = queries.getNodeById(edge.source);
    const target = queries.getNodeById(edge.target);
    if (!source || !target) continue;

    const id = hyperedgeId(mapping.kind, heuristicIdentity(edge, synthesizedBy));
    const now = Date.now();
    relations.push({
      hyperedge: {
        id,
        kind: mapping.kind,
        sourceFile: source.filePath,
        line: edge.line ?? source.startLine,
        column: edge.column ?? source.startColumn,
        provenance: 'heuristic',
        confidence: 0.8,
        metadata: { synthesizedBy, edgeKind: edge.kind, ...(edge.metadata ?? {}) },
        createdAt: now,
        updatedAt: now,
      },
      members: [
        member(id, source, mapping.sourceRole, 0),
        member(id, target, mapping.targetRole, 1),
      ],
    });
  }

  return relations;
}

function heuristicIdentity(edge: Edge, synthesizedBy: string): StableJsonValue {
  return {
    synthesizedBy,
    source: edge.source,
    target: edge.target,
    edgeKind: edge.kind,
    line: edge.line ?? null,
    column: edge.column ?? null,
    metadata: toStableJsonValue(edge.metadata ?? {}),
  };
}

function toStableJsonValue(value: unknown): StableJsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(toStableJsonValue);

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object': {
      const out: { [key: string]: StableJsonValue } = {};
      for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
        out[key] = toStableJsonValue(entryValue);
      }
      return out;
    }
    default:
      return String(value);
  }
}

function member(hyperedgeIdValue: string, node: Node, role: string, ordinal: number): HyperedgeMember & { node: Node } {
  return {
    hyperedgeId: hyperedgeIdValue,
    nodeId: node.id,
    role,
    ordinal,
    node,
  };
}

function uniqueNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const unique: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }
  return unique;
}

function compareRouteTargets(left: Node, right: Node): number {
  const roleOrder = roleRank(routeTargetRole(left)) - roleRank(routeTargetRole(right));
  if (roleOrder !== 0) return roleOrder;
  return left.id.localeCompare(right.id);
}

function roleRank(role: string): number {
  switch (role) {
    case 'controller': return 0;
    case 'handler': return 1;
    case 'view': return 2;
    default: return 3;
  }
}

function routeTargetRole(node: Node): string {
  switch (node.kind) {
    case 'function':
    case 'method':
      return 'handler';
    case 'class':
      return 'controller';
    case 'component':
      return 'view';
    default:
      return 'target';
  }
}
