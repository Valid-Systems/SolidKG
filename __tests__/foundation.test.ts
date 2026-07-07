/**
 * Foundation Tests
 *
 * Tests for the SolidKG foundation layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { SolidKG } from '../src';
import { Node, Edge } from '../src/types';
import { isInitialized, getSolidKGDir, validateDirectory } from '../src/directory';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { ToolHandler } from '../src/mcp/tools';

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('SolidKG Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Initialization', () => {
    it('should initialize a new project', () => {
      const cg = SolidKG.initSync(tempDir);

      expect(SolidKG.isInitialized(tempDir)).toBe(true);
      expect(fs.existsSync(getSolidKGDir(tempDir))).toBe(true);
      expect(fs.existsSync(getDatabasePath(tempDir))).toBe(true);

      cg.close();
    });

    it('should create .gitignore in .SolidKG directory', () => {
      const cg = SolidKG.initSync(tempDir);

      const gitignorePath = path.join(getSolidKGDir(tempDir), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*');

      cg.close();
    });

    it('should initialize and open using an external data directory', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-data-'));
      try {
        fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export function hello() { return 1; }\n');

        const cg = await SolidKG.init(tempDir, { dataDir, index: true });
        expect(SolidKG.isInitialized(tempDir, { dataDir })).toBe(true);
        expect(SolidKG.isInitialized(tempDir)).toBe(false);
        expect(fs.existsSync(getSolidKGDir(tempDir))).toBe(false);
        expect(fs.existsSync(getDatabasePath(tempDir, { dataDir }))).toBe(true);
        expect(cg.getDataDir()).toBe(path.resolve(dataDir));
        expect(cg.getStats().fileCount).toBe(1);
        cg.close();

        const reopened = SolidKG.openSync(tempDir, { dataDir });
        expect(reopened.searchNodes('hello').length).toBeGreaterThan(0);
        fs.writeFileSync(path.join(tempDir, 'extra.ts'), 'export function extra() { return hello(); }\n');
        const sync = await reopened.sync();
        expect(sync.filesAdded).toBeGreaterThanOrEqual(1);
        reopened.close();
      } finally {
        cleanupTempDir(dataDir);
      }
    });

    it('should keep same relative paths distinct across extra roots', async () => {
      const rootA = path.join(tempDir, 'app-a');
      const rootB = path.join(tempDir, 'app-b');
      fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
      fs.mkdirSync(path.join(rootB, 'src'), { recursive: true });
      fs.writeFileSync(path.join(rootA, 'src', 'index.ts'), 'export function sameName() { return "a"; }\n');
      fs.writeFileSync(path.join(rootB, 'src', 'index.ts'), 'export function sameName() { return "b"; }\n');

      const cg = await SolidKG.init(rootA, { index: true, extraRoots: [rootB] });
      try {
        const files = cg.getFiles().map((file) => file.path).sort();
        expect(files).toContain('@app-a/src/index.ts');
        expect(files).toContain('@app-b/src/index.ts');
        const matches = cg.searchNodes('sameName', { limit: 10 }).map((result) => result.node.filePath).sort();
        expect(matches).toContain('@app-a/src/index.ts');
        expect(matches).toContain('@app-b/src/index.ts');
        expect(new Set(matches).size).toBeGreaterThanOrEqual(2);

        const handler = new ToolHandler(cg);
        const filesResult = await handler.execute('solidkg_files', { format: 'flat' });
        const filesText = filesResult.content[0]!.text;
        expect(filesText).toContain('@app-a/src/index.ts');
        expect(filesText).toContain('@app-b/src/index.ts');
      } finally {
        cg.close();
      }
    });

    it('should explain missing external data directories', () => {
      const dataDir = path.join(tempDir, 'missing-data');
      expect(() => SolidKG.openSync(tempDir, { dataDir })).toThrow(/data directory/i);
      expect(() => SolidKG.openSync(tempDir, { dataDir })).toThrow(new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('should ignore generated .solidkg contents and daemon runtime files', () => {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });

      const cg = SolidKG.initSync(tempDir);
      const solidkgDir = getSolidKGDir(tempDir);
      fs.writeFileSync(path.join(solidkgDir, 'daemon.pid'), String(process.pid));

      const status = execFileSync('git', ['status', '--short', '--', '.solidkg'], {
        cwd: tempDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      expect(status).toBe('');
      cg.close();
    });

    it('should throw if already initialized', () => {
      const cg = SolidKG.initSync(tempDir);
      cg.close();

      expect(() => SolidKG.initSync(tempDir)).toThrow(/already initialized/i);
    });
  });

  describe('Opening Projects', () => {
    it('should open an existing project', () => {
      // First initialize
      const cg1 = SolidKG.initSync(tempDir);
      cg1.close();

      // Then open
      const cg2 = SolidKG.openSync(tempDir);
      expect(cg2.getProjectRoot()).toBe(path.resolve(tempDir));
      cg2.close();
    });

    it('should throw if not initialized', () => {
      expect(() => SolidKG.openSync(tempDir)).toThrow(/not initialized/i);
    });

    it('opens in read-only mode without mutating metadata and rejects writes', async () => {
      const cg = SolidKG.initSync(tempDir, { extraRoots: [] });
      cg.close();

      const dbPath = getDatabasePath(tempDir);
      const gitignorePath = path.join(getSolidKGDir(tempDir), '.gitignore');
      fs.rmSync(gitignorePath, { force: true });
      const before = fs.statSync(dbPath).mtimeMs;
      const readonly = SolidKG.openSync(tempDir, { readOnly: true });
      try {
        expect(() => readonly.clear()).toThrow(/read-only/i);
        expect(() => readonly.optimize()).toThrow(/read-only/i);
        expect(() => readonly.resolveReferences()).toThrow(/read-only/i);
        await expect(readonly.resolveReferencesBatched()).rejects.toThrow(/read-only/i);
        await expect(readonly.importScipIndexes([])).rejects.toThrow(/read-only/i);
        await expect(readonly.generateScipIndexes()).rejects.toThrow(/read-only/i);
        await expect(readonly.createSnapshot('readonly')).rejects.toThrow(/read-only/i);
        await expect(readonly.deleteSnapshot('readonly')).rejects.toThrow(/read-only/i);
        expect(() => readonly.analyzeArchitecture()).toThrow(/read-only/i);
        expect(() => readonly.getArchitecture()).toThrow(/read-only/i);
        expect(() => readonly.watch()).toThrow(/read-only/i);
      } finally {
        readonly.close();
      }
      expect(fs.statSync(dbPath).mtimeMs).toBe(before);
      expect(fs.existsSync(gitignorePath)).toBe(false);
    });

    it('migrates legacy external data directories after a valid database opens', () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-legacy-data-'));
      const siblingFile = path.join(dataDir, 'user-owned.txt');
      const markerPath = path.join(dataDir, '.solidkg-owned');
      fs.writeFileSync(siblingFile, 'keep me');

      try {
        const cg = SolidKG.initSync(tempDir, { dataDir });
        cg.close();
        fs.rmSync(markerPath, { force: true });
        expect(fs.existsSync(markerPath)).toBe(false);

        const reopened = SolidKG.openSync(tempDir, { dataDir });
        reopened.close();

        expect(fs.existsSync(markerPath)).toBe(true);
        const cleanup = SolidKG.openSync(tempDir, { dataDir });
        cleanup.uninitialize();
        expect(fs.existsSync(siblingFile)).toBe(true);
        expect(fs.existsSync(getDatabasePath(tempDir, { dataDir }))).toBe(false);
      } finally {
        cleanupTempDir(dataDir);
      }
    });
  });

  describe('Static Methods', () => {
    it('isInitialized should return false for new directory', () => {
      expect(SolidKG.isInitialized(tempDir)).toBe(false);
    });

    it('isInitialized should return true after init', () => {
      const cg = SolidKG.initSync(tempDir);
      expect(SolidKG.isInitialized(tempDir)).toBe(true);
      cg.close();
    });
  });

  describe('Database', () => {
    it('should create database with correct schema', () => {
      const cg = SolidKG.initSync(tempDir);

      // Check that we can get stats (requires tables to exist)
      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.fileCount).toBe(0);

      cg.close();
    });

    it('should return correct database size', () => {
      const cg = SolidKG.initSync(tempDir);
      const stats = cg.getStats();

      // Database should have some size (at least the schema)
      expect(stats.dbSizeBytes).toBeGreaterThan(0);

      cg.close();
    });

    it('should support optimize operation', () => {
      const cg = SolidKG.initSync(tempDir);

      // Should not throw
      expect(() => cg.optimize()).not.toThrow();

      cg.close();
    });

    it('should support clear operation', () => {
      const cg = SolidKG.initSync(tempDir);

      // Should not throw
      expect(() => cg.clear()).not.toThrow();

      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);

      cg.close();
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = SolidKG.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Uninitialize', () => {
    it('should remove .SolidKG directory', () => {
      const cg = SolidKG.initSync(tempDir);

      cg.uninitialize();

      expect(fs.existsSync(getSolidKGDir(tempDir))).toBe(false);
      expect(SolidKG.isInitialized(tempDir)).toBe(false);
    });

    it('removes only SolidKG-owned files from an external data directory', () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-external-data-'));
      const siblingFile = path.join(dataDir, 'user-owned.txt');
      fs.writeFileSync(siblingFile, 'keep me');

      try {
        const cg = SolidKG.initSync(tempDir, { dataDir });

        cg.uninitialize();

        expect(fs.existsSync(siblingFile)).toBe(true);
        expect(fs.existsSync(getDatabasePath(tempDir, { dataDir }))).toBe(false);
        expect(SolidKG.isInitialized(tempDir, { dataDir })).toBe(false);
      } finally {
        cleanupTempDir(dataDir);
      }
    });

    it('refuses to remove an unowned external data directory', () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-unowned-data-'));
      const dbPath = getDatabasePath(tempDir, { dataDir });
      fs.writeFileSync(dbPath, 'not a real solidkg db');

      try {
        expect(() => SolidKG.openSync(tempDir, { dataDir })).toThrow();
        expect(fs.existsSync(dbPath)).toBe(true);
      } finally {
        cleanupTempDir(dataDir);
      }
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .SolidKG directory', () => {
      const cg = SolidKG.initSync(tempDir);

      cg.destroy(); // destroy is alias for close

      expect(fs.existsSync(getSolidKGDir(tempDir))).toBe(true);
      expect(SolidKG.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = SolidKG.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = SolidKG.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.traverse('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });

    it('treats SQL LIKE wildcard characters as literal search text', async () => {
      fs.writeFileSync(path.join(tempDir, 'sample.ts'), 'export function alphaLiteral(): void {}\n');
      const cg = SolidKG.initSync(tempDir, { config: { include: ['**/*.ts'], exclude: [] } });
      try {
        await cg.indexAll();

        expect(cg.searchNodes('__')).toEqual([]);
        expect(cg.searchNodes('%%')).toEqual([]);
      } finally {
        cg.close();
      }
    });

  });
});

