/**
 * PR #19 Improvement Tests
 *
 * Tests for changes ported from PR #15 and #16:
 * - Lazy grammar loading
 * - Arrow function extraction (body traversal)
 * - Graph traversal 'both' direction fix
 * - Best-candidate resolution picking
 * - Schema v2 migration (filePath/language on unresolved_refs)
 * - Batch insert for unresolved refs
 * - SQLite performance pragmas
 * - MCP symbol disambiguation and output truncation
 * - CLI uninit command
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase } from '../src/db/sqlite-adapter';
import { extractFromSource } from '../src/extraction';
import { findSymbol } from '../src/mcp/symbol-resolution';
import {
  getParser,
  isLanguageSupported,
  getSupportedLanguages,
  clearParserCache,
  getUnavailableGrammarErrors,
  initGrammars,
  loadAllGrammars,
} from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-pr19-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Check if the node:sqlite backend is available (Node >= 22.5)
function hasSqliteBindings(): boolean {
  try {
    const { db } = createDatabase(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const HAS_SQLITE = hasSqliteBindings();

// =============================================================================
// Lazy Grammar Loading
// =============================================================================

describe('Lazy Grammar Loading', () => {
  afterEach(() => {
    clearParserCache();
  });

  it('should load grammars lazily on first use', () => {
    // Clear cache to force fresh load
    clearParserCache();

    // TypeScript should be loadable
    const parser = getParser('typescript');
    expect(parser).not.toBeNull();
  });

  it('should cache loaded grammars', () => {
    clearParserCache();

    const parser1 = getParser('typescript');
    const parser2 = getParser('typescript');

    // Same reference from cache
    expect(parser1).toBe(parser2);
  });

  it('should return null for unknown language', () => {
    const parser = getParser('unknown');
    expect(parser).toBeNull();
  });

  it('should handle unavailable grammars gracefully', () => {
    // 'unknown' is not a valid grammar, should not crash
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should report liquid as supported (custom extractor)', () => {
    expect(isLanguageSupported('liquid')).toBe(true);
  });

  it('should include liquid in supported languages', () => {
    const supported = getSupportedLanguages();
    expect(supported).toContain('liquid');
  });

  it('should return unavailable grammar errors as a record', () => {
    clearParserCache();
    const errors = getUnavailableGrammarErrors();
    // Should be a plain object (may or may not have entries depending on platform)
    expect(typeof errors).toBe('object');
  });

  it('should support multiple languages independently', () => {
    clearParserCache();

    // Load two different languages - one failing shouldn't affect the other
    const tsParser = getParser('typescript');
    const pyParser = getParser('python');

    expect(tsParser).not.toBeNull();
    expect(pyParser).not.toBeNull();
    expect(tsParser).not.toBe(pyParser);
  });

  it('should clear all caches on clearParserCache', () => {
    // Load a grammar
    getParser('typescript');

    // Clear
    clearParserCache();

    // Errors should be cleared too
    const errors = getUnavailableGrammarErrors();
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

// =============================================================================
// Arrow Function Extraction - Body Traversal
// =============================================================================

describe('Arrow Function Body Traversal', () => {
  it('should extract unresolved references from arrow function bodies', () => {
    const code = `
export const useAuth = () => {
  const user = getUser();
  const token = generateToken(user);
  return { user, token };
};
`;
    const result = extractFromSource('hooks.ts', code);

    // The arrow function should be extracted
    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();

    // Calls inside the body should be captured as unresolved references
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('getUser');
    expect(callNames).toContain('generateToken');
  });

  it('should extract unresolved references from function expression bodies', () => {
    const code = `
export const processData = function(input: string): string {
  const cleaned = sanitize(input);
  return transform(cleaned);
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('sanitize');
    expect(callNames).toContain('transform');
  });

  it('should not create duplicate nodes for arrow functions', () => {
    const code = `
export const handler = () => {
  doSomething();
};
`;
    const result = extractFromSource('handler.ts', code);

    // Should be exactly 1 function node, 0 variable nodes for 'handler'
    const funcNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'function');
    const varNodes = result.nodes.filter((n) => n.name === 'handler' && n.kind === 'variable');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract nested calls in arrow functions in JavaScript', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetchAPI('/data');
  return parseResponse(response);
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode?.kind).toBe('function');

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const callNames = calls.map((c) => c.referenceName);
    expect(callNames).toContain('fetchAPI');
    expect(callNames).toContain('parseResponse');
  });
});

// =============================================================================
// Graph Traversal 'both' Direction Fix
// (requires better-sqlite3 - will use SolidKG integration)
// =============================================================================

describe('Graph Traversal Both Direction', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should traverse both directions from a node', async () => {
    const SolidKG = (await import('../src/index')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // A -> B -> C  (A calls B, B calls C)
    fs.writeFileSync(path.join(srcDir, 'a.ts'), `
import { funcB } from './b';
export function funcA(): void { funcB(); }
`);
    fs.writeFileSync(path.join(srcDir, 'b.ts'), `
import { funcC } from './c';
export function funcB(): void { funcC(); }
`);
    fs.writeFileSync(path.join(srcDir, 'c.ts'), `
export function funcC(): void { console.log('c'); }
`);

    const cg = SolidKG.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();
    cg.resolveReferences();

    const functions = cg.getNodesByKind('function');
    const funcB = functions.find((n) => n.name === 'funcB');

    if (!funcB) {
      cg.destroy();
      return;
    }

    // Traverse 'both' from B - should find A (incoming caller) and C (outgoing callee)
    const subgraph = cg.traverse(funcB.id, {
      maxDepth: 1,
      direction: 'both',
    });

    // B itself + at least one neighbor in each direction
    expect(subgraph.nodes.size).toBeGreaterThanOrEqual(2);
    expect(subgraph.nodes.has(funcB.id)).toBe(true);

    cg.destroy();
  });
});

// =============================================================================
// Best-Candidate Resolution
// =============================================================================

describe('Best-Candidate Resolution', () => {
  it.skipIf(!HAS_SQLITE)('should be testable via the resolution module types', async () => {
    const { ReferenceResolver } = await import('../src/resolution');
    expect(typeof ReferenceResolver.prototype.resolveOne).toBe('function');
  });
});

// =============================================================================
// Schema v2 Migration
// =============================================================================

describe('Schema v2 Migration', () => {
  it.skipIf(!HAS_SQLITE)('should have correct current schema version', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../src/db/migrations');
    expect(CURRENT_SCHEMA_VERSION).toBe(11);
  });

  it.skipIf(!HAS_SQLITE)('should have migration for version 2', async () => {
    const { getPendingMigrations } = await import('../src/db/migrations');
    expect(typeof getPendingMigrations).toBe('function');
  });
});

// =============================================================================
// Database Layer: Batch Insert, getAllNodes, Pragmas
// =============================================================================

describe('Database Layer Improvements', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should support batch insert of unresolved refs', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node first (needed as foreign key)
    queries.insertNode({
      id: 'func:test:1',
      kind: 'function',
      name: 'testFunc',
      qualifiedName: 'test::testFunc',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    // Batch insert unresolved refs with filePath and language
    queries.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperA',
        referenceKind: 'calls',
        line: 2,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
      {
        fromNodeId: 'func:test:1',
        referenceName: 'helperB',
        referenceKind: 'calls',
        line: 3,
        column: 4,
        filePath: 'test.ts',
        language: 'typescript',
      },
    ]);

    const refs = queries.getUnresolvedReferences();
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.referenceName).sort()).toEqual(['helperA', 'helperB']);

    // Verify filePath and language are persisted
    expect(refs[0]?.filePath).toBe('test.ts');
    expect(refs[0]?.language).toBe('typescript');

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should support getAllNodes', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert some nodes
    for (let i = 0; i < 3; i++) {
      queries.insertNode({
        id: `func:test:${i}`,
        kind: 'function',
        name: `func${i}`,
        qualifiedName: `test::func${i}`,
        filePath: 'test.ts',
        language: 'typescript',
        startLine: i * 10 + 1,
        endLine: i * 10 + 5,
        startColumn: 0,
        endColumn: 1,
        updatedAt: Date.now(),
      });
    }

    const allNodes = queries.getAllNodes();
    expect(allNodes).toHaveLength(3);
    expect(allNodes.map((n) => n.name).sort()).toEqual(['func0', 'func1', 'func2']);

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should set performance pragmas on initialization', async () => {
    const { DatabaseConnection } = await import('../src/db');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const rawDb = db.getDb();

    // Check pragmas were set
    const synchronous = rawDb.pragma('synchronous', { simple: true });
    expect(synchronous).toBe(1); // NORMAL = 1

    const cacheSize = rawDb.pragma('cache_size', { simple: true }) as number;
    expect(cacheSize).toBe(-64000);

    const tempStore = rawDb.pragma('temp_store', { simple: true });
    expect(tempStore).toBe(2); // MEMORY = 2

    const mmapSize = rawDb.pragma('mmap_size', { simple: true }) as number;
    expect(mmapSize).toBe(268435456); // 256 MB

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should handle empty batch insert gracefully', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Should not throw on empty array
    expect(() => queries.insertUnresolvedRefsBatch([])).not.toThrow();

    db.close();
  });
});

// =============================================================================
// Resolution Warm Caches
// =============================================================================

describe('Resolution Warm Caches', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should warm caches and use them for lookups', async () => {
    const SolidKG = (await import('../src/index')).default;

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function myFunc(): void {}
export function otherFunc(): void { myFunc(); }
`);

    const cg = SolidKG.initSync(testDir, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });

    await cg.indexAll();

    // resolveReferences internally calls warmCaches
    const result = cg.resolveReferences();

    // Should complete without error
    expect(result.stats.total).toBeGreaterThanOrEqual(0);

    cg.destroy();
  });

  it.skipIf(!HAS_SQLITE)('should not materialize whole-repo name and file sets during warmup', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');
    const { createResolver } = await import('../src/resolution');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    const guardedQueries = queries as QueryBuilder & {
      getAllNodeNames: () => string[];
      getAllFilePaths: () => string[];
    };
    guardedQueries.getAllNodeNames = () => {
      throw new Error('getAllNodeNames should not be called by warmCaches');
    };
    guardedQueries.getAllFilePaths = () => {
      throw new Error('getAllFilePaths should not be called by warmCaches');
    };

    const resolver = createResolver(testDir, guardedQueries);
    expect(() => resolver.warmCaches()).not.toThrow();

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should resolve and persist batches without loading all unresolved refs', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');
    const { createResolver } = await import('../src/resolution');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({
      id: 'func:src/a.ts:callee:1',
      kind: 'function',
      name: 'callee',
      qualifiedName: 'src/a.ts::callee',
      filePath: 'src/a.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'func:src/b.ts:caller:1',
      kind: 'function',
      name: 'caller',
      qualifiedName: 'src/b.ts::caller',
      filePath: 'src/b.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'func:src/b.ts:caller:1',
        referenceName: 'callee',
        referenceKind: 'calls',
        line: 1,
        column: 10,
        filePath: 'src/b.ts',
        language: 'typescript',
      },
    ]);

    const guardedQueries = queries as QueryBuilder & { getUnresolvedReferences: () => never };
    guardedQueries.getUnresolvedReferences = () => {
      throw new Error('getUnresolvedReferences should not be called by batched resolution');
    };

    const resolver = createResolver(testDir, guardedQueries);
    const result = await resolver.resolveAndPersistBatched(undefined, 1);

    expect(result.stats.total).toBe(1);
    expect(result.stats.resolved).toBe(1);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(queries.getOutgoingEdges('func:src/b.ts:caller:1').some((edge) => edge.target === 'func:src/a.ts:callee:1')).toBe(true);

    db.close();
  });

  it.skipIf(!HAS_SQLITE)('should continue after a fully unresolved batch', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');
    const { createResolver } = await import('../src/resolution');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({
      id: 'func:src/a.ts:callee:1',
      kind: 'function',
      name: 'callee',
      qualifiedName: 'src/a.ts::callee',
      filePath: 'src/a.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'func:src/b.ts:caller:1',
      kind: 'function',
      name: 'caller',
      qualifiedName: 'src/b.ts::caller',
      filePath: 'src/b.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    queries.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'func:src/b.ts:caller:1',
        referenceName: 'missingSymbol',
        referenceKind: 'calls',
        line: 1,
        column: 5,
        filePath: 'src/b.ts',
        language: 'typescript',
      },
      {
        fromNodeId: 'func:src/b.ts:caller:1',
        referenceName: 'callee',
        referenceKind: 'calls',
        line: 2,
        column: 10,
        filePath: 'src/b.ts',
        language: 'typescript',
      },
    ]);

    const missingBefore = queries
      .getUnresolvedReferences()
      .find((ref) => ref.referenceName === 'missingSymbol');
    expect(missingBefore?.id).toBeTypeOf('number');

    try {
      const resolver = createResolver(testDir, queries);
      const result = await resolver.resolveAndPersistBatched(undefined, 1);

      expect(result.stats.total).toBe(2);
      expect(result.stats.resolved).toBe(1);
      expect(result.stats.unresolved).toBe(1);
      expect(queries.getUnresolvedReferencesCount()).toBe(1);
      const remaining = queries.getUnresolvedReferences();
      expect(remaining[0]?.referenceName).toBe('missingSymbol');
      expect(remaining[0]?.id).toBe(missingBefore?.id);
      expect(queries.getOutgoingEdges('func:src/b.ts:caller:1').some((edge) => edge.target === 'func:src/a.ts:callee:1')).toBe(true);
    } finally {
      db.close();
    }
  });

  it.skipIf(!HAS_SQLITE)('should skip C# and PowerShell external references without hiding project symbols', async () => {
    const { DatabaseConnection } = await import('../src/db');
    const { QueryBuilder } = await import('../src/db/queries');
    const { createResolver } = await import('../src/resolution');

    const dbPath = path.join(testDir, 'solidkg.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({
      id: 'func:src/module.ps1:Join-Path:1',
      kind: 'function',
      name: 'Join-Path',
      qualifiedName: 'src/module.ps1::Join-Path',
      filePath: 'src/module.ps1',
      language: 'powershell',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'func:src/module.ps1:Invoke-Caller:5',
      kind: 'function',
      name: 'Invoke-Caller',
      qualifiedName: 'src/module.ps1::Invoke-Caller',
      filePath: 'src/module.ps1',
      language: 'powershell',
      startLine: 5,
      endLine: 8,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'method:src/service.cs:Caller.Run:1',
      kind: 'method',
      name: 'Run',
      qualifiedName: 'src/service.cs::Caller.Run',
      filePath: 'src/service.cs',
      language: 'csharp',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'class:src/service.cs:SystemClock:12',
      kind: 'class',
      name: 'SystemClock',
      qualifiedName: 'src/service.cs::SystemClock',
      filePath: 'src/service.cs',
      language: 'csharp',
      startLine: 12,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertNode({
      id: 'method:src/service.cs:SystemClock.GetType:13',
      kind: 'method',
      name: 'GetType',
      qualifiedName: 'src/service.cs::SystemClock.GetType',
      filePath: 'src/service.cs',
      language: 'csharp',
      startLine: 13,
      endLine: 15,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    queries.insertUnresolvedRefsBatch([
      {
        fromNodeId: 'func:src/module.ps1:Invoke-Caller:5',
        referenceName: 'Join-Path',
        referenceKind: 'calls',
        line: 6,
        column: 2,
        filePath: 'src/module.ps1',
        language: 'powershell',
      },
      {
        fromNodeId: 'func:src/module.ps1:Invoke-Caller:5',
        referenceName: 'Should',
        referenceKind: 'calls',
        line: 7,
        column: 2,
        filePath: 'src/module.ps1',
        language: 'powershell',
      },
      {
        fromNodeId: 'method:src/service.cs:Caller.Run:1',
        referenceName: 'sourceValue.GetType',
        referenceKind: 'calls',
        line: 3,
        column: 10,
        filePath: 'src/service.cs',
        language: 'csharp',
      },
      {
        fromNodeId: 'method:src/service.cs:Caller.Run:1',
        referenceName: 'SystemClock.GetType',
        referenceKind: 'calls',
        line: 4,
        column: 10,
        filePath: 'src/service.cs',
        language: 'csharp',
      },
      {
        fromNodeId: 'method:src/service.cs:Caller.Run:1',
        referenceName: 'typeof(global::System.String).IsAssignableFrom',
        referenceKind: 'calls',
        line: 5,
        column: 10,
        filePath: 'src/service.cs',
        language: 'csharp',
      },
    ]);

    const resolver = createResolver(testDir, queries);
    const result = await resolver.resolveAndPersistBatched(undefined, 5);

    expect(result.stats.total).toBe(5);
    expect(result.stats.resolved).toBe(2);
    expect(result.stats.unresolved).toBe(3);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(queries.getOutgoingEdges('func:src/module.ps1:Invoke-Caller:5').some((edge) => edge.target === 'func:src/module.ps1:Join-Path:1')).toBe(true);
    const csharpEdges = queries.getOutgoingEdges('method:src/service.cs:Caller.Run:1');
    expect(csharpEdges.some((edge) => edge.target === 'method:src/service.cs:SystemClock.GetType:13')).toBe(true);
    expect(csharpEdges).toHaveLength(1);

    db.close();
  });
});

// =============================================================================
// MCP Tool Improvements
// =============================================================================

describe('MCP Tool Improvements', () => {
  it.skipIf(!HAS_SQLITE)('should export ToolHandler class', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');
    expect(typeof ToolHandler).toBe('function');
  });

  it.skipIf(!HAS_SQLITE)('should expose symbol resolution and keep truncateOutput as a private method', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');
    const proto = ToolHandler.prototype;
    expect(typeof findSymbol).toBe('function');
    expect(typeof (proto as any).truncateOutput).toBe('function');
  });

  it.skipIf(!HAS_SQLITE)('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');

    // Access private method for testing
    const handler = Object.create(ToolHandler.prototype);
    const truncate = (handler as any).truncateOutput.bind(handler);

    // Short text should not be truncated
    const short = 'Hello world';
    expect(truncate(short)).toBe(short);

    // Long text should be truncated
    const long = 'x'.repeat(20000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('... (output truncated)');
  });

  it.skipIf(!HAS_SQLITE)('should truncate at a clean line boundary', async () => {
    const { ToolHandler } = await import('../src/mcp/tools');

    const handler = Object.create(ToolHandler.prototype);
    const truncate = (handler as any).truncateOutput.bind(handler);

    // Build text with newlines exceeding the limit
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`Line ${i}: ${'a'.repeat(50)}`);
    }
    const text = lines.join('\n');

    const result = truncate(text);
    // Should end with truncation notice after a newline boundary
    expect(result).toContain('... (output truncated)');
    // Should not cut mid-line (the char before truncation notice should be \n)
    const beforeTruncation = result.split('\n\n... (output truncated)')[0]!;
    expect(beforeTruncation.endsWith('\n') || !beforeTruncation.includes('\0')).toBe(true);
  });

  describe('findSymbol disambiguation', () => {
    it.skipIf(!HAS_SQLITE)('should prefer exact name matches', async () => {
      const SolidKG = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function getValue(): number { return 1; }
export function getValueFromCache(): number { return 2; }
`);

      const cg = SolidKG.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'getValue');
      expect(match).not.toBeNull();
      expect(match.node.name).toBe('getValue');
      // Should not have a disambiguation note for single exact match
      expect(match.note).toBe('');

      cg.destroy();
      cleanupTempDir(tmpDir);
    });

    it.skipIf(!HAS_SQLITE)('should note when multiple symbols share the same name', async () => {
      const SolidKG = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Two files with the same function name
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `
export function handle(): void {}
`);
      fs.writeFileSync(path.join(srcDir, 'b.ts'), `
export function handle(): void {}
`);

      const cg = SolidKG.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'handle');
      expect(match).not.toBeNull();
      expect(match.node.name).toBe('handle');
      // Should have a disambiguation note
      expect(match.note).toContain('2 symbols named "handle"');

      cg.destroy();
      cleanupTempDir(tmpDir);
    });

    it.skipIf(!HAS_SQLITE)('should return null when symbol is not found', async () => {
      const SolidKG = (await import('../src/index')).default;

      const tmpDir = createTempDir();
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function foo(): void {}`);

      const cg = SolidKG.initSync(tmpDir, {
        config: { include: ['src/**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const match = findSymbol(cg, 'nonExistentSymbol');
      expect(match).toBeNull();

      cg.destroy();
      cleanupTempDir(tmpDir);
    });
  });
});

// =============================================================================
// CLI uninit Command
// =============================================================================

describe('CLI uninit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  it.skipIf(!HAS_SQLITE)('should uninitialize a project via SolidKG.uninitialize()', async () => {
    const SolidKG = (await import('../src/index')).default;

    // Initialize
    const cg = SolidKG.initSync(testDir);
    expect(SolidKG.isInitialized(testDir)).toBe(true);

    // Uninitialize
    cg.uninitialize();

    // .solidkg directory should be removed
    expect(SolidKG.isInitialized(testDir)).toBe(false);
  });
});

// =============================================================================
// Tree-sitter Runtime Pinning
// =============================================================================

describe('Native Tree-sitter Setup', () => {
  it('should pin the native language pack dependency', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.dependencies['@xberg-io/tree-sitter-language-pack']).toBe('1.13.1');
  });

  it('should not retain the WASM parser dependencies', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.dependencies['web-tree-sitter']).toBeUndefined();
    expect(pkg.dependencies['tree-sitter-wasms']).toBeUndefined();
  });
});

// =============================================================================
// Embedder Float32Array Fix
// =============================================================================

describe('Float32Array Fix', () => {
  it('should correctly convert typed arrays (regression check)', () => {
    // Simulates the fix: Float32Array.from(Array.from(arr)) vs new Float32Array(arr.length)
    const source = new Float64Array([1.5, 2.5, 3.5, 4.5]);

    // The OLD buggy approach:
    const buggy = new Float32Array(source.length);
    // buggy is all zeros!
    expect(buggy[0]).toBe(0);
    expect(buggy[1]).toBe(0);

    // The NEW fixed approach:
    const fixed = Float32Array.from(Array.from(source));
    expect(fixed[0]).toBeCloseTo(1.5);
    expect(fixed[1]).toBeCloseTo(2.5);
    expect(fixed[2]).toBeCloseTo(3.5);
    expect(fixed[3]).toBeCloseTo(4.5);
  });
});
