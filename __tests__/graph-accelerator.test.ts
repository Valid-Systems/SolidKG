import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import {
  RelationAwareAdjacencyIndex,
  buildGraphTraversalPacket,
  formatGraphTraversalPacketMarkdown,
  runGraphPattern,
} from '../src/graph';
import type { Edge, Node } from '../src/types';

function fixtureNode(id: string, name: string, line: number): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `src/main.ts::${name}`,
    filePath: 'src/main.ts',
    language: 'typescript',
    startLine: line,
    endLine: line + 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: line,
  };
}

function createFixtureGraph(): { readonly conn: DatabaseConnection; readonly queries: QueryBuilder; readonly dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-adjacency-'));
  const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  const queries = new QueryBuilder(conn.getDb());
  const nodes = [
    fixtureNode('a', 'alpha', 1),
    fixtureNode('b', 'beta', 5),
    fixtureNode('c', 'gamma', 9),
    fixtureNode('d', 'delta', 13),
  ];
  queries.insertNodes(nodes);
  queries.insertEdges([
    { source: 'a', target: 'b', kind: 'calls', line: 2, provenance: 'tree-sitter' },
    { source: 'c', target: 'b', kind: 'references', line: 10, provenance: 'scip' },
    { source: 'b', target: 'd', kind: 'imports', line: 6, provenance: 'heuristic' },
  ]);
  return { conn, queries, dir };
}

describe('relation-aware adjacency accelerator', () => {
  let conn: DatabaseConnection | undefined;
  let tempDir: string | undefined;

  afterEach(() => {
    conn?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    conn = undefined;
    tempDir = undefined;
  });

  it('builds deterministic forward and reverse adjacency from SQLite edges', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;

    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    expect(index.getNeighbors('a', { direction: 'forward', edgeKinds: ['calls'] }).map((edge) => edge.target)).toEqual(['b']);
    expect(index.getNeighbors('b', { direction: 'reverse', edgeKinds: ['calls', 'references'] }).map((edge) => edge.source)).toEqual(['a', 'c']);
    expect(index.getNeighbors('b', { direction: 'reverse', edgeKinds: ['calls'] }).map((edge) => edge.source)).toEqual(['a']);
    expect(index.getRelationCounts('b')).toEqual({ calls: 1, imports: 1, references: 1 });
  });

  it('runs bounded BFS with explicit partial coverage when limits stop traversal', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    const result = index.boundedBfs(['b'], {
      direction: 'both',
      edgeKinds: ['calls', 'references', 'imports'],
      maxDepth: 2,
      maxNodes: 2,
      maxEdges: 3,
      budgetMs: 1000,
    });

    expect(result.nodeIds).toEqual(['b', 'a']);
    expect(result.coverage.status).toBe('partial');
    expect(result.coverage.limitsHit).toContain('maxNodes');
  });

  it('distinguishes absent paths from bounded partial path searches', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    const absent = index.findPaths('a', 'c', {
      direction: 'forward',
      edgeKinds: ['calls'],
      maxDepth: 3,
      maxNodes: 10,
      maxEdges: 10,
      maxPaths: 1,
      budgetMs: 1000,
    });
    const partial = index.findPaths('a', 'd', {
      direction: 'forward',
      edgeKinds: ['calls', 'imports'],
      maxDepth: 1,
      maxNodes: 10,
      maxEdges: 10,
      maxPaths: 1,
      budgetMs: 1000,
    });

    expect(absent.coverage.status).toBe('absent');
    expect(partial.coverage.status).toBe('partial');
    expect(partial.coverage.limitsHit).toContain('maxDepth');
  });

  it('maps only allowlisted graph patterns to traversal primitives', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    const callers = runGraphPattern(index, 'direct_callers', ['b'], { budgetMs: 1000 });

    expect(callers.nodeIds).toEqual(['b', 'a']);
    expect(() => runGraphPattern(index, 'cypher_match', ['b'], { budgetMs: 1000 })).toThrow(/Unsupported graph pattern/);
  });

  it('keeps direct caller and callee patterns call-only', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    const callers = runGraphPattern(index, 'direct_callers', ['b'], { budgetMs: 1000 });
    const callees = runGraphPattern(index, 'direct_callees', ['b'], { budgetMs: 1000 });

    expect(callers.edges.map((edge) => edge.kind)).toEqual(['calls']);
    expect(callers.nodeIds).not.toContain('c');
    expect(callees.nodeIds).toEqual(['b']);
    expect(callees.edges).toEqual([]);
  });

  it('renders graph traversal packets with provenance and coverage evidence', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);
    const result = index.boundedBfs(['b'], {
      direction: 'reverse',
      edgeKinds: ['calls', 'references'],
      maxDepth: 1,
      maxNodes: 10,
      maxEdges: 10,
      budgetMs: 1000,
    });

    const packet = buildGraphTraversalPacket({
      queryKind: 'direct_callers',
      startNodeIds: ['b'],
      direction: 'reverse',
      edgeKinds: ['calls', 'references'],
      maxDepth: 1,
      result,
      relationCounts: index.getRelationCounts('b'),
    });

    expect(packet.evidence.deterministic).toContain('calls: a -> b');
    expect(packet.evidence.scip).toContain('references: c -> b');
    expect(packet.evidence.heuristic).toEqual([]);
    expect(formatGraphTraversalPacketMarkdown(packet)).toContain('### Graph Traversal Packet');
  });

  it('records a lightweight direct-SQL versus adjacency traversal perf sample', () => {
    const fixture = createFixtureGraph();
    conn = fixture.conn;
    tempDir = fixture.dir;
    const index = RelationAwareAdjacencyIndex.build(fixture.queries);

    const sqliteStartedAt = performance.now();
    const sqliteEdges = fixture.queries.getIncomingEdges('b', ['calls', 'references']);
    const sqliteElapsedMs = performance.now() - sqliteStartedAt;

    const adjacencyStartedAt = performance.now();
    const adjacency = index.boundedBfs(['b'], {
      direction: 'reverse',
      edgeKinds: ['calls', 'references'],
      maxDepth: 1,
      maxNodes: 10,
      maxEdges: 10,
      budgetMs: 1000,
    });
    const adjacencyElapsedMs = performance.now() - adjacencyStartedAt;

    const sample = {
      graphSize: 4,
      edgeCount: 3,
      queryType: 'direct_callers',
      sqliteElapsedMs,
      adjacencyElapsedMs,
      limitsHit: adjacency.coverage.limitsHit,
    };

    expect(sqliteEdges).toHaveLength(2);
    expect(adjacency.edges).toHaveLength(2);
    expect(sample.limitsHit).toEqual([]);
    expect(sample.sqliteElapsedMs).toBeGreaterThanOrEqual(0);
    expect(sample.adjacencyElapsedMs).toBeGreaterThanOrEqual(0);
  });
});