describe('Database Connection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should initialize new database', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    expect(db.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    db.close();
  });

  it('should get schema version', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const version = db.getSchemaVersion();
    expect(version).not.toBeNull();
    expect(version?.version).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('keeps the schema header comment aligned with CURRENT_SCHEMA_VERSION', () => {
    const schemaPath = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    expect(schema).toContain(`-- Version ${CURRENT_SCHEMA_VERSION}`);
  });

  it('should support transactions', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const result = db.transaction(() => {
      return 42;
    });

    expect(result).toBe(42);

    db.close();
  });

  it('should throw when opening non-existent database', () => {
    const dbPath = path.join(tempDir, 'nonexistent.db');

    expect(() => DatabaseConnection.open(dbPath)).toThrow(/not found/i);
  });
});

describe('Query Builder', () => {
  let tempDir: string;
  let cg: SolidKG;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = SolidKG.initSync(tempDir);
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('should return null for non-existent node', () => {
    const node = cg.getNode('nonexistent');
    expect(node).toBeNull();
  });

  it('should return empty array for nodes in non-existent file', () => {
    const nodes = cg.getNodesInFile('nonexistent.ts');
    expect(nodes).toEqual([]);
  });

  it('should return empty array for edges from non-existent node', () => {
    const edges = cg.getOutgoingEdges('nonexistent');
    expect(edges).toEqual([]);
  });

  it('should return null for non-existent file', () => {
    const file = cg.getFile('nonexistent.ts');
    expect(file).toBeNull();
  });

  it('should return empty array for files when none tracked', () => {
    const files = cg.getFiles();
    expect(files).toEqual([]);
  });
});
