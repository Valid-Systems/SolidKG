import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { GraphTraverser } from '../src/graph/traversal';
import type { Hyperedge, Node } from '../src/types';

describe('hypergraph traversal', () => {
  let testDir: string;
  let cg: SolidKG;
  let queries: QueryBuilder;
  let traverser: GraphTraverser;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-hypergraph-traversal-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'flow.ts'), `
export function source(): void {}
export function middle(): void {}
export function sink(): void {}
export function observer(): void {}
export function audit(): void {}
export function nativeSink(): void {}
`);

    cg = SolidKG.initSync(testDir, {
      config: {
        include: ['src/**/*.ts'],
        exclude: [],
      },
    });
    await cg.indexAll();
    queries = (cg as unknown as { queries: QueryBuilder }).queries;
    traverser = new GraphTraverser(queries);
    seedHyperedges();
  });

  afterEach(() => {
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('default traversal ignores hyperedges', () => {
    const source = requireNode('source');

    const bfs = traverser.traverseBFS(source.id, { maxDepth: 3 });
    const dfs = traverser.traverseDFS(source.id, { maxDepth: 3 });

    expect(names(bfs.nodes)).toEqual(['source']);
    expect(bfs.edges).toEqual([]);
    expect(bfs.hyperedges).toBeUndefined();
    expect(names(dfs.nodes)).toEqual(['source']);
    expect(dfs.edges).toEqual([]);
    expect(dfs.hyperedges).toBeUndefined();
  });

  it('members expansion includes relation members and hyperedges', () => {
    const source = requireNode('source');

    const subgraph = traverser.traverseBFS(source.id, {
      includeHyperedges: true,
      hyperedgeExpansion: 'members',
      hyperedgeKinds: ['dynamic_dispatch'],
      maxDepth: 1,
    });

    expect(names(subgraph.nodes)).toEqual(['middle', 'sink', 'source']);
    expect(subgraph.edges).toEqual([]);
    expect(subgraph.hyperedges?.map((relation) => relation.hyperedge.id)).toEqual(['he:dynamic:flow']);
    expect(subgraph.hyperedges?.[0]?.members.map((member) => [member.role, member.node.name])).toEqual([
      ['producer', 'source'],
      ['transform', 'middle'],
      ['consumer', 'sink'],
    ]);
  });

  it('ordered-flow expands by ordinal without clique expansion', () => {
    const middle = requireNode('middle');

    const subgraph = traverser.traverseBFS(middle.id, {
      includeHyperedges: true,
      hyperedgeExpansion: 'ordered-flow',
      hyperedgeKinds: ['dynamic_dispatch'],
      maxDepth: 1,
    });

    expect(names(subgraph.nodes)).toEqual(['middle', 'sink']);
    expect(subgraph.nodes.has(requireNode('source').id)).toBe(false);
    expect(subgraph.edges).toEqual([]);
    expect(subgraph.hyperedges?.map((relation) => relation.hyperedge.id)).toEqual(['he:dynamic:flow']);
  });

  it('hyperedgeKinds filters matching relations', () => {
    const source = requireNode('source');

    const subgraph = traverser.traverseBFS(source.id, {
      includeHyperedges: true,
      hyperedgeExpansion: 'members',
      hyperedgeKinds: ['event_channel'],
      maxDepth: 1,
    });

    expect(names(subgraph.nodes)).toEqual(['observer', 'source']);
    expect(subgraph.hyperedges?.map((relation) => relation.hyperedge.id)).toEqual(['he:event:observer']);
  });

  it('maxHyperedges deterministically caps included and expanded relations', () => {
    const source = requireNode('source');

    const subgraph = traverser.traverseBFS(source.id, {
      includeHyperedges: true,
      hyperedgeExpansion: 'members',
      maxDepth: 1,
      maxHyperedges: 1,
    });

    expect(subgraph.hyperedges?.map((relation) => relation.hyperedge.id)).toEqual(['he:dynamic:flow']);
    expect(names(subgraph.nodes)).toEqual(['middle', 'sink', 'source']);
  });

  function seedHyperedges(): void {
    insertHyperedge('he:event:observer', 'event_channel', [
      ['source', 'publisher', 0],
      ['observer', 'listener', 1],
    ]);
    insertHyperedge('he:dynamic:flow', 'dynamic_dispatch', [
      ['source', 'producer', 0],
      ['middle', 'transform', 1],
      ['sink', 'consumer', 2],
    ]);
    insertHyperedge('he:native:sink', 'native_bridge', [
      ['source', 'js', 0],
      ['nativeSink', 'native', 1],
    ]);
  }

  function insertHyperedge(
    id: string,
    kind: Hyperedge['kind'],
    members: Array<[name: string, role: string, ordinal: number]>
  ): void {
    queries.insertHyperedge({
      id,
      kind,
      sourceFile: 'src/flow.ts',
      line: 1,
      column: 0,
      provenance: 'heuristic',
      confidence: 0.9,
      metadata: { test: true },
      createdAt: 1,
      updatedAt: 1,
    }, members.map(([name, role, ordinal]) => ({
      hyperedgeId: id,
      nodeId: requireNode(name).id,
      role,
      ordinal,
    })));
  }

  function requireNode(name: string): Node {
    const node = cg.getNodesByKind('function').find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Missing test node ${name}`);
    return node;
  }
});

function names(nodes: Map<string, Node>): string[] {
  return Array.from(nodes.values()).map((node) => node.name).sort();
}
