import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import { ToolHandler, tools } from '../src/mcp/tools';
import SolidKG from '../src/index';
import { HYPEREDGE_KINDS } from '../src/types';
import {
  canonicalizeScipSymbol,
  generateScipIndexes,
  importScipIndexes,
  linkScipSymbolsToNodes,
  normalizeScipDocumentPath,
  normalizeScipRange,
} from '../src/scip';
import { cleanupTempDirs, createQueries, createTempDir, seedSolidKGNode, writeManyScipDefinitionsFixture, writeRelationshipBeforeSymbolFixture, writeScipFixture } from './scip-test-helpers';

afterEach(() => cleanupTempDirs());

describe('SCIP storage schema', () => {
  it('fresh DB has SCIP schema and type_contract is a separate hyperedge kind', () => {
    const { conn } = createQueries();
    try {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      const db = conn.getDb();
      for (const table of ['scip_indexes', 'scip_documents', 'scip_symbols', 'scip_occurrences', 'scip_relationships']) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        expect(row).toBeTruthy();
      }
      const nodeColumns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
      expect(nodeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'scip_symbol',
        'scip_kind',
        'scip_display_name',
        'scip_signature',
        'scip_documentation',
        'scip_source_indexers',
      ]));
      expect(HYPEREDGE_KINDS).toContain('type_contract');
    } finally {
      conn.close();
    }
  });
});

