import * as crypto from 'crypto';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';
import { ReferenceResolver } from '../src/resolution';
import { formatContextAsJson } from '../src/context/formatter';
import { hyperedgeId, stableJson } from '../src/hypergraph/id';
import { synthesizeSemanticHyperedges } from '../src/hypergraph/synthesizer';
import type { Edge, HyperedgeKind, Node } from '../src/types';

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex');

const makeNode = (id: string, kind: Node['kind'], name: string, filePath = 'src/routes.ts'): Node => ({
  id,
  kind,
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  language: 'typescript',
  startLine: 10,
  endLine: 12,
  startColumn: 2,
  endColumn: 4,
  updatedAt: 1,
});

const makeFile = (filePath: string) => ({
  path: filePath,
  contentHash: `hash:${filePath}`,
  language: 'typescript' as const,
  size: 100,
  modifiedAt: 1,
  indexedAt: 1,
  nodeCount: 1,
});

function createQueries() {
  const dbPath = path.join(process.env.TEST_TMPDIR ?? process.env.TMP ?? '.', `solidkg-hypergraph-${Date.now()}-${Math.random()}.db`);
  const conn = DatabaseConnection.initialize(dbPath);
  const queries = new QueryBuilder(conn.getDb());
  return { conn, queries, db: conn.getDb() };
}

function seedFilesAndNodes(queries: QueryBuilder, nodes: Node[]): void {
  for (const filePath of new Set(nodes.map((node) => node.filePath))) {
    queries.upsertFile(makeFile(filePath));
  }
  queries.insertNodes(nodes);
}

describe('hypergraph synthesis ID helpers', () => {
  it('stableJson sorts object keys', () => {
    const left = stableJson({ b: 1, a: 2, nested: { z: null, a: true } });
    const right = stableJson({ nested: { a: true, z: null }, a: 2, b: 1 });

    expect(left).toBe('{"a":2,"b":1,"nested":{"a":true,"z":null}}');
    expect(left).toBe(right);
  });

  it('stableJson preserves array order', () => {
    expect(stableJson({ members: ['route', 'handler'] })).toBe('{"members":["route","handler"]}');
    expect(stableJson({ members: ['route', 'handler'] })).not.toBe(
      stableJson({ members: ['handler', 'route'] })
    );
  });

  it('hyperedgeId normalizes object key order', () => {
    const kind: HyperedgeKind = 'event_channel';
    const first = hyperedgeId(kind, { event: 'ready', members: { producer: 'a', consumer: 'b' } });
    const second = hyperedgeId(kind, { members: { consumer: 'b', producer: 'a' }, event: 'ready' });

    expect(first).toBe(second);
  });

  it('hyperedgeId preserves array order', () => {
    const kind: HyperedgeKind = 'event_channel';
    const forward = hyperedgeId(kind, { members: ['producer', 'consumer'] });
    const reverse = hyperedgeId(kind, { members: ['consumer', 'producer'] });

    expect(forward).not.toBe(reverse);
  });

  it('hyperedgeId is deterministic and uses stable sha1 payload format', () => {
    const kind: HyperedgeKind = 'event_channel';
    const identity = { event: 'ready', members: ['producer', 'consumer'] };
    const expectedPayload = stableJson({ kind, identity });
    const expectedId = `he:${kind}:${sha1(expectedPayload)}`;

    expect(hyperedgeId(kind, identity)).toBe(expectedId);
    expect(hyperedgeId(kind, identity)).toBe(expectedId);
  });
});

