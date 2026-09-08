import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db';
import type { Edge, Hyperedge, HyperedgeMember, HyperedgeRelation, Node, TraversalOptions } from '../src/types';
import { HYPEREDGE_KINDS } from '../src/types';

const makeNode = (id: string, name: string, filePath = 'src/routes.ts'): Node => ({
  id,
  kind: 'function',
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  language: 'typescript',
  startLine: 1,
  endLine: 3,
  startColumn: 0,
  endColumn: 1,
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

const makeHyperedge = (id: string, kind: Hyperedge['kind'] = 'route_binding'): Hyperedge => ({
  id,
  kind,
  sourceFile: 'src/routes.ts',
  line: 12,
  column: 4,
  provenance: 'heuristic',
  confidence: 0.9,
  metadata: { path: '/', synthesizedBy: 'test' },
  createdAt: 10,
  updatedAt: 20,
});

const makeMember = (
  hyperedgeId: string,
  nodeId: string,
  role: string,
  ordinal: number,
  metadata?: Record<string, unknown>
): HyperedgeMember => ({
  hyperedgeId,
  nodeId,
  role,
  ordinal,
  metadata,
});

function createQueries(): { conn: DatabaseConnection; queries: QueryBuilder; db: SqliteDatabase } {
  const dbPath = path.join(createTempDir(), 'solidkg.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const db = conn.getDb();
  return { conn, queries: new QueryBuilder(db), db };
}

function seedHyperedgeNodes(queries: QueryBuilder): { route: Node; handler: Node; view: Node; other: Node } {
  queries.upsertFile(makeFile('src/routes.ts'));
  queries.upsertFile(makeFile('src/views.ts'));
  queries.upsertFile(makeFile('src/other.ts'));

  const route = makeNode('node:route', 'homeRoute', 'src/routes.ts');
  const handler = makeNode('node:handler', 'handleHome', 'src/routes.ts');
  const view = makeNode('node:view', 'renderHome', 'src/views.ts');
  const other = makeNode('node:other', 'unrelated', 'src/other.ts');
  queries.insertNodes([route, handler, view, other]);
  return { route, handler, view, other };
}

function expectRouteBindingRelation(relation: HyperedgeRelation | null): asserts relation is HyperedgeRelation {
  expect(relation).not.toBeNull();
  expect(relation.hyperedge).toMatchObject({
    id: 'hyperedge:route-binding:home',
    kind: 'route_binding',
    sourceFile: 'src/routes.ts',
    line: 12,
    column: 4,
    provenance: 'heuristic',
    confidence: 0.9,
    metadata: { path: '/', synthesizedBy: 'test' },
    createdAt: 10,
    updatedAt: 20,
  });
  expect(relation.members.map((member) => ({
    nodeId: member.nodeId,
    role: member.role,
    ordinal: member.ordinal,
    nodeName: member.node.name,
    filePath: member.node.filePath,
    metadata: member.metadata,
  }))).toEqual([
    {
      nodeId: 'node:route',
      role: 'route',
      ordinal: 0,
      nodeName: 'homeRoute',
      filePath: 'src/routes.ts',
      metadata: { method: 'GET' },
    },
    {
      nodeId: 'node:handler',
      role: 'handler',
      ordinal: 1,
      nodeName: 'handleHome',
      filePath: 'src/routes.ts',
      metadata: undefined,
    },
    {
      nodeId: 'node:view',
      role: 'view',
      ordinal: 2,
      nodeName: 'renderHome',
      filePath: 'src/views.ts',
      metadata: { template: 'home' },
    },
  ]);
}

const expectedHyperedgeColumns = {
  hyperedges: [
    ['id', 'TEXT', true, undefined, true],
    ['kind', 'TEXT', true, undefined, false],
    ['source_file', 'TEXT', false, undefined, false],
    ['line', 'INTEGER', false, undefined, false],
    ['col', 'INTEGER', false, undefined, false],
    ['provenance', 'TEXT', false, undefined, false],
    ['confidence', 'REAL', false, undefined, false],
    ['metadata', 'TEXT', false, undefined, false],
    ['created_at', 'INTEGER', true, undefined, false],
    ['updated_at', 'INTEGER', true, undefined, false],
  ],
  hyperedge_members: [
    ['hyperedge_id', 'TEXT', true, undefined, true],
    ['node_id', 'TEXT', true, undefined, true],
    ['role', 'TEXT', true, undefined, true],
    ['ordinal', 'INTEGER', true, '0', true],
    ['metadata', 'TEXT', false, undefined, false],
  ],
} as const;

const expectedHyperedgeIndexes = {
  hyperedges: ['idx_hyperedges_kind', 'idx_hyperedges_provenance', 'idx_hyperedges_source_file'],
  hyperedge_members: [
    'idx_hyperedge_members_hyperedge_ordinal',
    'idx_hyperedge_members_node',
    'idx_hyperedge_members_node_role',
    'idx_hyperedge_members_role',
  ],
} as const;

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hypergraph-storage-'));
  tempDirs.push(dir);
  return dir;
}

function getColumns(db: SqliteDatabase, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
}

function getIndexNames(db: SqliteDatabase, tableName: string): string[] {
  return (db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_autoindex_'))
    .sort();
}

function insertNodeRows(db: SqliteDatabase): void {
  db.prepare(`
    INSERT INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at
    ) VALUES (?, 'function', ?, ?, 'src/routes.ts', 'typescript', 1, 3, 0, 1, 1)
  `).run('node:source', 'source', 'src/routes.ts::source');
  db.prepare(`
    INSERT INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at
    ) VALUES (?, 'function', ?, ?, 'src/routes.ts', 'typescript', 5, 7, 0, 1, 1)
  `).run('node:target', 'target', 'src/routes.ts::target');
}

function getPairwiseEdgeCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number };
  return row.count;
}

function expectEdgeDedupeIndex(db: SqliteDatabase): void {
  expect(getIndexNames(db, 'edges')).toContain('idx_edges_dedupe');
}

function expectHyperedgeSchema(db: SqliteDatabase): void {
  for (const [tableName, expectedColumns] of Object.entries(expectedHyperedgeColumns)) {
    const columns = getColumns(db, tableName);
    expect(columns.map((column) => column.name)).toEqual(
      expectedColumns.map(([name]) => name)
    );

    for (const [index, [name, type, notNull, defaultValue, primaryKey]] of expectedColumns.entries()) {
      expect(columns[index]).toMatchObject({
        name,
        type,
        notnull: notNull ? 1 : 0,
        dflt_value: defaultValue ?? null,
      });
      expect(columns[index].pk > 0).toBe(primaryKey);
    }
  }

  for (const [tableName, expectedIndexes] of Object.entries(expectedHyperedgeIndexes)) {
    expect(getIndexNames(db, tableName)).toEqual([...expectedIndexes].sort());
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hypergraph storage schema', () => {
  it('fresh DB has hyperedge schema', () => {
    const dbPath = path.join(createTempDir(), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);

    try {
      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(11);
      expectHyperedgeSchema(conn.getDb());
      expectEdgeDedupeIndex(conn.getDb());
    } finally {
      conn.close();
    }
  });

  it('migrates v4 DB to hyperedge schema', () => {
    const dbPath = path.join(createTempDir(), 'solidkg.db');
    const seeded = DatabaseConnection.initialize(dbPath);

    try {
      const db = seeded.getDb();
      db.exec(`
        DROP TABLE IF EXISTS hyperedge_members;
        DROP TABLE IF EXISTS hyperedges;
        DELETE FROM schema_versions WHERE version > 4;
        INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
        VALUES (4, strftime('%s', 'now') * 1000, 'v4-style fixture');
      `);
    } finally {
      seeded.close();
    }

    const migrated = DatabaseConnection.open(dbPath);
    try {
      expect(migrated.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expectHyperedgeSchema(migrated.getDb());
      expectEdgeDedupeIndex(migrated.getDb());
    } finally {
      migrated.close();
    }
  });

  it('deduplicates existing pairwise edges during v5 migration', () => {
    const dbPath = path.join(createTempDir(), 'solidkg.db');
    const seeded = DatabaseConnection.initialize(dbPath);

    try {
      const db = seeded.getDb();
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_dedupe;
        DROP TABLE IF EXISTS hyperedge_members;
        DROP TABLE IF EXISTS hyperedges;
        DELETE FROM schema_versions WHERE version > 4;
        INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
        VALUES (4, strftime('%s', 'now') * 1000, 'v4-style fixture');
      `);
      insertNodeRows(db);
      const insertDuplicate = db.prepare(`
        INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES ('node:source', 'node:target', 'calls', '{"via":"route"}', 12, 4, 'heuristic')
      `);
      insertDuplicate.run();
      insertDuplicate.run();
      db.prepare(`
        INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES ('node:source', 'node:target', 'calls', '{"via":"route","step":2}', 12, 4, 'heuristic')
      `).run();
      expect(getPairwiseEdgeCount(db)).toBe(3);
    } finally {
      seeded.close();
    }

    const migrated = DatabaseConnection.open(dbPath);
    try {
      const db = migrated.getDb();
      expect(migrated.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expectEdgeDedupeIndex(db);
      expect(getPairwiseEdgeCount(db)).toBe(2);
    } finally {
      migrated.close();
    }
  });

  it('prevents future duplicate pairwise edges', () => {
    const dbPath = path.join(createTempDir(), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);

    try {
      const db = conn.getDb();
      insertNodeRows(db);
      const queries = new QueryBuilder(db);
      const edge = {
        source: 'node:source',
        target: 'node:target',
        kind: 'calls' as const,
        metadata: { via: 'route' },
        line: 12,
        column: 4,
        provenance: 'heuristic' as const,
      };

      queries.insertEdge(edge);
      queries.insertEdge(edge);

      expectEdgeDedupeIndex(db);
      expect(getPairwiseEdgeCount(db)).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe('hypergraph storage type contracts', () => {
  it('accepts opt-in hyperedge traversal options without requiring them', () => {
    const pairwiseOnlyTraversal: TraversalOptions = { maxDepth: 2 };
    const hyperedgeTraversal: TraversalOptions = {
      includeHyperedges: true,
      hyperedgeKinds: ['route_binding'],
      hyperedgeExpansion: 'members',
      maxHyperedges: 10,
    };

    expect(pairwiseOnlyTraversal.maxDepth).toBe(2);
    expect(hyperedgeTraversal.hyperedgeKinds).toEqual(['route_binding']);
  });

  it('constructs a semantic hyperedge relation with ordered node members', () => {
    const handler = makeNode('node:handler', 'handleRequest');
    const view = makeNode('node:view', 'renderView');

    const relation: HyperedgeRelation = {
      hyperedge: {
        id: 'hyperedge:route-binding:home',
        kind: 'route_binding',
        sourceFile: 'src/routes.ts',
        line: 12,
        column: 4,
        provenance: 'heuristic',
        confidence: 1,
        metadata: { path: '/' },
        createdAt: 1,
        updatedAt: 1,
      },
      members: [
        {
          hyperedgeId: 'hyperedge:route-binding:home',
          nodeId: handler.id,
          role: 'handler',
          ordinal: 0,
          node: handler,
        },
        {
          hyperedgeId: 'hyperedge:route-binding:home',
          nodeId: view.id,
          role: 'view',
          ordinal: 1,
          node: view,
        },
      ],
    };

    expect(HYPEREDGE_KINDS).toContain(relation.hyperedge.kind);
    expect(relation.members.map((member) => member.node.name)).toEqual([
      'handleRequest',
      'renderView',
    ]);
    expect(relation.members.map((member) => member.ordinal)).toEqual([0, 1]);
  });
});

describe('hypergraph QueryBuilder storage', () => {
  it('persists ordered hyperedge members', () => {
    const { conn, queries } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const hyperedge = makeHyperedge('hyperedge:route-binding:home');
      const members = [
        makeMember(hyperedge.id, 'node:view', 'view', 2, { template: 'home' }),
        makeMember(hyperedge.id, 'node:route', 'route', 0, { method: 'GET' }),
        makeMember(hyperedge.id, 'node:handler', 'handler', 1),
      ];

      queries.insertHyperedge(hyperedge, members);

      expectRouteBindingRelation(queries.getHyperedgeById(hyperedge.id));
    } finally {
      conn.close();
    }
  });

  it('inserts multiple hyperedge relations transactionally', () => {
    const { conn, queries, db } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      const render = {
        ...makeHyperedge('hyperedge:ui-render:home', 'ui_render'),
        sourceFile: 'src/views.ts',
        metadata: { surface: 'home' },
      };

      queries.insertHyperedgeRelations([
        {
          hyperedge: routeBinding,
          members: [
            { ...makeMember(routeBinding.id, 'node:route', 'route', 0), node: makeNode('node:route', 'homeRoute') },
            { ...makeMember(routeBinding.id, 'node:handler', 'handler', 1), node: makeNode('node:handler', 'handleHome') },
          ],
        },
        {
          hyperedge: render,
          members: [
            { ...makeMember(render.id, 'node:handler', 'state', 0), node: makeNode('node:handler', 'handleHome') },
            { ...makeMember(render.id, 'node:view', 'component', 1), node: makeNode('node:view', 'renderHome', 'src/views.ts') },
          ],
        },
      ]);

      expect(queries.getHyperedgeById(routeBinding.id)?.members.map((member) => member.nodeId)).toEqual([
        'node:route',
        'node:handler',
      ]);
      expect(queries.getHyperedgeById(render.id)?.members.map((member) => member.nodeId)).toEqual([
        'node:handler',
        'node:view',
      ]);
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedges').get() as { count: number }).count).toBe(2);
    } finally {
      conn.close();
    }
  });

  it('looks up full relations by member node and selected node set', () => {
    const { conn, queries } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      const dispatch = makeHyperedge('hyperedge:dynamic-dispatch:home', 'dynamic_dispatch');
      queries.insertHyperedge(routeBinding, [
        makeMember(routeBinding.id, 'node:route', 'route', 0),
        makeMember(routeBinding.id, 'node:handler', 'handler', 1),
        makeMember(routeBinding.id, 'node:view', 'view', 2),
      ]);
      queries.insertHyperedge(dispatch, [
        makeMember(dispatch.id, 'node:handler', 'publisher', 0),
        makeMember(dispatch.id, 'node:view', 'subscriber', 1),
        makeMember(dispatch.id, 'node:other', 'subscriber', 2),
      ]);

      expect(queries.getHyperedgesByNode('node:handler').map((relation) => relation.hyperedge.id).sort()).toEqual([
        'hyperedge:dynamic-dispatch:home',
        'hyperedge:route-binding:home',
      ]);
      expect(queries.getHyperedgesByNodes(['node:handler', 'node:view']).map((relation) => relation.hyperedge.id).sort()).toEqual([
        'hyperedge:dynamic-dispatch:home',
        'hyperedge:route-binding:home',
      ]);
      expect(queries.getHyperedgesByNodes(['node:route', 'node:other'])).toEqual([]);
      expect(queries.findHyperedgesBetweenNodes(['node:handler', 'node:view'], ['dynamic_dispatch']).map((relation) => relation.hyperedge.id)).toEqual([
        'hyperedge:dynamic-dispatch:home',
      ]);
      expect(queries.findHyperedgesBetweenNodes(['node:handler', 'node:view'], ['native_bridge'])).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('deleteHyperedgesForFile removes cross-file relations', () => {
    const { conn, queries, db } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      const other = { ...makeHyperedge('hyperedge:event-channel:other', 'event_channel'), sourceFile: 'src/other.ts' };
      queries.insertHyperedge(routeBinding, [
        makeMember(routeBinding.id, 'node:route', 'route', 0),
        makeMember(routeBinding.id, 'node:view', 'view', 1),
      ]);
      queries.insertHyperedge(other, [
        makeMember(other.id, 'node:other', 'publisher', 0),
        makeMember(other.id, 'node:view', 'subscriber', 1),
      ]);

      queries.deleteHyperedgesForFile('src/routes.ts');

      expect(queries.getHyperedgeById(routeBinding.id)).toBeNull();
      expect(queries.getHyperedgeById(other.id)).not.toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedge_members WHERE hyperedge_id = ?').get(routeBinding.id) as { count: number }).count).toBe(0);
    } finally {
      conn.close();
    }
  });

  it('deleteFile removes hyperedges touching that file before deleting nodes', () => {
    const { conn, queries, db } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      queries.insertHyperedge(routeBinding, [
        makeMember(routeBinding.id, 'node:handler', 'handler', 0),
        makeMember(routeBinding.id, 'node:view', 'view', 1),
      ]);

      queries.deleteFile('src/views.ts');

      expect(queries.getHyperedgeById(routeBinding.id)).toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS count FROM hyperedge_members').get() as { count: number }).count).toBe(0);
      expect(queries.getNodeById('node:view')).toBeNull();
      expect(queries.getFileByPath('src/views.ts')).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('cleans up hyperedges by kind, provenance, and orphan membership', () => {
    const { conn, queries, db } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      const dispatch = makeHyperedge('hyperedge:dynamic-dispatch:home', 'dynamic_dispatch');
      const bridge = { ...makeHyperedge('hyperedge:native-bridge:home', 'native_bridge'), provenance: 'manual' as const };
      queries.insertHyperedge(routeBinding, [
        makeMember(routeBinding.id, 'node:route', 'route', 0),
        makeMember(routeBinding.id, 'node:handler', 'handler', 1),
      ]);
      queries.insertHyperedge(dispatch, [
        makeMember(dispatch.id, 'node:handler', 'publisher', 0),
        makeMember(dispatch.id, 'node:view', 'subscriber', 1),
      ]);
      queries.insertHyperedge(bridge, [
        makeMember(bridge.id, 'node:handler', 'js', 0),
        makeMember(bridge.id, 'node:other', 'native', 1),
      ]);

      expect(queries.deleteHyperedgesByKind('dynamic_dispatch')).toBe(1);
      expect(queries.getHyperedgeById(dispatch.id)).toBeNull();
      expect(queries.deleteHyperedgesByProvenance('manual')).toBe(1);
      expect(queries.getHyperedgeById(bridge.id)).toBeNull();

      db.prepare('DELETE FROM hyperedge_members WHERE hyperedge_id = ?').run(routeBinding.id);
      expect(queries.deleteOrphanHyperedges()).toBe(1);
      expect(queries.getHyperedgeById(routeBinding.id)).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('returns pairwise edges by provenance', () => {
    const { conn, queries } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const heuristic: Edge = {
        source: 'node:route',
        target: 'node:handler',
        kind: 'calls',
        metadata: { synthesizedBy: 'test' },
        line: 1,
        column: 2,
        provenance: 'heuristic',
      };
      queries.insertEdges([
        heuristic,
        { source: 'node:handler', target: 'node:view', kind: 'calls', provenance: 'tree-sitter' },
      ]);

      expect(queries.getEdgesByProvenance('heuristic')).toEqual([heuristic]);
      expect(queries.getEdgesByProvenance('tree-sitter')).toEqual([
        { source: 'node:handler', target: 'node:view', kind: 'calls', provenance: 'tree-sitter' },
      ]);
    } finally {
      conn.close();
    }
  });

  it('includes hyperedge counts in stats when hyperedge tables exist', () => {
    const { conn, queries } = createQueries();
    try {
      seedHyperedgeNodes(queries);
      const routeBinding = makeHyperedge('hyperedge:route-binding:home');
      const dispatch = makeHyperedge('hyperedge:dynamic-dispatch:home', 'dynamic_dispatch');
      queries.insertHyperedge(routeBinding, [
        makeMember(routeBinding.id, 'node:route', 'route', 0),
        makeMember(routeBinding.id, 'node:handler', 'handler', 1),
      ]);
      queries.insertHyperedge(dispatch, [
        makeMember(dispatch.id, 'node:handler', 'publisher', 0),
        makeMember(dispatch.id, 'node:view', 'subscriber', 1),
      ]);

      const stats = queries.getStats();
      expect(stats.hyperedgeCount).toBe(2);
      expect(stats.hyperedgesByKind).toMatchObject({
        route_binding: 1,
        dynamic_dispatch: 1,
      });
    } finally {
      conn.close();
    }
  });
});