describe('SCIP parser, normalization, import, linking, and edges', () => {
  it('clear removes imported SCIP state', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'generated.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      expect(queries.getScipStats()).toMatchObject({
        indexes: 1,
        documents: 1,
        relationships: 1,
      });

      queries.clear();

      expect(queries.getScipStats()).toMatchObject({
        indexes: 0,
        documents: 0,
        symbols: 0,
        occurrences: 0,
        relationships: 0,
        linkedNodes: 0,
      });
    } finally {
      conn.close();
    }
  });

  it('detects SCIP languages without materializing all file records', async () => {
    const { conn, queries, root } = createQueries();
    const originalGetAllFiles = queries.getAllFiles.bind(queries);
    try {
      queries.upsertFile({ path: 'src/a.ts', contentHash: 'a', language: 'typescript', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      queries.upsertFile({ path: 'src/b.tsx', contentHash: 'b', language: 'tsx', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      queries.upsertFile({ path: 'scripts/build.ps1', contentHash: 'c', language: 'powershell', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      queries.getAllFiles = (() => {
        throw new Error('getAllFiles should not be called for SCIP language detection');
      }) as typeof queries.getAllFiles;

      const result = await generateScipIndexes(queries, { projectRoot: root, mode: 'off' });

      expect(result.status.languages.typescript?.fileCount).toBe(2);
      expect(result.status.languages.powershell?.fileCount).toBe(1);
    } finally {
      queries.getAllFiles = originalGetAllFiles;
      conn.close();
    }
  });

  it('imports multiple indexes into one DB with scoped local symbols', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const first = writeScipFixture(root, 'first.scip', { relativePath: 'packages/a/src/service.ts', localCollision: true });
      const secondRoot = path.join(root, 'packages/b');
      const second = writeScipFixture(root, 'second.scip', {
        projectRoot: secondRoot,
        relativePath: 'src/service.ts',
        symbol: 'npm test 1.0.0 Other#run().',
        localCollision: true,
      });

      const stats = await importScipIndexes(queries, { projectRoot: root, indexFiles: [first, second] });

      expect(stats).toMatchObject({ indexes: 2, documents: 2, relationships: 0 });
      expect(stats.symbols).toBeGreaterThanOrEqual(4);
      expect(queries.getScipOccurrences('npm test 1.0.0 Service#run().')).toHaveLength(2);
      expect(queries.getScipSymbol(canonicalizeScipSymbol('doc:missing', 'local 1'))).toBeUndefined();
      const localSymbols = queries.searchScipSymbols('localValue').map((symbol) => symbol.symbol).sort();
      expect(localSymbols).toHaveLength(2);
      expect(new Set(localSymbols).size).toBe(2);
    } finally {
      conn.close();
    }
  });

  it('does not upsert existing SCIP symbols once per repeated occurrence', async () => {
    const { conn, queries, root } = createQueries();
    const originalUpsertScipSymbol = queries.upsertScipSymbol.bind(queries);
    try {
      const indexFile = writeScipFixture(root, 'repeated-occurrences.scip');
      let serviceSymbolUpserts = 0;
      queries.upsertScipSymbol = ((record) => {
        if (record.symbol === 'npm test 1.0.0 Service#run().') serviceSymbolUpserts++;
        return originalUpsertScipSymbol(record);
      }) as typeof queries.upsertScipSymbol;

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      expect(serviceSymbolUpserts).toBe(1);
      expect(queries.getScipOccurrences('npm test 1.0.0 Service#run().')).toHaveLength(2);
    } finally {
      queries.upsertScipSymbol = originalUpsertScipSymbol;
      conn.close();
    }
  });

  it('preserves rich SCIP symbol metadata when a relationship placeholder appears first', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeRelationshipBeforeSymbolFixture(root, 'relationship-before-symbol.scip');

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      expect(queries.getScipSymbol('npm test 1.0.0 Contract#')).toMatchObject({
        displayName: 'Contract',
        kind: 'Interface',
        documentation: 'Contract documentation.',
      });
    } finally {
      conn.close();
    }
  });

  it('rejects SCIP imports that exceed configured byte or fact limits', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'limited.scip');

      await expect(importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile], maxBytes: 1 })).rejects.toThrow(/larger than the configured limit/i);
      await expect(importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile], maxFacts: 1 })).rejects.toThrow(/more facts than the configured limit/i);
    } finally {
      conn.close();
    }
  });

  it('replacing a SCIP index removes stale symbols, occurrences, and relationships', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'generated.scip', {
        localCollision: true,
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      const localSymbol = queries.searchScipSymbols('localValue')[0]?.symbol;
      expect(localSymbol).toBeTruthy();
      expect(queries.getScipOccurrences(localSymbol as string)).toHaveLength(1);
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(1);

      writeScipFixture(root, 'generated.scip');
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      expect(queries.searchScipSymbols('localValue')).toHaveLength(0);
      expect(queries.getScipOccurrences(localSymbol as string)).toHaveLength(0);
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('failed SCIP replacement preserves the previous index atomically', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'atomic-replace.scip', { localCollision: true });
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      expect(queries.getScipStats().indexes).toBe(1);
      expect(queries.searchScipSymbols('localValue')).toHaveLength(1);

      writeScipFixture(root, 'atomic-replace.scip', { relativePath: '../outside.ts' });
      await expect(importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] })).rejects.toThrow(/outside workspace/i);

      expect(queries.getScipStats().indexes).toBe(1);
      expect(queries.searchScipSymbols('localValue')).toHaveLength(1);
    } finally {
      conn.close();
    }
  });

  it('replaces a SCIP index without materializing unrelated indexes or relationships', async () => {
    const { conn, queries, root } = createQueries();
    const db = (queries as unknown as { db: SqliteDatabase }).db;
    const originalPrepare = db.prepare.bind(db);
    try {
      const replaceable = writeScipFixture(root, 'bounded-replace.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });
      const unrelated = writeScipFixture(root, 'unrelated.scip', {
        relativePath: 'src/other.ts',
        symbol: 'npm test 1.0.0 Other#run().',
        relationshipTarget: 'npm test 1.0.0 OtherContract#',
        relationshipTypeDefinition: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [replaceable, unrelated] });
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(1);
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Other#run().', undefined, 'typeDefinition')).toHaveLength(1);

      db.prepare = ((sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized === 'SELECT * FROM scip_indexes' || normalized === 'SELECT * FROM scip_relationships') {
          throw new Error(`bounded SCIP replacement should not materialize broad table scan: ${normalized}`);
        }
        return originalPrepare(sql);
      }) as SqliteDatabase['prepare'];

      writeScipFixture(root, 'bounded-replace.scip');
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [replaceable] });

      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(0);
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Other#run().', undefined, 'typeDefinition')).toHaveLength(1);
    } finally {
      db.prepare = originalPrepare as SqliteDatabase['prepare'];
      conn.close();
    }
  });

  it('links SCIP definitions only to nodes in the matching document path', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const serviceRun = seedSolidKGNode(queries, { id: 'node:service-run', filePath: 'src/service.ts' });
      const otherRun = seedSolidKGNode(queries, {
        id: 'node:other-run',
        qualifiedName: 'src/other.ts::run',
        filePath: 'src/other.ts',
      });
      const indexFile = writeScipFixture(root, 'path-aware.scip', { relativePath: 'src/service.ts' });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);

      expect(queries.getNodeById(serviceRun.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
      expect(queries.getNodeById(otherRun.id)?.scipSymbol).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it('replacing one SCIP index preserves relationships still owned by another index', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const first = writeScipFixture(root, 'first-shared.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });
      const second = writeScipFixture(root, 'second-shared.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [first, second] });
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(1);

      writeScipFixture(root, 'second-shared.scip');
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [second] });
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(1);

      writeScipFixture(root, 'first-shared.scip');
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [first] });
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().', undefined, 'typeDefinition')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('replacing a SCIP index clears stale node links and SCIP-derived edges', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const run = seedSolidKGNode(queries);
      const contract = seedSolidKGNode(queries, {
        id: 'node:contract-replace',
        kind: 'interface',
        name: 'Contract',
        qualifiedName: 'src/contract.ts::Contract',
        filePath: 'src/contract.ts',
      });
      const indexFile = writeScipFixture(root, 'linked.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipImplementation: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);
      expect(queries.getNodeById(run.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
      expect(queries.getOutgoingEdges(run.id, ['implements'], 'scip').map((edge) => edge.target)).toContain(contract.id);

      writeScipFixture(root, 'linked.scip', {
        symbol: 'npm test 1.0.0 Other#go().',
        displayName: 'go',
      });
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);

      expect(queries.getNodeById(run.id)?.scipSymbol).toBeUndefined();
      expect(queries.getOutgoingEdges(run.id, ['implements'], 'scip')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('normalizes monorepo document paths and SCIP ranges', () => {
    expect(normalizeScipDocumentPath('C:/repo', 'C:/repo/packages/app', 'src/index.ts')).toBe('packages/app/src/index.ts');
    expect(normalizeScipDocumentPath('D:/repo', 'file:///D:/repo', 'src\\Program.cs')).toBe('src/Program.cs');
    expect(() => normalizeScipDocumentPath('C:/repo', 'C:/repo/packages/app', '../outside.ts')).toThrow(/outside workspace/i);
    expect(normalizeScipRange([4, 2, 8])).toEqual({ startLine: 5, startCharacter: 2, endLine: 5, endCharacter: 8 });
    expect(normalizeScipRange([4, 2, 6, 8])).toEqual({ startLine: 5, startCharacter: 2, endLine: 7, endCharacter: 8 });
  });

  it.runIf(process.platform === 'win32')('normalizes malformed Windows file URI roots emitted by SCIP indexers', () => {
    expect(normalizeScipDocumentPath('D:/repo', 'file://D:%5Crepo%5Cpackages%5Cgo', 'main.go')).toBe('packages/go/main.go');
  });

  it('links SCIP definitions to existing nodes and converts implementation relationships to graph edges', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const node = seedSolidKGNode(queries);
      const contract = seedSolidKGNode(queries, {
        id: 'node:contract',
        kind: 'interface',
        name: 'Contract',
        qualifiedName: 'src/contract.ts::Contract',
        filePath: 'src/contract.ts',
      });
      const indexFile = writeScipFixture(root, 'impl.scip', {
        symbol: 'npm test 1.0.0 Service#run().',
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipImplementation: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      const linkStats = linkScipSymbolsToNodes(queries);

      expect(linkStats.nodesUpdated).toBeGreaterThanOrEqual(1);
      expect(queries.getNodeById(node.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
      expect(queries.getNodeByScipSymbol('npm test 1.0.0 Service#run().')?.id).toBe(node.id);
      expect(queries.getScipSymbolForNode(node.id)?.displayName).toBe('run');
      const edges = queries.getOutgoingEdges(node.id, ['implements'], 'scip');
      expect(edges.map((edge) => edge.target)).toContain(contract.id);
    } finally {
      conn.close();
    }
  });

  it('links SCIP symbols without materializing every SolidKG node', async () => {
    const { conn, queries, root } = createQueries();
    const originalGetAllNodes = queries.getAllNodes.bind(queries);
    try {
      const node = seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'bounded-link.scip');
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      queries.getAllNodes = (() => {
        throw new Error('getAllNodes should not be called while linking SCIP symbols');
      }) as typeof queries.getAllNodes;

      linkScipSymbolsToNodes(queries);

      expect(queries.getNodeById(node.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
    } finally {
      queries.getAllNodes = originalGetAllNodes;
      conn.close();
    }
  });

  it('links many SCIP definitions with grouped candidate lookups and preserves implementation edges', async () => {
    const { conn, queries, root } = createQueries();
    const originalGetUnlinkedNodesByFilesAndNames = queries.getUnlinkedNodesByFilesAndNames.bind(queries);
    try {
      const definitionCount = 25;
      for (let index = 0; index < definitionCount; index++) {
        seedSolidKGNode(queries, {
          id: `node:run${index}`,
          name: `run${index}`,
          qualifiedName: `src/service.ts::run${index}`,
          filePath: 'src/service.ts',
          startLine: index + 1,
          endLine: index + 1,
        });
      }
      const contract = seedSolidKGNode(queries, {
        id: 'node:contract-many',
        kind: 'interface',
        name: 'Contract',
        qualifiedName: 'src/contract.ts::Contract',
        filePath: 'src/contract.ts',
      });
      const indexFile = writeManyScipDefinitionsFixture(root, 'many-definitions.scip', definitionCount);
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      let candidateLookups = 0;
      queries.getUnlinkedNodesByFilesAndNames = ((filePaths, names) => {
        candidateLookups++;
        return originalGetUnlinkedNodesByFilesAndNames(filePaths, names);
      }) as typeof queries.getUnlinkedNodesByFilesAndNames;

      const linkStats = linkScipSymbolsToNodes(queries);

      expect(candidateLookups).toBe(1);
      expect(linkStats.nodesUpdated).toBe(definitionCount + 1);
      for (let index = 0; index < definitionCount; index++) {
        const node = queries.getNodeById(`node:run${index}`);
        expect(node?.scipSymbol).toBe(`npm test 1.0.0 Service#run${index}().`);
        expect(queries.getOutgoingEdges(node!.id, ['implements'], 'scip').map((edge) => edge.target)).toContain(contract.id);
      }
    } finally {
      queries.getUnlinkedNodesByFilesAndNames = originalGetUnlinkedNodesByFilesAndNames;
      conn.close();
    }
  });

  it('preserves linked SCIP node metadata when normal indexing rewrites a node', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const node = seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'refs.scip');

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);

      queries.insertNode({ ...node, signature: '(): number', updatedAt: 2 });
      expect(queries.getNodeById(node.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');

      queries.updateNode({ ...node, signature: '(): string', updatedAt: 3 });
      expect(queries.getNodeById(node.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
    } finally {
      conn.close();
    }
  });

  it('preserves linked SCIP node metadata when file reindex deletes and reinserts nodes', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const node = seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'refs.scip');

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);
      expect(queries.getNodeById(node.id)?.scipSymbol).toBe('npm test 1.0.0 Service#run().');

      queries.deleteFile(node.filePath);
      expect(queries.getNodeById(node.id)).toBeNull();
      queries.upsertFile({
        path: node.filePath,
        contentHash: 'hash:reindexed',
        language: node.language,
        size: 120,
        modifiedAt: 2,
        indexedAt: 2,
        nodeCount: 1,
      });
      queries.insertNode({ ...node, signature: '(): string', updatedAt: 2 });

      const reindexed = queries.getNodeById(node.id);
      expect(reindexed?.signature).toBe('(): string');
      expect(reindexed?.scipSymbol).toBe('npm test 1.0.0 Service#run().');
      expect(reindexed?.scipDisplayName).toBe('run');
    } finally {
      conn.close();
    }
  });

  it('deleteFile can remove SCIP facts scoped to a deleted source file', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const node = seedSolidKGNode(queries);
      const contract = seedSolidKGNode(queries, {
        id: 'node:contract-delete-file',
        kind: 'interface',
        name: 'Contract',
        qualifiedName: 'src/contract.ts::Contract',
        filePath: 'src/contract.ts',
      });
      const indexFile = writeScipFixture(root, 'delete-file.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipImplementation: true,
      });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      linkScipSymbolsToNodes(queries);
      expect(queries.getScipOccurrences('npm test 1.0.0 Service#run().')).toHaveLength(2);
      expect(queries.getOutgoingEdges(node.id, ['implements'], 'scip').map((edge) => edge.target)).toContain(contract.id);

      queries.deleteFile(node.filePath, { deleteScipFacts: true });

      expect(queries.getNodeById(node.id)).toBeNull();
      expect(queries.getScipOccurrences('npm test 1.0.0 Service#run().')).toHaveLength(0);
      expect(queries.getScipDocuments().map((document) => document.repoRelativePath)).not.toContain(node.filePath);
      expect(queries.getScipRelationshipsForSymbol('npm test 1.0.0 Service#run().')).toHaveLength(0);
      expect(queries.getOutgoingEdges(node.id, ['implements'], 'scip')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });
});

