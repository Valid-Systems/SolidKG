import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { buildSourceChunkCodeTokenText, buildSourceChunkFtsQuery, tokenizeCodeForSearch } from '../src/search/query-utils';
import type { IndexProgress } from '../src/extraction';
import type { Language, Node, RetrievalExtensionConfig, SearchResult, SourceChunkRecord } from '../src/types';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeNode(id: string, filePath = 'src/example.ts', name = 'parseRequest'): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine: 10,
    endLine: 30,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1_000,
  };
}

function reasonKinds(result: SearchResult | undefined): string[] {
  return result.rankingReasons?.map((reason) => reason.kind) ?? [];
}

function setupFusionFixture(): { readonly conn: DatabaseConnection; readonly queries: QueryBuilder } {
  const dbPath = path.join(createTempDir('chunk-fusion-'), 'solidkg.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const queries = new QueryBuilder(conn.getDb());
  const files = [
    { path: 'src/workflows/invoice.ts', hash: 'sha256:fusion-source', language: 'typescript' as const, size: 512 },
    { path: 'src/controllers/checkout-controller.ts', hash: 'sha256:fusion-exact', language: 'typescript' as const, size: 384 },
    { path: 'src/generated/invoice.generated.ts', hash: 'sha256:fusion-generated', language: 'typescript' as const, size: 384 },
    { path: 'src/workflows/invoice.test.ts', hash: 'sha256:fusion-test', language: 'typescript' as const, size: 384 },
  ];
  for (const file of files) {
    queries.upsertFile({
      path: file.path,
      contentHash: file.hash,
      language: file.language,
      size: file.size,
      modifiedAt: 1_000,
      indexedAt: 1_000,
      nodeCount: 1,
    });
  }

  queries.insertNode(makeNode('node-body', 'src/workflows/invoice.ts', 'settleInvoice'));
  queries.insertNode(makeNode('node-exact', 'src/controllers/checkout-controller.ts', 'CheckoutController'));
  queries.insertNode(makeNode('node-generated', 'src/generated/invoice.generated.ts', 'generatedInvoiceFixture'));
  queries.insertNode(makeNode('node-test', 'src/workflows/invoice.test.ts', 'invoiceTestFixture'));
  queries.upsertSourceChunks([
    makeChunk({
      id: 'chunk:node-body:0:v1',
      nodeId: 'node-body',
      filePath: 'src/workflows/invoice.ts',
      contentHash: 'sha256:chunk-body',
      sourceHash: 'sha256:fusion-source',
      content: 'function settleInvoice() { return reconcile line items against payment gateway receipts; }',
      codeTokenText: buildSourceChunkCodeTokenText('function settleInvoice() { return reconcile line items against payment gateway receipts; }'),
    }),
    makeChunk({
      id: 'chunk:node-exact:0:v1',
      nodeId: 'node-exact',
      filePath: 'src/controllers/checkout-controller.ts',
      contentHash: 'sha256:chunk-exact',
      sourceHash: 'sha256:fusion-exact',
      content: 'class CheckoutController { reconcile reconcile reconcile payment gateway receipts line items; }',
      codeTokenText: buildSourceChunkCodeTokenText('class CheckoutController { reconcile reconcile reconcile payment gateway receipts line items; }'),
    }),
    makeChunk({
      id: 'chunk:node-generated:0:v1',
      nodeId: 'node-generated',
      filePath: 'src/generated/invoice.generated.ts',
      contentHash: 'sha256:chunk-generated',
      sourceHash: 'sha256:fusion-generated',
      content: 'function generatedInvoiceFixture() { return reconcile line items against payment gateway receipts; }',
      codeTokenText: buildSourceChunkCodeTokenText('function generatedInvoiceFixture() { return reconcile line items against payment gateway receipts; }'),
    }),
    makeChunk({
      id: 'chunk:node-test:0:v1',
      nodeId: 'node-test',
      filePath: 'src/workflows/invoice.test.ts',
      contentHash: 'sha256:chunk-test',
      sourceHash: 'sha256:fusion-test',
      content: 'it reconciles line items against payment gateway receipts in a fixture',
      codeTokenText: buildSourceChunkCodeTokenText('it reconciles line items against payment gateway receipts in a fixture'),
    }),
  ]);
  return { conn, queries };
}

function makeChunk(overrides: Partial<SourceChunkRecord> = {}): SourceChunkRecord {
  return {
    id: 'chunk:node-1:0:v1',
    nodeId: 'node-1',
    filePath: 'src/example.ts',
    language: 'typescript',
    symbolKind: 'function',
    startLine: 10,
    endLine: 18,
    contentHash: 'sha256:chunk-one',
    sourceHash: 'sha256:file-one',
    chunkOrdinal: 0,
    indexerVersion: 'chunk-indexer-v1',
    content: 'function parseRequest(input) { return normalizeBody(input.body); }',
    codeTokenText: 'function identifier parseRequest identifier normalizeBody property body',
    metadata: { producer: 'chunk-retrieval-test' },
    diagnostics: [{ message: 'tokenized for storage contract', severity: 'info', code: 'chunk.test' }],
    updatedAt: 2_000,
    ...overrides,
  };
}

function tableNames(db: ReturnType<DatabaseConnection['getDb']>): string[] {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'view')
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(db: ReturnType<DatabaseConnection['getDb']>, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

function ftsHitCount(db: ReturnType<DatabaseConnection['getDb']>, query: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM source_chunks_fts
    WHERE source_chunks_fts MATCH ?
  `).get(query) as { count: number };
  return row.count;
}

function expectChunkSchema(db: ReturnType<DatabaseConnection['getDb']>): void {
  expect(tableNames(db)).toEqual(expect.arrayContaining(['source_chunks', 'source_chunks_fts']));
  expect(indexNames(db, 'source_chunks')).toEqual(expect.arrayContaining([
    'idx_source_chunks_file_path',
    'idx_source_chunks_node_id',
    'idx_source_chunks_identity',
  ]));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('chunk projection schema', () => {
  it('creates source chunk storage and dedicated FTS on a fresh DB', () => {
    // Given: a new public DB initialization path.
    const dbPath = path.join(createTempDir('chunk-schema-fresh-'), 'solidkg.db');

    // When: the database is initialized from schema.sql.
    const conn = DatabaseConnection.initialize(dbPath);

    try {
      // Then: chunk projection tables are present without expanding nodes_fts.
      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expectChunkSchema(conn.getDb());
      const nodeFtsColumns = conn.getDb().prepare('PRAGMA table_info(nodes_fts)').all() as Array<{ name: string }>;
      expect(nodeFtsColumns.map((column) => column.name)).not.toContain('content');
      const chunkColumns = conn.getDb().prepare('PRAGMA table_info(source_chunks)').all() as Array<{ name: string }>;
      expect(chunkColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'symbol_kind',
        'source_hash',
        'code_token_text',
        'metadata',
        'diagnostics',
      ]));
      const chunkFtsColumns = conn.getDb().prepare('PRAGMA table_info(source_chunks_fts)').all() as Array<{ name: string }>;
      expect(chunkFtsColumns.map((column) => column.name)).toContain('code_token_text');
    } finally {
      conn.close();
    }
  });

  it('migrates an existing DB to source chunk schema', () => {
    // Given: a DB whose schema version predates chunk storage.
    const dbPath = path.join(createTempDir('chunk-schema-migrate-'), 'solidkg.db');
    const seeded = DatabaseConnection.initialize(dbPath);
    try {
      seeded.getDb().exec(`
        DROP TABLE IF EXISTS source_chunks_fts;
        DROP TABLE IF EXISTS source_chunks;
        DROP INDEX IF EXISTS idx_source_chunks_file_path;
        DROP INDEX IF EXISTS idx_source_chunks_node_id;
        DROP INDEX IF EXISTS idx_source_chunks_identity;
        DELETE FROM schema_versions WHERE version > 9;
        INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
        VALUES (9, strftime('%s', 'now') * 1000, 'v9-style fixture');
      `);
    } finally {
      seeded.close();
    }

    // When: the DB is opened through the migration path.
    const migrated = DatabaseConnection.open(dbPath);
    try {
      // Then: migration installs chunk storage and records the current version.
      expect(migrated.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expectChunkSchema(migrated.getDb());
    } finally {
      migrated.close();
    }
  });

  it('round-trips chunk rows with node and file linkage through typed QueryBuilder APIs', () => {
    // Given: a DB with canonical file and node rows.
    const dbPath = path.join(createTempDir('chunk-schema-roundtrip-'), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const queries = new QueryBuilder(conn.getDb());
      queries.upsertFile({
        path: 'src/example.ts',
        contentHash: 'sha256:file-one',
        language: 'typescript',
        size: 128,
        modifiedAt: 1_000,
        indexedAt: 1_000,
        nodeCount: 1,
      });
      queries.insertNode(makeNode('node-1'));

      // When: one body chunk is upserted and searched by body-only and code-token text.
      const chunk = makeChunk();
      queries.upsertSourceChunks([chunk]);
      const stored = queries.getSourceChunksByFile('src/example.ts');
      const hits = queries.searchSourceChunks('normalizeBody', { limit: 5 });
      const tokenHits = queries.searchSourceChunks('identifier', { limit: 5 });
      const diagnostics = queries.getSourceChunkDiagnostics();

      // Then: identity/linkage/token/metadata fields round-trip and the dedicated chunk FTS is populated.
      expect(stored).toEqual([chunk]);
      expect(hits).toHaveLength(1);
      expect(tokenHits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ chunk, score: expect.any(Number) });
      expect(diagnostics).toEqual({ chunkCount: 1, ftsRowCount: 1, orphanFtsRowCount: 0 });
    } finally {
      conn.close();
    }
  });

  it('replaces stale chunk content for the same chunk identity', () => {
    // Given: an existing chunk row for a canonical node.
    const dbPath = path.join(createTempDir('chunk-schema-update-'), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const queries = new QueryBuilder(conn.getDb());
      queries.upsertFile({
        path: 'src/example.ts',
        contentHash: 'sha256:file-one',
        language: 'typescript',
        size: 128,
        modifiedAt: 1_000,
        indexedAt: 1_000,
        nodeCount: 1,
      });
      queries.insertNode(makeNode('node-1'));
      queries.upsertSourceChunks([makeChunk()]);

      // When: the same identity is upserted with changed body text and hash.
      queries.upsertSourceChunks([
        makeChunk({
          contentHash: 'sha256:chunk-two',
          sourceHash: 'sha256:file-two',
          content: 'function parseRequest(input) { return hydratePayload(input.payload); }',
          codeTokenText: 'function identifier parseRequest identifier hydratePayload property payload',
          metadata: { producer: 'chunk-retrieval-test', replacement: true },
          diagnostics: [{ message: 'replacement token text stored', severity: 'info' }],
          updatedAt: 3_000,
        }),
      ]);

      // Then: stale FTS text is gone and the replacement is searchable.
      expect(queries.getSourceChunkDiagnostics()).toEqual({ chunkCount: 1, ftsRowCount: 1, orphanFtsRowCount: 0 });
      expect(queries.searchSourceChunks('normalizeBody', { limit: 5 })).toEqual([]);
      expect(queries.searchSourceChunks('hydratePayload', { limit: 5 })).toHaveLength(1);
      expect(queries.searchSourceChunks('replacement', { limit: 5 })).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('deletes chunks by file and removes dedicated FTS hits', () => {
    // Given: chunks for two files, including malformed path and FTS punctuation text.
    const dbPath = path.join(createTempDir('chunk-schema-delete-'), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const queries = new QueryBuilder(conn.getDb());
      const secondPath = 'src/weird path/[draft].ts';
      queries.upsertFile({
        path: 'src/example.ts',
        contentHash: 'sha256:file-one',
        language: 'typescript',
        size: 128,
        modifiedAt: 1_000,
        indexedAt: 1_000,
        nodeCount: 1,
      });
      queries.upsertFile({
        path: secondPath,
        contentHash: 'sha256:file-two',
        language: 'typescript',
        size: 256,
        modifiedAt: 1_000,
        indexedAt: 1_000,
        nodeCount: 1,
      });
      queries.insertNode(makeNode('node-1'));
      queries.insertNode(makeNode('node-2', secondPath));
      queries.upsertSourceChunks([
        makeChunk({ content: 'alpha::beta handles path [draft] payload', codeTokenText: 'alpha beta payload token' }),
        makeChunk({
          id: 'chunk:node-2:0:v1',
          nodeId: 'node-2',
          filePath: secondPath,
          contentHash: 'sha256:chunk-two',
          sourceHash: 'sha256:file-two',
          chunkOrdinal: 0,
          content: 'orphan probe should remain searchable after other file deletion',
          codeTokenText: 'orphan probe token remains searchable',
        }),
      ]);
      expect(ftsHitCount(conn.getDb(), 'payload')).toBe(1);
      expect(ftsHitCount(conn.getDb(), 'orphan')).toBe(1);

      // When: chunks are deleted by the first file path.
      const deleted = queries.deleteSourceChunksByFile('src/example.ts');

      // Then: base rows and FTS hits for that file are removed, while other files remain.
      expect(deleted).toBe(1);
      expect(queries.getSourceChunksByFile('src/example.ts')).toEqual([]);
      expect(ftsHitCount(conn.getDb(), 'payload')).toBe(0);
      expect(ftsHitCount(conn.getDb(), 'orphan')).toBe(1);
      expect(queries.getSourceChunkDiagnostics()).toEqual({ chunkCount: 1, ftsRowCount: 1, orphanFtsRowCount: 0 });
    } finally {
      conn.close();
    }
  });
});

describe('source chunk code tokenization', () => {
  it('tokenizes required code identifier forms while preserving original identifiers', () => {
    // Given: representative code identifiers from TypeScript, Python, Rust, and SDK call sites.
    const source = `
      const getUserProfileByAccountId = responses.create(parse_error_response);
      type HTTPServerConfig = { readonly base_url: string };
      stage_apply::run(config);
    `;

    // When: source text is tokenized for the chunk FTS projection.
    const tokens = tokenizeCodeForSearch(source);

    // Then: original identifiers and split lookup terms are both present.
    expect(tokens).toEqual(expect.arrayContaining([
      'getUserProfileByAccountId',
      'get',
      'user',
      'profile',
      'account',
      'id',
      'parse_error_response',
      'parse',
      'error',
      'response',
      'HTTPServerConfig',
      'http',
      'server',
      'config',
      'stage_apply::run',
      'stage_apply',
      'stage',
      'apply',
      'run',
      'responses.create',
      'responses',
      'create',
    ]));
  });

  it('tokenizes JSX names decorators generics comments strings kebab case and path identifiers', () => {
    // Given: code-like text whose useful terms live outside simple bare identifiers.
    const source = `
      // fetches user-profile from src/api/user-profile.ts
      @Controller('/api/user-profile')
      function renderList<TItem extends JSX.Element>() {
        return <UserProfile.Card data-testid="profile-card" />;
      }
    `;

    // When: source text is tokenized for body retrieval.
    const tokens = tokenizeCodeForSearch(source);

    // Then: separators common in source, comments, strings, JSX, decorators, generics, and paths create searchable terms.
    expect(tokens).toEqual(expect.arrayContaining([
      'user-profile',
      'user',
      'profile',
      'src/api/user-profile.ts',
      'src',
      'api',
      'ts',
      '@Controller',
      'Controller',
      'controller',
      'TItem',
      'item',
      'JSX.Element',
      'jsx',
      'element',
      'UserProfile.Card',
      'card',
      'data-testid',
      'testid',
      'profile-card',
    ]));
  });

  it('uses aligned token rules for stored chunk text and source chunk queries', () => {
    // Given: a source chunk with token text produced by the shared tokenizer.
    const dbPath = path.join(createTempDir('chunk-token-search-'), 'solidkg.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      const queries = new QueryBuilder(conn.getDb());
      queries.upsertFile({
        path: 'src/services/user-profile.ts',
        contentHash: 'sha256:file-token',
        language: 'typescript',
        size: 256,
        modifiedAt: 1_000,
        indexedAt: 1_000,
        nodeCount: 1,
      });
      queries.insertNode(makeNode('node-token', 'src/services/user-profile.ts'));
      const content = 'const getUserProfileByAccountId = responses.create(parse_error_response);';
      queries.upsertSourceChunks([
        makeChunk({
          id: 'chunk:node-token:0:v1',
          nodeId: 'node-token',
          filePath: 'src/services/user-profile.ts',
          contentHash: 'sha256:chunk-token',
          sourceHash: 'sha256:file-token',
          content,
          codeTokenText: buildSourceChunkCodeTokenText(content),
        }),
      ]);

      // When: split terms are searched through the public QueryBuilder API.
      const profileHits = queries.searchSourceChunks('profile', { limit: 5 });
      const sdkHits = queries.searchSourceChunks('responses.create', { limit: 5 });
      const malformedHits = queries.searchSourceChunks('AND OR NEAR "*', { limit: 5 });

      // Then: split-token recall works, exact dotted terms still resolve, and malformed FTS operator input is harmless.
      expect(profileHits.map((hit) => hit.chunk.id)).toEqual(['chunk:node-token:0:v1']);
      expect(sdkHits.map((hit) => hit.chunk.id)).toEqual(['chunk:node-token:0:v1']);
      expect(malformedHits).toEqual([]);
      expect(buildSourceChunkFtsQuery('AND OR NEAR "*')).toBe('');
    } finally {
      conn.close();
    }
  });
});

describe('source chunk index sync lifecycle', () => {
  it('creates source chunks from extracted node body ranges during initial index', async () => {
    // Given: a project whose useful retrieval terms only appear inside a function body.
    const projectRoot = createTempDir('chunk-index-initial-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'service.ts'), `
      export function loadInvoiceWorkflow() {
        const reconciliationNeedle = 'body-only initial term';
        return reconciliationNeedle.toUpperCase();
      }
    `);

    // When: the public SolidKG API performs the first full index.
    const graph = SolidKG.initSync(projectRoot);
    try {
      await graph.indexAll();

      // Then: a source chunk exists for the extracted function body and is searchable by body/token text.
      const bodyHits = graph.searchSourceChunks('reconciliationNeedle', { limit: 5 });
      const splitHits = graph.searchSourceChunks('reconciliation needle', { limit: 5 });
      const chunks = graph.getSourceChunksByFile('src/service.ts');
      expect(bodyHits.map((hit) => hit.chunk.filePath)).toContain('src/service.ts');
      expect(splitHits.map((hit) => hit.chunk.filePath)).toContain('src/service.ts');
      expect(chunks.some((chunk) => chunk.content.includes('loadInvoiceWorkflow'))).toBe(true);
      expect(graph.getSourceChunkDiagnostics()).toEqual({ chunkCount: chunks.length, ftsRowCount: chunks.length, orphanFtsRowCount: 0 });
    } finally {
      graph.close();
    }
  });

  it('batches 129 source chunk writes and reports committed storing/source_chunks progress before SCIP', async () => {
    // Given: more source files than one source-chunk transaction batch, each with one searchable function body.
    const projectRoot = createTempDir('chunk-index-batched-progress-');
    const sourceDir = path.join(projectRoot, 'src');
    const fileCount = 129;
    fs.mkdirSync(sourceDir);
    for (let fileNumber = 1; fileNumber <= fileCount; fileNumber++) {
      const suffix = String(fileNumber).padStart(3, '0');
      fs.writeFileSync(
        path.join(sourceDir, `batch-${suffix}.ts`),
        `export function batchSourceChunkNeedle${suffix}(): string { return 'batchSourceChunkNeedle${suffix}'; }\n`,
      );
    }

    const committedSourceChunkBatchSizes: number[] = [];
    const originalUpsertSourceChunks = QueryBuilder.prototype.upsertSourceChunks;
    QueryBuilder.prototype.upsertSourceChunks = function observeCommittedSourceChunkBatch(chunks) {
      originalUpsertSourceChunks.call(this, chunks);
      committedSourceChunkBatchSizes.push(chunks.length);
    };
    const graph = SolidKG.initSync(projectRoot);
    try {
      const sourceProjectionProgress = {
        phase: 'storing',
        detail: 'source_chunks',
        current: 0,
        total: fileCount,
      } satisfies IndexProgress;
      const progressEvents: IndexProgress[] = [];
      const sourceChunkProgressAfterCommittedBatches: Array<{
        readonly current: number;
        readonly total: number;
        readonly committedBatchCount: number;
      }> = [];

      // When: the public index operation persists source chunks and reaches its SCIP boundary.
      const result = await graph.indexAll({
        onProgress: (progress) => {
          progressEvents.push(progress);
          if (
            progress.phase === sourceProjectionProgress.phase
            && progress.detail === sourceProjectionProgress.detail
            && progress.current > 0
          ) {
            sourceChunkProgressAfterCommittedBatches.push({
              current: progress.current,
              total: progress.total,
              committedBatchCount: committedSourceChunkBatchSizes.length,
            });
          }
        },
      });
      const sourceChunkProgressIndex = progressEvents.findIndex((event) => (
        event.phase === sourceProjectionProgress.phase
        && event.detail === sourceProjectionProgress.detail
      ));
      const scipProgressIndex = progressEvents.findIndex((event) => event.phase === 'scip');

      // Then: batches commit at 128 files, storage detail follows committed batches before SCIP, and chunk FTS stays intact.
      expect.soft(result.success).toBe(true);
      expect.soft(committedSourceChunkBatchSizes).toHaveLength(2);
      expect.soft(committedSourceChunkBatchSizes.every((batchSize) => batchSize > 0)).toBe(true);
      expect.soft(sourceChunkProgressAfterCommittedBatches.map((event) => event.current)).toEqual([128, fileCount]);
      expect.soft(sourceChunkProgressAfterCommittedBatches.map((event) => event.total)).toEqual([fileCount, fileCount]);
      expect.soft(sourceChunkProgressAfterCommittedBatches.map((event) => event.committedBatchCount)).toEqual([1, 2]);
      expect.soft(sourceChunkProgressIndex).toBeGreaterThanOrEqual(0);
      if (sourceChunkProgressIndex >= 0) {
        expect.soft(scipProgressIndex).toBeGreaterThan(sourceChunkProgressIndex);
      }
      expect.soft(
        graph.searchSourceChunks('batchSourceChunkNeedle129', { limit: 5 }).map((hit) => hit.chunk.filePath),
      ).toContain('src/batch-129.ts');
      const diagnostics = graph.getSourceChunkDiagnostics();
      expect.soft(diagnostics.chunkCount).toBeGreaterThanOrEqual(fileCount);
      expect.soft(diagnostics.ftsRowCount).toBe(diagnostics.chunkCount);
      expect.soft(diagnostics.orphanFtsRowCount).toBe(0);
    } finally {
      graph.close();
      QueryBuilder.prototype.upsertSourceChunks = originalUpsertSourceChunks;
    }
  }, 30_000);

  it('replaces changed-file chunks during sync so old body and code-token terms disappear', async () => {
    // Given: an indexed project with a body-only term in one function.
    const projectRoot = createTempDir('chunk-index-sync-change-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    const sourcePath = path.join(projectRoot, 'src', 'service.ts');
    fs.writeFileSync(sourcePath, `
      export function computeLedgerStatus() {
        const obsoleteZebraToken = 'before-sync-only';
        return obsoleteZebraToken;
      }
    `);
    const graph = SolidKG.initSync(projectRoot);
    try {
      await graph.indexAll();
      expect(graph.searchSourceChunks('obsolete zebra token', { limit: 5 }).length).toBeGreaterThan(0);

      // When: the function body changes and sync re-indexes the file.
      fs.writeFileSync(sourcePath, `
        export function computeLedgerStatus() {
          const freshQuasarSignal = 'after-sync-only';
          return freshQuasarSignal;
        }
      `);
      const syncResult = await graph.sync();

      // Then: stale chunk FTS rows are gone and replacement body/code-token terms are present.
      expect(syncResult.filesModified).toBe(1);
      expect(graph.searchSourceChunks('obsolete zebra token', { limit: 5 })).toEqual([]);
      expect(graph.searchSourceChunks('freshQuasarSignal', { limit: 5 }).length).toBeGreaterThan(0);
      expect(graph.searchSourceChunks('fresh quasar signal', { limit: 5 }).length).toBeGreaterThan(0);
      expect(graph.getSourceChunkDiagnostics().orphanFtsRowCount).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('replaces changed-file chunks during targeted indexFiles so old body and code-token terms disappear', async () => {
    // Given: an indexed project with a body-only term in one function.
    const projectRoot = createTempDir('chunk-index-targeted-change-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    const sourcePath = path.join(projectRoot, 'src', 'service.ts');
    fs.writeFileSync(sourcePath, `
      export function computeTargetedLedgerStatus() {
        const staleMagentaToken = 'before-targeted-index-only';
        return staleMagentaToken;
      }
    `);
    const graph = SolidKG.initSync(projectRoot);
    try {
      await graph.indexAll();
      expect(graph.searchSourceChunks('stale magenta token', { limit: 5 }).length).toBeGreaterThan(0);

      // When: the function body changes and the public targeted indexing API re-indexes the file.
      fs.writeFileSync(sourcePath, `
        export function computeTargetedLedgerStatus() {
          const freshIndigoSignal = 'after-targeted-index-only';
          return freshIndigoSignal;
        }
      `);
      const indexResult = await graph.indexFiles(['src/service.ts']);

      // Then: stale chunk FTS rows are gone and replacement body/code-token terms are present.
      expect(indexResult.filesIndexed).toBe(1);
      expect(graph.searchSourceChunks('stale magenta token', { limit: 5 })).toEqual([]);
      expect(graph.searchSourceChunks('freshIndigoSignal', { limit: 5 }).length).toBeGreaterThan(0);
      expect(graph.searchSourceChunks('fresh indigo signal', { limit: 5 }).length).toBeGreaterThan(0);
      expect(graph.getSourceChunkDiagnostics().orphanFtsRowCount).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('removes deleted-file chunks during sync so stale FTS hits disappear', async () => {
    // Given: an indexed file whose body terms are present only in source chunks.
    const projectRoot = createTempDir('chunk-index-sync-delete-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    const sourcePath = path.join(projectRoot, 'src', 'service.ts');
    fs.writeFileSync(sourcePath, `
      export function removeQueueWorker() {
        const deletionOnlyNeedle = 'delete-sync-only';
        return deletionOnlyNeedle;
      }
    `);
    const graph = SolidKG.initSync(projectRoot);
    try {
      await graph.indexAll();
      expect(graph.searchSourceChunks('deletionOnlyNeedle', { limit: 5 }).length).toBeGreaterThan(0);

      // When: the source file is deleted and sync reconciles the index.
      fs.unlinkSync(sourcePath);
      const syncResult = await graph.sync();

      // Then: chunk rows and dedicated FTS rows for that file are removed.
      expect(syncResult.filesRemoved).toBe(1);
      expect(graph.getSourceChunksByFile('src/service.ts')).toEqual([]);
      expect(graph.searchSourceChunks('deletionOnlyNeedle', { limit: 5 })).toEqual([]);
      expect(graph.getSourceChunkDiagnostics()).toEqual({ chunkCount: 0, ftsRowCount: 0, orphanFtsRowCount: 0 });
    } finally {
      graph.close();
    }
  });
});

describe('chunk-body fusion search', () => {
  it('fusion returns an owning node for a body-only behavioral query', () => {
    // Given: metadata-only symbol search has no terms for the requested behavior.
    const { conn, queries } = setupFusionFixture();
    try {
      // When: searchNodes receives a behavior query whose useful terms live in chunk bodies.
      const results = queries.searchNodes('reconcile line items against payment gateway receipts', { limit: 5 });

      // Then: the source chunk hit is fused into the owning node result with explainable evidence.
      expect(results[0]?.node.id).toBe('node-body');
      expect(reasonKinds(results[0])).toEqual(expect.arrayContaining([
        'source_body_chunk',
        'fusion',
      ]));
    } finally {
      conn.close();
    }
  });

  it('fusion keeps exact symbol and path intent ahead of body-only incidental matches', () => {
    // Given: an exact symbol/path target also has body terms that appear in another function body.
    const { conn, queries } = setupFusionFixture();
    try {
      // When: the query includes explicit symbol and path intent.
      const results = queries.searchNodes('CheckoutController path:controllers/checkout-controller.ts reconcile payment gateway', { limit: 5 });

      // Then: exact metadata intent outranks incidental body-only matches and records both evidence sources.
      expect(results[0]?.node.id).toBe('node-exact');
      expect(reasonKinds(results[0])).toEqual(expect.arrayContaining([
        'node_metadata',
        'source_body_chunk',
        'exact_symbol',
        'exact_path',
        'fusion',
      ]));
    } finally {
      conn.close();
    }
  });

  it('fusion demotes generated and test body matches unless explicitly queried', () => {
    // Given: production, generated, and test chunks all match the same body-only terms.
    const { conn, queries } = setupFusionFixture();
    try {
      // When: the query does not ask for generated or test files.
      const defaultResults = queries.searchNodes('reconcile line items payment gateway receipts', { limit: 10 });

      // Then: production code ranks before generated/test fixtures and the dampening is explainable.
      expect(defaultResults.findIndex((result) => result.node.id === 'node-body')).toBeLessThan(
        defaultResults.findIndex((result) => result.node.id === 'node-generated')
      );
      expect(defaultResults.findIndex((result) => result.node.id === 'node-body')).toBeLessThan(
        defaultResults.findIndex((result) => result.node.id === 'node-test')
      );
      const generatedResult = defaultResults.find((result) => result.node.id === 'node-generated');
      expect(generatedResult ? reasonKinds(generatedResult) : []).toContain('generated_or_test_dampening');

      // When: generated intent is explicit.
      const generatedResults = queries.searchNodes('generated reconcile line items payment gateway receipts', { limit: 10 });

      // Then: the generated file is no longer hidden behind production-only dampening.
      expect(generatedResults[0]?.node.id).toBe('node-generated');
    } finally {
      conn.close();
    }
  });

  it('chunk evidence labels are included in solidkg_search output for body-only matches', async () => {
    // Given: a public API project whose useful query terms appear only in a function body.
    const projectRoot = createTempDir('chunk-evidence-search-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'shipping.ts'), `
      export function operateShipment(): string {
        const manifest = 'carrier manifest quarantine reconciliation';
        const escalation = 'warehouse exception routing';
        return manifest + escalation;
      }
    `);
    const graph = SolidKG.initSync(projectRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await graph.indexAll();
      const handler = new ToolHandler(graph);

      // When: solidkg_search receives a natural-language behavior query.
      const result = await handler.execute('solidkg_search', {
        query: 'carrier manifest quarantine routing',
        limit: 3,
      });
      const text = result.content[0]?.text ?? '';

      // Then: the owning symbol is returned with visible source-body evidence labels.
      expect(text).toContain('operateShipment');
      expect(text).toContain('Ranking evidence:');
      expect(text).toContain('source_body_chunk');
      expect(text).toContain('fusion');
      expect(text).toContain('Search guidance:');
      expect(text).toContain('Next: solidkg_context');
    } finally {
      graph.close();
    }
  });

  it('solidkg_search gives compact agent guidance for ambiguous mixed-surface names', async () => {
    // Given: one symbol name appears in backend, UI, and test surfaces.
    const projectRoot = createTempDir('search-guidance-');
    fs.mkdirSync(path.join(projectRoot, 'airflow-core', 'src', 'airflow', 'models'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'airflow-core', 'src', 'airflow', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'airflow-core', 'tests', 'unit'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'airflow-core', 'src', 'airflow', 'models', 'taskinstance.py'), 'class TaskInstance:\n    pass\n');
    fs.writeFileSync(path.join(projectRoot, 'airflow-core', 'src', 'airflow', 'ui', 'TaskInstance.tsx'), 'export function TaskInstance() { return null; }\n');
    fs.writeFileSync(path.join(projectRoot, 'airflow-core', 'tests', 'unit', 'test_taskinstance.py'), 'class TaskInstance:\n    pass\n');
    const graph = SolidKG.initSync(projectRoot, { config: { include: ['**/*.py', '**/*.tsx'], exclude: [] } });
    try {
      await graph.indexAll();
      const handler = new ToolHandler(graph);

      // When: an agent starts with the ambiguous symbol name.
      const result = await handler.execute('solidkg_search', {
        query: 'TaskInstance',
        limit: 10,
      });
      const text = result.content[0]?.text ?? '';

      // Then: the output stays compact but routes the agent to narrowing filters and follow-up tools.
      expect(text).toContain('Search guidance:');
      expect(text).toContain('Ambiguous name');
      expect(text).toContain('Use filters: lang:');
      expect(text).toContain('path:');
      expect(text).toContain('kind:');
      expect(text).toContain('Test/generated results were demoted');
      expect(text).toContain('Next: solidkg_context');
      expect(text).toContain('solidkg_explore');
      expect(text).toContain('solidkg_node');
      expect(text).not.toContain('solidkg_precise_refs nodeId=');
    } finally {
      graph.close();
    }
  });
});

describe('disabled hybrid retrieval seam', () => {
  it('disabled hybrid public API searches with no retrieval config or token', async () => {
    // Given: a project initialized through the public API with no retrieval options.
    const projectRoot = createTempDir('disabled-hybrid-public-api-');
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'service.ts'), `
      export function settleInvoice() {
        return 'reconcile line items against payment gateway receipts';
      }
    `);
    const graph = SolidKG.initSync(projectRoot);

    try {
      await graph.indexAll();

      // When: a body-only query runs through the public search surface.
      const results = graph.searchNodes('reconcile line items against payment gateway receipts', { limit: 5 });

      // Then: deterministic local fusion works and hybrid extensions remain disabled by default.
      expect(results[0]?.node.name).toBe('settleInvoice');
      expect(graph.getRetrievalExtensionStatus()).toEqual({
        mode: 'disabled',
        activeChannels: [],
        skippedChannels: [],
        bounds: { maxCandidates: 50, timeoutMs: 75, maxPayloadBytes: 32_768 },
        diagnostics: [],
      });
    } finally {
      graph.close();
    }
  });

  it('disabled hybrid defaults do not require config or instantiate optional providers while preserving fusion results', () => {
    // Given: a default query builder and the same fixture with an optional future dense channel factory.
    const baseline = setupFusionFixture();
    const withDisabledChannel = setupFusionFixture();
    let providerInstantiationCount = 0;
    const retrieval: RetrievalExtensionConfig = {
      hybrid: {
        mode: 'disabled',
        maxCandidates: 25,
        timeoutMs: 50,
        maxPayloadBytes: 16_384,
        candidateChannels: [{
          kind: 'dense',
          create: () => {
            providerInstantiationCount += 1;
            return {
              kind: 'dense',
              searchCandidates: () => [{ nodeId: 'node-generated', score: 9_999 }],
            };
          },
        }],
      },
    };

    try {
      const disabledQueries = new QueryBuilder(withDisabledChannel.conn.getDb(), { retrieval });

      // When: both builders execute the existing body-fusion query.
      const baselineResults = baseline.queries.searchNodes('reconcile line items against payment gateway receipts', { limit: 5 });
      const disabledResults = disabledQueries.searchNodes('reconcile line items against payment gateway receipts', { limit: 5 });

      // Then: default/offline behavior is unchanged and the optional provider factory is never instantiated.
      expect(disabledQueries.getRetrievalExtensionStatus()).toMatchObject({
        mode: 'disabled',
        activeChannels: [],
        skippedChannels: ['dense'],
        bounds: { maxCandidates: 25, timeoutMs: 50, maxPayloadBytes: 16_384 },
      });
      expect(providerInstantiationCount).toBe(0);
      expect(disabledResults.map((result) => ({
        id: result.node.id,
        score: result.score,
        reasons: reasonKinds(result),
      }))).toEqual(baselineResults.map((result) => ({
        id: result.node.id,
        score: result.score,
        reasons: reasonKinds(result),
      })));
    } finally {
      baseline.conn.close();
      withDisabledChannel.conn.close();
    }
  });

  it('disabled hybrid handles unsupported optional provider config as bounded disabled diagnostics without crashing search', () => {
    // Given: a future external channel config that this build must not enable.
    const { conn, queries } = setupFusionFixture();
    const retrieval: RetrievalExtensionConfig = {
      hybrid: {
        mode: 'external',
        maxCandidates: 25,
        timeoutMs: 50,
        maxPayloadBytes: 16_384,
        candidateChannels: [{
          kind: 'reranker',
          create: () => {
            throw new Error('provider must stay uninstantiated while hybrid retrieval is disabled');
          },
        }],
      },
    };

    try {
      const disabledQueries = new QueryBuilder(conn.getDb(), { retrieval });

      // When: search runs through the fusion path with unsupported optional config present.
      const results = disabledQueries.searchNodes('CheckoutController path:controllers/checkout-controller.ts reconcile payment gateway', { limit: 5 });

      // Then: the existing deterministic fusion result survives and unsupported config is reported, not executed.
      expect(results[0]?.node.id).toBe('node-exact');
      expect(reasonKinds(results[0])).toEqual(expect.arrayContaining(['node_metadata', 'source_body_chunk', 'fusion']));
      expect(disabledQueries.getRetrievalExtensionStatus()).toMatchObject({
        mode: 'disabled',
        activeChannels: [],
        skippedChannels: ['reranker'],
        diagnostics: expect.arrayContaining([{
          severity: 'error',
          code: 'hybrid_retrieval.unsupported_mode',
          message: expect.any(String),
        }]),
      });
      expect(queries.searchNodes('CheckoutController path:controllers/checkout-controller.ts reconcile payment gateway', { limit: 5 })[0]?.node.id).toBe('node-exact');
    } finally {
      conn.close();
    }
  });
});
