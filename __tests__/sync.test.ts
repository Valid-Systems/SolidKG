/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of solidkg's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';

describe('Sync Module', () => {
  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: SolidKG;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize and index
      cg = SolidKG.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function hello() { return 'modified'; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function goodbye() { return 'farewell'; }`
        );

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = cg.searchNodes('hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = cg.searchNodes('hello');
        expect(nodes.length).toBe(0);
      });

      it('should remove hyperedges touching deleted files', async () => {
        const queries = new QueryBuilderAccessor(cg).queries;
        const hello = cg.searchNodes('hello')[0]?.node;
        expect(hello).toBeTruthy();

        fs.writeFileSync(path.join(testDir, 'src', 'view.ts'), 'export function view() { return null; }\n');
        queries.upsertFile({
          path: 'src/view.ts',
          contentHash: 'hash:view',
          language: 'typescript',
          size: 100,
          modifiedAt: 1,
          indexedAt: 1,
          nodeCount: 1,
        });
        queries.insertNode({
          id: 'node:view',
          kind: 'function',
          name: 'view',
          qualifiedName: 'src/view.ts::view',
          filePath: 'src/view.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 1,
          updatedAt: 1,
        });
        queries.insertHyperedge({
          id: 'hyperedge:deleted-file',
          kind: 'ui_render',
          sourceFile: 'src/view.ts',
          line: 1,
          column: 0,
          provenance: 'heuristic',
          confidence: 1,
          metadata: { synthesizedBy: 'test' },
          createdAt: 1,
          updatedAt: 1,
        }, [
          { hyperedgeId: 'hyperedge:deleted-file', nodeId: hello!.id, role: 'state', ordinal: 0 },
          { hyperedgeId: 'hyperedge:deleted-file', nodeId: 'node:view', role: 'component', ordinal: 1 },
        ]);

        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);
        expect(queries.getHyperedgeById('hyperedge:deleted-file')).toBeNull();
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });

      it('should fail loudly when another process holds the sync lock', async () => {
        const lockPath = path.join(testDir, '.solidkg', 'solidkg.lock');
        fs.writeFileSync(lockPath, String(process.pid));

        await expect(cg.sync()).rejects.toThrow(/Could not acquire file lock/);

        expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
      });

      it('should resolve old unresolved references when a new file defines the target', async () => {
        const queries = new QueryBuilderAccessor(cg).queries;
        fs.writeFileSync(
          path.join(testDir, 'src', 'caller.ts'),
          `export function caller() { return missingTarget(); }`
        );
        await cg.sync();
        expect(queries.getUnresolvedReferencesCount()).toBe(1);

        fs.writeFileSync(
          path.join(testDir, 'src', 'target.ts'),
          `export function missingTarget() { return 1; }`
        );
        await cg.sync();

        const caller = cg.searchNodes('caller')[0]?.node;
        const target = cg.searchNodes('missingTarget')[0]?.node;
        expect(caller).toBeTruthy();
        expect(target).toBeTruthy();
        expect(queries.getOutgoingEdges(caller!.id).some((edge) => edge.target === target!.id)).toBe(true);
        expect(queries.getUnresolvedReferencesCount()).toBe(0);
      });

      it('should resolve old unresolved references when indexFiles adds the target', async () => {
        const queries = new QueryBuilderAccessor(cg).queries;
        fs.writeFileSync(
          path.join(testDir, 'src', 'direct-caller.ts'),
          `export function directCaller() { return directTarget(); }`
        );
        await cg.indexFiles(['src/direct-caller.ts']);
        expect(queries.getUnresolvedReferencesCount()).toBe(1);

        fs.writeFileSync(
          path.join(testDir, 'src', 'direct-target.ts'),
          `export function directTarget() { return 1; }`
        );
        await cg.indexFiles(['src/direct-target.ts']);

        const caller = cg.searchNodes('directCaller')[0]?.node;
        const target = cg.searchNodes('directTarget')[0]?.node;
        expect(caller).toBeTruthy();
        expect(target).toBeTruthy();
        expect(queries.getOutgoingEdges(caller!.id).filter((edge) => edge.target === target!.id)).toHaveLength(1);
        expect(queries.getUnresolvedReferencesCount()).toBe(0);
      });
    });
  });

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: SolidKG;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-git-sync-'));

      // Initialize a git repo with an initial commit
      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      // Initialize SolidKG and index
      cg = SolidKG.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should detect modified files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'modified'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = cg.searchNodes('newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should stop reporting untracked files once they are indexed (issue #206)', async () => {
      // Untracked files stay `??` in git status even after solidkg indexes
      // them. Change detection must compare them against the DB by hash, not
      // report every untracked file as "added" on every sync/status.
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      // First sync indexes the untracked file.
      const first = await cg.sync();
      expect(first.filesAdded).toBe(1);

      // The file is still untracked in git, but now lives in the DB.
      expect(cg.searchNodes('newFunc').length).toBeGreaterThan(0);

      // status must not keep flagging it as a pending addition...
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('src/new.ts');
      expect(changes.modified).not.toContain('src/new.ts');

      // ...and a second sync must be a no-op for it.
      const second = await cg.sync();
      expect(second.filesAdded).toBe(0);
      expect(second.filesModified).toBe(0);
    });

    it('should re-index an untracked file when its contents change', async () => {
      const filePath = path.join(testDir, 'src', 'new.ts');
      fs.writeFileSync(filePath, `export function newFunc() { return 42; }`);
      await cg.sync();

      // Modify the still-untracked file.
      fs.writeFileSync(filePath, `export function renamedFunc() { return 7; }`);

      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/new.ts');

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(cg.searchNodes('renamedFunc').length).toBeGreaterThan(0);
      expect(cg.searchNodes('newFunc').length).toBe(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = cg.searchNodes('hello');
      expect(nodes.length).toBe(0);
    });

    it('should skip files with unsupported extensions', async () => {
      // A .txt file has no supported grammar, so sync must not index it.
      fs.writeFileSync(
        path.join(testDir, 'src', 'notes.txt'),
        `just some notes`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });
  });
});

class QueryBuilderAccessor {
  readonly queries: QueryBuilder;

  constructor(cg: SolidKG) {
    const holder = cg as unknown as { queries: QueryBuilder };
    this.queries = holder.queries;
  }
}