describe('SCIP MCP tools and status', () => {
  it('registers one generic precise refs tool and no language-specific refs tools', () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('solidkg_precise_refs');
    expect(names).not.toEqual(expect.arrayContaining(['typescript_refs', 'python_refs', 'java_refs', 'rust_refs']));
  });

  it('solidkg_precise_refs returns exact definitions and references by nodeId', async () => {
    const root = createTempDir();
    const cg = SolidKG.initSync(root);
    try {
      const queries = new QueryBuilderAccessor(cg).queries;
      const node = seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'refs.scip');
      await cg.importScipIndexes([indexFile]);

      const handler = new ToolHandler(cg);
      const precise = await handler.execute('solidkg_precise_refs', { nodeId: node.id, includeReferences: true });
      const text = precise.content[0]?.text ?? '';
      expect(text).toContain('## Precise references');
      expect(text).toContain(`**Node ID:** ${node.id}`);
      expect(text).toContain('Definition');
      expect(text).toContain('src/service.ts:1');
      expect(text).toContain('References');

      const status = await handler.execute('solidkg_status', {});
      expect(status.content[0]?.text).toContain('SCIP');
    } finally {
      cg.destroy();
    }
  });

  it('solidkg_precise_refs sees SCIP links after a node was cached before import', async () => {
    const root = createTempDir();
    const cg = SolidKG.initSync(root);
    try {
      const queries = new QueryBuilderAccessor(cg).queries;
      const node = seedSolidKGNode(queries);
      expect(queries.getNodeById(node.id)?.scipSymbol).toBeUndefined();
      const indexFile = writeScipFixture(root, 'cached-node.scip');

      await cg.importScipIndexes([indexFile]);

      const precise = await new ToolHandler(cg).execute('solidkg_precise_refs', { nodeId: node.id, includeReferences: true });
      const text = precise.content[0]?.text ?? '';
      expect(text).toContain('## Precise references');
      expect(text).toContain(`**Node ID:** ${node.id}`);
      expect(text).toContain('src/service.ts:1');
    } finally {
      cg.destroy();
    }
  });

  it('solidkg_precise_refs supports symbol lookup and filtered sections', async () => {
    const root = createTempDir();
    const cg = SolidKG.initSync(root);
    try {
      const queries = new QueryBuilderAccessor(cg).queries;
      seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'refs.scip');
      await cg.importScipIndexes([indexFile]);

      const handler = new ToolHandler(cg);
      const precise = await handler.execute('solidkg_precise_refs', {
        symbol: 'run',
        includeReferences: false,
        includeImplementations: false,
        includeTypeDefinitions: false,
      });
      const text = precise.content[0]?.text ?? '';
      expect(text).toContain('npm test 1.0.0 Service#run().');
      expect(text).toContain('Definitions');
      expect(text).toContain('src/service.ts:1');
      expect(text).not.toContain('#### References');
    } finally {
      cg.destroy();
    }
  });

  it('solidkg_precise_refs escapes broad LIKE wildcards and exposes type-definition relationships', async () => {
    const root = createTempDir();
    const cg = SolidKG.initSync(root);
    try {
      const queries = new QueryBuilderAccessor(cg).queries;
      seedSolidKGNode(queries);
      const indexFile = writeScipFixture(root, 'typedef.scip', {
        relationshipTarget: 'npm test 1.0.0 Contract#',
        relationshipTypeDefinition: true,
      });
      await cg.importScipIndexes([indexFile]);

      const handler = new ToolHandler(cg);
      const broad = await handler.execute('solidkg_precise_refs', { symbol: '%', limit: 1 });
      expect(broad.content[0]?.text ?? '').toContain('No SCIP symbol or linked node found for "%"');

      const precise = await handler.execute('solidkg_precise_refs', {
        symbol: 'run',
        includeReferences: false,
        includeImplementations: false,
        includeTypeDefinitions: true,
      });
      const text = precise.content[0]?.text ?? '';
      expect(text).toContain('#### Type definitions');
      expect(text).toContain('npm test 1.0.0 Contract#');
    } finally {
      cg.destroy();
    }
  });

  it('primary MCP tools surface linked SCIP facts', async () => {
    const root = createTempDir();
    const cg = SolidKG.initSync(root);
    try {
      const queries = new QueryBuilderAccessor(cg).queries;
      const caller = seedSolidKGNode(queries, {
        id: 'node:caller',
        name: 'caller',
        qualifiedName: 'src/service.ts::caller',
        startLine: 3,
        endLine: 3,
      });
      const run = seedSolidKGNode(queries, { id: 'node:run' });
      queries.insertEdge({ source: caller.id, target: run.id, kind: 'calls' });
      const indexFile = writeScipFixture(root, 'refs.scip');
      await cg.importScipIndexes([indexFile]);

      const handler = new ToolHandler(cg);
      const search = await handler.execute('solidkg_search', { query: 'run' });
      const searchText = search.content[0]?.text ?? '';
      expect(searchText).toContain(`Node ID: ${run.id}`);
      expect(searchText).toContain('SCIP symbol: npm test 1.0.0 Service#run().');

      const node = await handler.execute('solidkg_node', { symbol: 'run' });
      const nodeText = node.content[0]?.text ?? '';
      expect(nodeText).toContain('### Precise references (SCIP)');
      expect(nodeText).toContain(`**Node ID:** ${run.id}`);

      const context = await handler.execute('solidkg_context', { task: 'run', includeCode: false });
      const contextText = context.content[0]?.text ?? '';
      expect(contextText).toContain('## SCIP');
      expect(contextText).toContain('Precise refs available for: run');
      expect(contextText).toContain('Use `solidkg_precise_refs` for exact locations.');
      expect(contextText).not.toContain('## Precise references (SCIP)');
      expect(contextText).not.toContain('nodeId:');
      expect(contextText).not.toContain('npm test 1.0.0');
      expect(contextText).not.toContain('[object Object]');

      const trace = await handler.execute('solidkg_trace', { from: 'caller', to: 'run' });
      expect(trace.content[0]?.text ?? '').toContain('SCIP precise refs');

      const scipTrace = await handler.execute('solidkg_trace', {
        from: 'caller',
        to: 'npm test 1.0.0 Service#run().',
      });
      const scipTraceText = scipTrace.content[0]?.text ?? '';
      expect(scipTraceText).toContain('## Trace: caller');
      expect(scipTraceText).toContain('SCIP precise refs');
      expect(scipTraceText).not.toContain('not found');
    } finally {
      cg.destroy();
    }
  });
});

