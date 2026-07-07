/**
 * node:sqlite backend (issue #238 follow-up).
 *
 * node:sqlite (Node's built-in real SQLite) is now the sole backend. This drives
 * a real index + queries through it, so WAL, FTS5 search, and @named-param
 * writes are all exercised end-to-end.
 *
 * Skipped on Node < 22.5 where node:sqlite doesn't exist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SolidKG from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';

let nodeSqliteAvailable = false;
try {
  const { db } = createDatabase(':memory:');
  db.close();
  nodeSqliteAvailable = true;
} catch {
  nodeSqliteAvailable = false;
}

describe.skipIf(!nodeSqliteAvailable)('node:sqlite backend — real index + queries', () => {
  let dir: string;
  let cg: SolidKG;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nodesqlite-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await SolidKG.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the node:sqlite backend', () => {
    expect(cg.getBackend()).toBe('node-sqlite');
  });

  it('runs in WAL mode — the whole reason it beats the wasm fallback', () => {
    expect(cg.getJournalMode()).toBe('wal');
  });

  it('indexed the project (write path: @named-param INSERTs via node:sqlite)', () => {
    const stats = cg.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('FTS5 search returns the indexed symbol (read path)', () => {
    const results = cg.searchNodes('helper');
    const names = results.map(r => r.node.name);
    expect(names).toContain('helper');
  });

  it('graph traversal resolves the cross-file caller', () => {
    const helper = cg.searchNodes('helper').find(r => r.node.name === 'helper');
    expect(helper).toBeTruthy();
    const callers = cg.getCallers(helper!.node.id);
    expect(callers.map(c => c.node.name)).toContain('main');
  });
});

describe.skipIf(!nodeSqliteAvailable)('node:sqlite transaction wrapper', () => {
  it('supports nested transactions without rolling back the outer transaction', () => {
    const { db } = createDatabase(':memory:');
    try {
      db.exec('CREATE TABLE items (name TEXT NOT NULL)');

      const outer = db.transaction(() => {
        db.prepare('INSERT INTO items (name) VALUES (?)').run('outer');
        const inner = db.transaction(() => {
          db.prepare('INSERT INTO items (name) VALUES (?)').run('inner');
          return 2;
        });

        expect(inner()).toBe(2);
        return 1;
      });

      expect(outer()).toBe(1);
      const rows = db.prepare('SELECT name FROM items ORDER BY rowid').all() as Array<{ name: string }>;
      expect(rows.map((row) => row.name)).toEqual(['outer', 'inner']);
    } finally {
      db.close();
    }
  });
});
