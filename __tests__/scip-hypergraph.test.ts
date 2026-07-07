import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, createQueries, seedSolidKGNode, writeScipFixture } from './scip-test-helpers';
import { importScipIndexes, linkScipSymbolsToNodes } from '../src/scip';
import { synthesizeSemanticHyperedges } from '../src/hypergraph/synthesizer';
import { formatContextAsJson } from '../src/context/formatter';

afterEach(() => cleanupTempDirs());

describe('SCIP hypergraph synthesis', () => {
  it('strengthens dynamic_dispatch from SCIP implementation relationships', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const impl = seedSolidKGNode(queries);
      const contract = seedSolidKGNode(queries, {
        id: 'node:contract',
        kind: 'interface',
        name: 'Contract',
        qualifiedName: 'src/contract.ts::Contract',
        filePath: 'src/contract.ts',
      });
      const indexFile = writeScipFixture(root, 'dynamic.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipImplementation: true,
      });
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);

      const count = synthesizeSemanticHyperedges(queries);
      const relations = queries.getHyperedgesByNode(impl.id).filter((relation) => relation.hyperedge.kind === 'dynamic_dispatch');
      const contextJson = formatContextAsJson({
        query: 'implementation contract',
        subgraph: { nodes: new Map([[impl.id, impl], [contract.id, contract]]), edges: [], roots: [impl.id], hyperedges: relations },
        entryPoints: [impl],
        codeBlocks: [],
        relatedFiles: [impl.filePath, contract.filePath],
        summary: 'SCIP implementation relation',
        stats: { nodeCount: 2, edgeCount: 0, fileCount: 2, codeBlockCount: 0, totalCodeSize: 0 },
      });
      const parsed = JSON.parse(contextJson) as { hyperedges: Array<{ provenance?: string; hyperedge: { provenance?: string } }> };

      expect(count).toBeGreaterThan(0);
      expect(relations[0]?.members.map((member) => member.nodeId)).toEqual(expect.arrayContaining([impl.id, contract.id]));
      expect(relations[0]?.hyperedge.provenance).toBe('scip');
      expect(parsed.hyperedges[0]?.provenance).toBe('scip');
      expect(parsed.hyperedges[0]?.hyperedge.provenance).toBe('scip');
    } finally {
      conn.close();
    }
  });
});