class QueryBuilderAccessor {
  readonly queries: import('../src/db/queries').QueryBuilder;

  constructor(cg: SolidKG) {
    const holder = cg as unknown as { queries: import('../src/db/queries').QueryBuilder };
    this.queries = holder.queries;
  }
}

describe('SCIP automatic generation integration', () => {
  it('SolidKG.init with index true skips SCIP generation by default and honors explicit scip auto', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'service.ts'), 'export function run(): void {}\nrun();\n');
    const fixture = writeScipFixture(root, 'init-generated-fixture.scip');
    const marker = path.join(root, 'init-marker.txt');
    const script = path.join(root, 'copy-scip.js');
    fs.writeFileSync(script, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv[3]); fs.writeFileSync(process.argv[4], 'ran');\n");

    const skipped = await SolidKG.init(root, {
      index: true,
      scipIndexers: {
        typescript: { command: process.execPath, args: [script, fixture, '{output}', marker], files: ['**/*.ts'] },
      },
    });
    try {
      const stats = skipped.getStats();
      expect(stats.fileCount).toBeGreaterThan(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(stats.scip?.indexes).toBe(0);
      expect(stats.scip?.linkedNodes).toBe(0);
      expect(stats.scip?.generation?.mode).toBe('off');
      expect(stats.scip?.generation?.languages.typescript?.state).toBe('skipped');
    } finally {
      skipped.destroy();
    }

    const autoRoot = createTempDir();
    fs.mkdirSync(path.join(autoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(autoRoot, 'src', 'service.ts'), 'export function run(): void {}\nrun();\n');
    const autoFixture = writeScipFixture(autoRoot, 'init-generated-fixture.scip');
    const autoMarker = path.join(autoRoot, 'init-marker.txt');
    const autoScript = path.join(autoRoot, 'copy-scip.js');
    fs.writeFileSync(autoScript, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv[3]); fs.writeFileSync(process.argv[4], 'ran');\n");

    const auto = await SolidKG.init(autoRoot, {
      index: true,
      scip: 'auto',
      scipIndexers: {
        typescript: { command: process.execPath, args: [autoScript, autoFixture, '{output}', autoMarker], files: ['**/*.ts'] },
      },
    });
    try {
      const stats = auto.getStats();
      expect(fs.existsSync(autoMarker)).toBe(true);
      expect(stats.scip?.indexes).toBeGreaterThan(0);
      expect(stats.scip?.linkedNodes).toBeGreaterThan(0);
      expect(stats.scip?.generation?.mode).toBe('auto');
      expect(stats.scip?.generation?.languages.typescript?.state).toBe('generated');
    } finally {
      auto.destroy();
    }
  });

  it('indexAll with scip auto generates, imports, links, and reports SCIP status', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'service.ts'), 'export function run(): void {}\nrun();\n');
    const fixture = writeScipFixture(root, 'generated-fixture.scip');
    const script = path.join(root, 'copy-scip.js');
    fs.writeFileSync(script, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv[3]);\n");

    const cg = SolidKG.initSync(root);
    try {
      const phases: string[] = [];
      const result = await cg.indexAll({
        onProgress: (progress) => phases.push(progress.phase),
        scip: 'auto',
        scipIndexers: {
          typescript: { command: process.execPath, args: [script, fixture, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      const stats = cg.getStats();
      expect(stats.scip?.indexes).toBeGreaterThan(0);
      expect(stats.scip?.linkedNodes).toBeGreaterThan(0);
      expect(stats.scip?.generation?.languages.typescript?.state).toBe('generated');
      expect(phases).toContain('scip');
      expect(phases.filter((phase) => phase === 'scip')).toHaveLength(1);
      expect(phases).not.toContain('scip_generate');
      expect(phases).not.toContain('scip_import');
      expect(phases).not.toContain('scip_link');

      const handler = new ToolHandler(cg);
      const status = await handler.execute('solidkg_status', {});
      expect(status.content[0]?.text ?? '').toContain('typescript: generated');
    } finally {
      cg.destroy();
    }
  });

  it('indexAll required records SCIP failure while keeping AST graph queryable', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'service.ts'), 'export function run(): void {}\n');

    const cg = SolidKG.initSync(root);
    try {
      const result = await cg.indexAll({
        scip: 'required',
        scipIndexers: {
          typescript: { command: 'definitely-not-a-scip-indexer-command', args: ['--output', '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join('\n')).toMatch(/SCIP/i);
      expect(cg.searchNodes('run', { limit: 5 }).some((entry) => entry.node.name === 'run')).toBe(true);
      expect(cg.getStats().scip?.generation?.languages.typescript?.state).toBe('indexer-missing');
    } finally {
      cg.destroy();
    }
  });

  it('indexAll off skips generation and leaves explicit SCIP import usable', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'service.ts'), 'export function run(): void {}\n');
    const marker = path.join(root, 'marker.txt');
    const script = path.join(root, 'marker.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);

    const cg = SolidKG.initSync(root);
    try {
      const result = await cg.indexAll({
        scip: 'off',
        scipIndexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(cg.getStats().scip?.generation?.languages.typescript?.state).toBe('skipped');

      const indexFile = writeScipFixture(root, 'manual.scip');
      await cg.importScipIndexes([indexFile]);
      const precise = await new ToolHandler(cg).execute('solidkg_precise_refs', { symbol: 'run' });
      expect(precise.content[0]?.text ?? '').toContain('## Precise references');
    } finally {
      cg.destroy();
    }
  });

  it('sync removes SCIP occurrences and links for deleted source files', async () => {
    const root = createTempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'service.ts'), 'export function run(): void {}\nrun();\n');

    const cg = SolidKG.initSync(root);
    try {
      await cg.indexAll({ scip: 'off' });
      const indexFile = writeScipFixture(root, 'delete-sync.scip');
      await cg.importScipIndexes([indexFile]);
      expect(cg.searchNodes('run', { limit: 5 }).some((entry) => entry.node.scipSymbol === 'npm test 1.0.0 Service#run().')).toBe(true);

      fs.unlinkSync(path.join(root, 'src', 'service.ts'));
      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);
      expect(cg.searchNodes('run')).toHaveLength(0);
      const queries = new QueryBuilderAccessor(cg).queries;
      expect(queries.getScipOccurrences('npm test 1.0.0 Service#run().')).toHaveLength(0);
      expect(queries.getScipDocuments().map((document) => document.repoRelativePath)).not.toContain('src/service.ts');
      expect(queries.getScipSymbolForNode('node:run')).toBeUndefined();
    } finally {
      cg.destroy();
    }
  });
});