describe('semantic hyperedge synthesis', () => {
  it('synthesizes route_binding from route node', () => {
    const { conn, queries, db } = createQueries();
    try {
      const route = makeNode('node:route:get-users', 'route', 'GET /users');
      const handler = makeNode('node:handler:list-users', 'function', 'listUsers');
      const controller = makeNode('node:controller:users', 'class', 'UsersController', 'src/controllers.ts');
      const view = makeNode('node:view:users', 'component', 'UsersView', 'src/views.ts');
      seedFilesAndNodes(queries, [route, handler, controller, view]);
      queries.insertEdges([
        { source: route.id, target: handler.id, kind: 'references', line: 12, column: 4, provenance: 'tree-sitter' },
        { source: route.id, target: controller.id, kind: 'references', line: 13, column: 4, provenance: 'tree-sitter' },
        { source: route.id, target: view.id, kind: 'references', line: 14, column: 4, provenance: 'tree-sitter' },
      ]);

      expect(synthesizeSemanticHyperedges(queries)).toBe(1);
      expect(synthesizeSemanticHyperedges(queries)).toBe(1);

      const relation = queries.getHyperedgesByNode(route.id)[0];
      expect(relation?.hyperedge.kind).toBe('route_binding');
      expect(relation?.hyperedge.id).toBe(hyperedgeId('route_binding', {
        route: route.id,
        targets: [controller.id, handler.id, view.id],
      }));
      expect(relation?.members.map((member) => ({ nodeId: member.nodeId, role: member.role, ordinal: member.ordinal }))).toEqual([
        { nodeId: route.id, role: 'route', ordinal: 0 },
        { nodeId: controller.id, role: 'controller', ordinal: 1 },
        { nodeId: handler.id, role: 'handler', ordinal: 2 },
        { nodeId: view.id, role: 'view', ordinal: 3 },
      ]);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedge_members').get() as { count: number }).count).toBe(4);
    } finally {
      conn.close();
    }
  });

  it('uses Express relation hints and omits unresolved members', () => {
    const { conn, queries, db } = createQueries();
    try {
      const route = makeNode('node:route:get-x', 'route', 'GET /x');
      const auth = makeNode('node:middleware:auth', 'function', 'auth', 'src/middleware.ts');
      const validateX = makeNode('node:validator:validate-x', 'function', 'validateX', 'src/validators.ts');
      const show = makeNode('node:handler:show', 'method', 'show', 'src/controller.ts');
      seedFilesAndNodes(queries, [route, auth, validateX, show]);
      const resolver = new ReferenceResolver(process.cwd(), queries);
      resolver.initialize();

      const result = resolver.resolveAndPersist([
        hintedRouteRef(route, 'auth', 'hint:express:route-x', 'middleware', 1),
        hintedRouteRef(route, 'validateX', 'hint:express:route-x', 'validator', 2),
        hintedRouteRef(route, 'missingMiddleware', 'hint:express:route-x', 'middleware', 3),
        hintedRouteRef(route, 'show', 'hint:express:route-x', 'handler', 4),
      ]);

      expect(result.stats.resolved).toBe(3);
      expect(result.stats.unresolved).toBe(1);
      expect(result.stats.byMethod['hyperedge-synthesis']).toBe(1);

      const relation = queries.getHyperedgesByNode(route.id)[0];
      expect(relation?.hyperedge.metadata).toMatchObject({
        synthesizedBy: 'framework-relation-hint',
        hintId: 'hint:express:route-x',
        hintKind: 'route_chain',
      });
      expect(relation?.members.map((member) => ({ nodeId: member.nodeId, role: member.role, ordinal: member.ordinal }))).toEqual([
        { nodeId: route.id, role: 'route', ordinal: 0 },
        { nodeId: auth.id, role: 'middleware', ordinal: 1 },
        { nodeId: validateX.id, role: 'validator', ordinal: 2 },
        { nodeId: show.id, role: 'handler', ordinal: 4 },
      ]);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('keeps generic route synthesis fallback without hints', () => {
    const { conn, queries } = createQueries();
    try {
      const route = makeNode('node:route:fallback', 'route', 'GET /fallback');
      const handler = makeNode('node:handler:fallback', 'function', 'fallbackHandler');
      seedFilesAndNodes(queries, [route, handler]);
      queries.insertEdge({ source: route.id, target: handler.id, kind: 'references', line: 10, column: 0, provenance: 'tree-sitter' });

      expect(synthesizeSemanticHyperedges(queries)).toBe(1);
      expect(queries.getHyperedgesByNode(route.id)[0]?.members.map((member) => member.role)).toEqual(['route', 'handler']);
    } finally {
      conn.close();
    }
  });

  it('synthesizes heuristic calls edges by approved synthesizedBy mappings', () => {
    const { conn, queries } = createQueries();
    try {
      const dispatcher = makeNode('node:dispatcher', 'method', 'triggerUpdate');
      const callback = makeNode('node:callback', 'method', 'triggerRender', 'src/view.ts');
      const stateMutator = makeNode('node:set-state', 'method', 'setSceneState');
      const renderMethod = makeNode('node:render', 'method', 'render', 'src/view.ts');
      const baseMethod = makeNode('node:base-method', 'method', 'save', 'src/base.cpp');
      const overrideMethod = makeNode('node:override-method', 'method', 'save', 'src/impl.cpp');
      const component = makeNode('node:component', 'component', 'NativeButton', 'src/Button.tsx');
      const nativeImpl = makeNode('node:native', 'class', 'NativeButtonView', 'ios/Button.mm');
      seedFilesAndNodes(queries, [dispatcher, callback, stateMutator, renderMethod, baseMethod, overrideMethod, component, nativeImpl]);
      queries.insertEdges([
        heuristicEdge(dispatcher.id, callback.id, { synthesizedBy: 'callback', via: 'onUpdate' }),
        heuristicEdge(stateMutator.id, renderMethod.id, { synthesizedBy: 'react-render', via: 'setState' }),
        heuristicEdge(baseMethod.id, overrideMethod.id, { synthesizedBy: 'cpp-override', via: 'save' }),
        heuristicEdge(component.id, nativeImpl.id, { synthesizedBy: 'fabric-native-impl', componentName: 'NativeButton' }),
      ]);

      expect(synthesizeSemanticHyperedges(queries)).toBe(4);

      expect(rolesFor(queries, dispatcher.id)).toEqual(['dispatcher', 'callback']);
      expect(queries.getHyperedgesByNode(dispatcher.id)[0]?.hyperedge.kind).toBe('event_channel');
      expect(rolesFor(queries, stateMutator.id)).toEqual(['state_mutator', 'render_method']);
      expect(queries.getHyperedgesByNode(stateMutator.id)[0]?.hyperedge.kind).toBe('ui_render');
      expect(rolesFor(queries, baseMethod.id)).toEqual(['abstract_target', 'implementation']);
      expect(queries.getHyperedgesByNode(baseMethod.id)[0]?.hyperedge.kind).toBe('dynamic_dispatch');
      expect(rolesFor(queries, component.id)).toEqual(['js_surface', 'native_implementation']);
      expect(queries.getHyperedgesByNode(component.id)[0]?.hyperedge.kind).toBe('native_bridge');

      const relation = queries.getHyperedgesByNode(dispatcher.id)[0]!;
      const contextJson = formatContextAsJson({
        query: 'triggerUpdate triggerRender',
        subgraph: { nodes: new Map([[dispatcher.id, dispatcher], [callback.id, callback]]), edges: [], roots: [dispatcher.id], hyperedges: [relation] },
        entryPoints: [dispatcher],
        codeBlocks: [],
        relatedFiles: [dispatcher.filePath, callback.filePath],
        summary: 'Synthesized semantic relation',
        stats: { nodeCount: 2, edgeCount: 0, fileCount: 2, codeBlockCount: 0, totalCodeSize: 0 },
      });
      const parsed = JSON.parse(contextJson) as { hyperedges: Array<{ provenance?: string; hyperedge: { provenance?: string } }> };
      expect(parsed.hyperedges[0]?.provenance).toBe('semantic_synthesis');
      expect(parsed.hyperedges[0]?.hyperedge.provenance).toBe('semantic_synthesis');
    } finally {
      conn.close();
    }
  });

  it('ignores unknown synthesizedBy values', () => {
    const { conn, queries, db } = createQueries();
    try {
      const source = makeNode('node:source', 'function', 'source');
      const target = makeNode('node:target', 'function', 'target');
      seedFilesAndNodes(queries, [source, target]);
      queries.insertEdge(heuristicEdge(source.id, target.id, { synthesizedBy: 'not-approved' }));

      expect(() => synthesizeSemanticHyperedges(queries)).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(0);
      expect(queries.getHyperedgesByNode(source.id)).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('deletes touching hyperedges for changedFiles before regeneration', () => {
    const { conn, queries, db } = createQueries();
    try {
      const route = makeNode('node:route:home', 'route', 'GET /home', 'src/routes.ts');
      const handler = makeNode('node:handler:home', 'function', 'home', 'src/handlers.ts');
      seedFilesAndNodes(queries, [route, handler]);
      queries.insertEdge({ source: route.id, target: handler.id, kind: 'references', line: 5, provenance: 'tree-sitter' });

      synthesizeSemanticHyperedges(queries);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(1);

      db.prepare('DELETE FROM edges WHERE source = ? AND target = ?').run(route.id, handler.id);
      synthesizeSemanticHyperedges(queries, { changedFiles: ['src/handlers.ts'] });

      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedge_members').get() as { count: number }).count).toBe(0);
    } finally {
      conn.close();
    }
  });
});

describe('resolver semantic hyperedge synthesis', () => {
  it('resolveAndPersist runs semantic synthesis', () => {
    const { conn, queries, db } = createQueries();
    try {
      const route = makeNode('node:route:api-users', 'route', 'GET /api/users', 'src/routes.ts');
      const handler = makeNode('node:handler:listUsers', 'function', 'listUsers', 'src/handlers.ts');
      seedFilesAndNodes(queries, [route, handler]);

      const resolver = new ReferenceResolver(process.cwd(), queries);
      resolver.initialize();
      const result = resolver.resolveAndPersist([
        {
          fromNodeId: route.id,
          referenceName: handler.name,
          referenceKind: 'references',
          line: 12,
          column: 4,
          filePath: route.filePath,
          language: 'typescript',
        },
      ]);

      expect(result.stats.resolved).toBe(1);
      expect(result.stats.byMethod['hyperedge-synthesis']).toBe(1);
      expect(queries.getOutgoingEdges(route.id, ['references'])).toHaveLength(1);
      expect(queries.getHyperedgesByNode(route.id)[0]?.hyperedge.kind).toBe('route_binding');
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('post-resolution synthesis failure does not abort indexing', () => {
    const { conn, queries, db } = createQueries();
    const originalInsertHyperedgeRelations = queries.insertHyperedgeRelations.bind(queries);
    try {
      const route = makeNode('node:route:failing', 'route', 'GET /failing', 'src/routes.ts');
      const handler = makeNode('node:handler:failing', 'function', 'failingHandler', 'src/handlers.ts');
      seedFilesAndNodes(queries, [route, handler]);
      queries.insertHyperedgeRelations = () => {
        throw new Error('forced semantic synthesis failure');
      };

      const resolver = new ReferenceResolver(process.cwd(), queries);
      resolver.initialize();
      const result = resolver.resolveAndPersist([
        {
          fromNodeId: route.id,
          referenceName: handler.name,
          referenceKind: 'references',
          line: 12,
          column: 4,
          filePath: route.filePath,
          language: 'typescript',
        },
      ]);

      expect(result.stats.resolved).toBe(1);
      expect(result.stats.byMethod['hyperedge-synthesis']).toBe(0);
      expect(queries.getOutgoingEdges(route.id, ['references'])).toHaveLength(1);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(0);
    } finally {
      queries.insertHyperedgeRelations = originalInsertHyperedgeRelations;
      conn.close();
    }
  });
});
function heuristicEdge(source: string, target: string, metadata: Record<string, unknown>): Edge {
  return { source, target, kind: 'calls', provenance: 'heuristic', line: 20, column: 2, metadata };
}

function hintedRouteRef(route: Node, referenceName: string, hintId: string, role: string, ordinal: number) {
  return {
    fromNodeId: route.id,
    referenceName,
    referenceKind: 'references' as const,
    line: route.startLine,
    column: route.startColumn,
    filePath: route.filePath,
    language: route.language,
    relationHint: {
      id: hintId,
      kind: 'route_chain' as const,
      relationKind: 'route_binding' as const,
      role: role as 'route' | 'middleware' | 'validator' | 'handler',
      ordinal,
    },
  };
}

function rolesFor(queries: QueryBuilder, nodeId: string): string[] {
  return queries.getHyperedgesByNode(nodeId)[0]?.members.map((member) => member.role) ?? [];
}

describe('synthesized mechanism evidence-label parity', () => {
  it('positive: callback heuristic edges retain a callback evidence label', () => {
    const handler = new ToolHandler({} as any);
    try {
      const note = (handler as any).synthEdgeNote({
        source: 'a',
        target: 'b',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'callback', via: 'onUpdate', registeredAt: 'src/view.ts:20' },
      });
      expect(note?.label).toContain('callback');
      expect(note?.compact).toContain('dynamic: callback via');
      expect(note?.compact).toContain('@src/view.ts:20');
    } finally {
      handler.closeAll();
    }
  });

  it('positive: react-render heuristic edges retain a React re-render evidence label', () => {
    const handler = new ToolHandler({} as any);
    try {
      const note = (handler as any).synthEdgeNote({
        source: 'a',
        target: 'b',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: 'src/view.ts:42' },
      });
      expect(note?.label).toContain('React re-render');
      expect(note?.compact).toContain('dynamic: React re-render via setState');
      expect(note?.compact).toContain('@src/view.ts:42');
    } finally {
      handler.closeAll();
    }
  });

  it('positive: every synthesized mechanism used in dynamic call edges has rendered evidence labels', () => {
    const handler = new ToolHandler({} as any);
    try {
      const cases = [
        [{ synthesizedBy: 'rn-event-channel', event: 'locationUpdate' }, 'rn-event-channel', 'locationUpdate'],
        [{ synthesizedBy: 'fabric-native-impl', componentName: 'MyView' }, 'fabric-native-impl', 'MyView'],
        [{ synthesizedBy: 'flutter-build', via: 'setState' }, 'flutter-build', 'setState'],
        [{ synthesizedBy: 'cpp-override', via: 'Base::run' }, 'cpp-override', 'Base::run'],
      ] as const;

      for (const [metadata, mechanism, evidence] of cases) {
        const note = (handler as any).synthEdgeNote({
          source: 'a',
          target: 'b',
          kind: 'calls',
          provenance: 'heuristic',
          metadata,
        });
        expect(note?.label).toContain(mechanism);
        expect(note?.compact).toContain(mechanism);
        expect(note?.label).toContain(evidence);
      }
    } finally {
      handler.closeAll();
    }
  });

  it('static baseline: non-heuristic calls edges never get synthesized evidence labels', () => {
    const handler = new ToolHandler({} as any);
    try {
      const note = (handler as any).synthEdgeNote({
        source: 'a',
        target: 'b',
        kind: 'calls',
        provenance: 'tree-sitter',
        metadata: { synthesizedBy: 'callback', via: 'onUpdate' },
      });
      expect(note).toBeNull();
    } finally {
      handler.closeAll();
    }
  });
});
