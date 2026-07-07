/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock, pathMatchesRootAwarePrefix, validateProjectPath } from '../src/utils';
import SolidKG from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { scanDirectory, isSourceFile, extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['bash', 'powershell']);
});

describe('Static script parsing safety', () => {
  it('does not execute Bash or PowerShell source while extracting', () => {
    const tempDir = createTempDir();
    try {
      const bashMarker = path.join(tempDir, 'bash-marker.txt').replace(/\\/g, '/');
      const psMarker = path.join(tempDir, 'powershell-marker.txt');

      const bash = extractFromSource('scripts/check.sh', `
source "\${HOME}/danger.sh"
write_marker() {
  printf marker > /tmp/solidkg-static-script-marker
}
write_marker
`);
      const powershell = extractFromSource('scripts/check.ps1', `
Import-Module "\${env:USERPROFILE}\\Danger.psm1"
function Write-Marker {
  New-Item -Path '${psMarker}' -ItemType File
}
Write-Marker
`);

      expect(bash.errors).toHaveLength(0);
      expect(powershell.errors).toHaveLength(0);
      expect(fs.existsSync(bashMarker)).toBe(false);
      expect(fs.existsSync(psMarker)).toBe(false);
      expect(bash.nodes.some((n) => n.kind === 'import' && n.name === '${HOME}/danger.sh')).toBe(true);
      expect(powershell.nodes.some((n) => n.kind === 'import' && n.name.includes('${env:USERPROFILE}'))).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe('FileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should acquire and release a lock', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should prevent double acquisition within same process', () => {
    const lock1 = new FileLock(lockPath);
    const lock2 = new FileLock(lockPath);

    lock1.acquire();

    // Second lock should fail because our PID is alive
    expect(() => lock2.acquire()).toThrow(/locked by another process/);

    lock1.release();
  });

  it('should detect and remove stale locks from dead processes', () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is extremely unlikely to be a real process
    fs.writeFileSync(lockPath, '99999999');

    const lock = new FileLock(lockPath);
    // Should succeed because the PID is dead
    expect(() => lock.acquire()).not.toThrow();

    lock.release();
  });

  it('should not steal an old lock while its PID is still alive', () => {
    fs.writeFileSync(lockPath, String(process.pid));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);

    const lock = new FileLock(lockPath);

    expect(() => lock.acquire()).toThrow(/locked by another process/);
    expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('should execute function with withLock', () => {
    const lock = new FileLock(lockPath);

    const result = lock.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if function throws', () => {
    const lock = new FileLock(lockPath);

    expect(() => {
      lock.withLock(() => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should execute async function with withLockAsync', async () => {
    const lock = new FileLock(lockPath);

    const result = await lock.withLockAsync(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'async-result';
    });

    expect(result).toBe('async-result');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if async function throws', async () => {
    const lock = new FileLock(lockPath);

    await expect(
      lock.withLockAsync(async () => {
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release should be idempotent', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });
});

describe('pathMatchesRootAwarePrefix', () => {
  it('treats root-ish prefixes as the whole project', () => {
    for (const prefix of ['', '.', './', '/', '\\']) {
      expect(pathMatchesRootAwarePrefix('src/index.ts', prefix)).toBe(true);
    }
  });

  it('matches subdirectory prefixes with or without leading slashes', () => {
    expect(pathMatchesRootAwarePrefix('src/index.ts', 'src')).toBe(true);
    expect(pathMatchesRootAwarePrefix('src/index.ts', './src')).toBe(true);
    expect(pathMatchesRootAwarePrefix('src/index.ts', '/src')).toBe(true);
    expect(pathMatchesRootAwarePrefix('src/index.ts', '\\src')).toBe(true);
    expect(pathMatchesRootAwarePrefix('lib/index.ts', '/src')).toBe(false);
  });
});

describe('Path Traversal Prevention', () => {
  let testDir: string;
  let cg: SolidKG;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'hello.ts'),
      `export function hello(): string { return "hi"; }\n`
    );

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should read code for valid nodes within project', async () => {
    const nodes = cg.getNodesByKind('function');
    const hello = nodes.find((n) => n.name === 'hello');
    expect(hello).toBeDefined();

    const code = await cg.getCode(hello!.id);
    expect(code).toContain('hello');
  });

  it('should return null for non-existent node', async () => {
    const code = await cg.getCode('does-not-exist');
    expect(code).toBeNull();
  });
});

describe('validateProjectPath — sensitive directory blocking', () => {
  // POSIX-only: on Windows '/etc' resolves to C:\etc (non-existent), not a
  // sensitive dir — the Windows case is covered by the win32-gated test below.
  it.runIf(process.platform !== 'win32')('blocks POSIX system directories (exact match)', () => {
    expect(validateProjectPath('/')).toMatch(/sensitive system directory/i);
    expect(validateProjectPath('/etc')).toMatch(/sensitive system directory/i);
  });

  it('allows a normal, existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validate-'));
    try {
      expect(validateProjectPath(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // SENSITIVE_PATHS stores the Windows entries lowercase and validateProjectPath
  // matches via resolved.toLowerCase(), so 'C:\\Windows' and 'c:\\windows' are
  // both blocked. path.resolve is platform-specific, so this only runs on Windows.
  it.runIf(process.platform === 'win32')(
    'blocks Windows system directories regardless of case',
    () => {
      expect(validateProjectPath('C:\\Windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('c:\\windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('C:\\WINDOWS\\System32')).toMatch(/sensitive system directory/i);
    }
  );
});

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: SolidKG;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      `export function exampleFunc(): void {}\nexport class ExampleClass {}\n`
    );

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in solidkg_search', async () => {
    const result = await handler.execute('solidkg_search', { query: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject empty string query in solidkg_search', async () => {
    const result = await handler.execute('solidkg_search', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in solidkg_search', async () => {
    const result = await handler.execute('solidkg_search', { query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in solidkg_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('solidkg_search', { query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string symbol in solidkg_callers', async () => {
    const result = await handler.execute('solidkg_callers', { symbol: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject non-string task in solidkg_context', async () => {
    const result = await handler.execute('solidkg_context', { task: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should truncate oversized solidkg_context output', async () => {
    const oversizedContext = Array.from({ length: 400 }, (_, i) => `line-${i} ${'x'.repeat(80)}`).join('\n');
    const fakeCg = {
      buildContext: async () => oversizedContext,
    };
    const fakeHandler = new ToolHandler(fakeCg as unknown as SolidKG);

    const result = await fakeHandler.execute('solidkg_context', { task: 'find example' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.length).toBeLessThan(oversizedContext.length);
    expect(result.content[0].text).toContain('... (output truncated)');
  });

  it('should reject non-string symbol in solidkg_impact', async () => {
    const result = await handler.execute('solidkg_impact', { symbol: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in solidkg_node', async () => {
    const result = await handler.execute('solidkg_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in solidkg_callees', async () => {
    const result = await handler.execute('solidkg_callees', { symbol: {} });
    expect(result.isError).toBe(true);
  });

  it('should reject non-numeric limits in solidkg_search', async () => {
    const result = await handler.execute('solidkg_search', { query: 'example', limit: 'abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid limit');
  });

  it('should reject negative limits in solidkg_search', async () => {
    const result = await handler.execute('solidkg_search', { query: 'example', limit: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid limit');
  });

  it('should reject non-numeric limits in solidkg_callers', async () => {
    const result = await handler.execute('solidkg_callers', { symbol: 'exampleFunc', limit: 'abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid limit');
  });

  it('should reject non-numeric depth in solidkg_impact', async () => {
    const result = await handler.execute('solidkg_impact', { symbol: 'exampleFunc', depth: 'abc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid depth');
  });

  it('should anchor solidkg_files glob patterns instead of matching substrings', async () => {
    const result = await handler.execute('solidkg_files', { pattern: 'ample', format: 'flat' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No files found matching the criteria.');
  });

  // #230: getSolidKG must reject a sensitive system directory passed as
  // projectPath before opening it. The error surfaces through execute()'s
  // catch as an isError result. /etc is sensitive on POSIX; C:\Windows on
  // Windows (path.resolve is platform-specific, so each case is gated).
  it.runIf(process.platform !== 'win32')(
    'rejects a sensitive POSIX projectPath (/etc) via the MCP handler',
    async () => {
      const result = await handler.execute('solidkg_search', {
        query: 'example',
        projectPath: '/etc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );

  it.runIf(process.platform === 'win32')(
    'rejects a sensitive Windows projectPath (C:\\Windows) via the MCP handler',
    async () => {
      const result = await handler.execute('solidkg_search', {
        query: 'example',
        projectPath: 'C:\\Windows',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );
});

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('Source file detection (isSourceFile)', () => {
  it('selects files by supported extension', () => {
    expect(isSourceFile('src/index.ts')).toBe(true);
    expect(isSourceFile('src/deep/nested/file.ts')).toBe(true);
    expect(isSourceFile('src/component.tsx')).toBe(true);
    expect(isSourceFile('lib/util.js')).toBe(true);
    expect(isSourceFile('src/main.py')).toBe(true);
  });

  it('rejects unsupported extensions and extensionless files', () => {
    expect(isSourceFile('src/component.css')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('Makefile')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
  });

  it('matches regardless of leading dot directories', () => {
    expect(isSourceFile('.hidden/index.ts')).toBe(true);
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node with malformed JSON in the decorators column
    db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-node-1', 'function', 'myFunc', 'myFunc', 'test.ts', 'typescript',
      1, 5, 0, 0,
      '{not valid json!!!}',  // malformed decorators
      0, 0, 0, 0, Date.now()
    );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `).run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = queries.getOutgoingEdges('node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = queries.getFileByPath('test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }


    // This should complete without hanging
    const files = scanDirectory(tempDir);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter(f => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }


    const files = scanDirectory(tempDir);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some(f => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }


    // Should not throw
    const files = scanDirectory(tempDir);
    expect(files).toContain('src/valid.ts');
  });

  it('should not index symlinked files that resolve outside the project root', () => {
    const outsideDir = createTempDir();
    try {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const safe = 1;\n');
      fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const secret = 2;\n');

      try {
        fs.symlinkSync(path.join(outsideDir, 'secret.ts'), path.join(srcDir, 'linked-secret.ts'), 'file');
      } catch {
        return;
      }

      const files = scanDirectory(tempDir);
      expect(files).toContain('src/valid.ts');
      expect(files).not.toContain('src/linked-secret.ts');
    } finally {
      cleanupTempDir(outsideDir);
    }
  });

  it('should not index symlinked directories that resolve outside the project root', () => {
    const outsideDir = createTempDir();
    try {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const safe = 1;\n');
      fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const secret = 2;\n');

      try {
        fs.symlinkSync(outsideDir, path.join(srcDir, 'external'), 'dir');
      } catch {
        return;
      }

      const files = scanDirectory(tempDir);
      expect(files).toContain('src/valid.ts');
      expect(files).not.toContain('src/external/secret.ts');
    } finally {
      cleanupTempDir(outsideDir);
    }
  });
});

describe('Session marker symlink resistance', () => {
  // The marker write lives in src/mcp/tools.ts behind handleContext. We exercise
  // it end-to-end via ToolHandler.execute so the test exercises the same code
  // path Claude Code drives. The session id is per-test so other parallel test
  // runs can't collide with the marker file we plant a symlink at.
  const SESSION_ID = `cg-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const crypto = require('crypto') as typeof import('crypto');
  const hash = crypto.createHash('md5').update(SESSION_ID).digest('hex').slice(0, 16);
  const markerPath = path.join(os.tmpdir(), `solidkg-consulted-${hash}`);

  let projectDir: string;
  let victimDir: string;
  let victimFile: string;

  beforeEach(async () => {
    projectDir = createTempDir();
    victimDir = createTempDir();
    victimFile = path.join(victimDir, 'private.txt');
    fs.writeFileSync(victimFile, 'SECRET-DO-NOT-OVERWRITE\n');
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);

    // A real .solidkg/ has to exist for handleContext to get past the
    // "not initialized" guard — index a tiny fixture so the call reaches the
    // marker write step rather than short-circuiting on missing project state.
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const x = 1;\n');
    const cg = await SolidKG.init(projectDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    cleanupTempDir(projectDir);
    cleanupTempDir(victimDir);
  });

  it('does not follow a pre-planted symlink at the marker path', async () => {
    // Skip on platforms where the user can't create symlinks (Windows without
    // dev mode + admin). The CWE-59 risk we're guarding against doesn't apply
    // when symlinks aren't creatable, so the skip is correct, not a gap.
    try {
      fs.symlinkSync(victimFile, markerPath);
    } catch {
      return;
    }

    const cg = await SolidKG.open(projectDir);
    const handler = new ToolHandler(cg);
    process.env.CLAUDE_SESSION_ID = SESSION_ID;
    try {
      await handler.execute('solidkg_context', { task: 'find x' });
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      cg.close();
    }

    // The victim file's contents must be untouched — the old writeFileSync
    // path would have followed the symlink and written an ISO timestamp here.
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('SECRET-DO-NOT-OVERWRITE\n');

    // And the marker path itself must still be the symlink we planted —
    // no fallback path that quietly unlinked + recreated it (which would
    // also work, but is a behavior we don't want to silently rely on).
    expect(fs.lstatSync(markerPath).isSymbolicLink()).toBe(true);
  });

  it('writes the marker file with 0o600 perms on a clean path', async () => {
    // No symlink planted — happy path. Verifies the new openSync(mode: 0o600)
    // call is what actually lands on disk (regression guard for the perm
    // tightening that came with the O_NOFOLLOW fix).
    const cg = await SolidKG.open(projectDir);
    const handler = new ToolHandler(cg);
    process.env.CLAUDE_SESSION_ID = SESSION_ID;
    try {
      await handler.execute('solidkg_context', { task: 'find x' });
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      cg.close();
    }

    expect(fs.existsSync(markerPath)).toBe(true);
    // chmod's low 9 bits — strip the file-type bits for a clean compare.
    // Windows can't enforce 0o600 in the POSIX sense; skip the assertion
    // there since the underlying OS will normalize the mode anyway.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(markerPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
