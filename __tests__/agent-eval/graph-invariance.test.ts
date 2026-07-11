import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import SolidKG from '../../src/index';
import { compareGraphFingerprints, fingerprintGraph } from '../../scripts/agent-eval/reference-quality/graph-invariance.mjs';

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}

describe('graph invariance diagnostics', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports no canonical graph differences when fresh indexing and sync reach the same source', async () => {
    const incrementalRoot = createRoot('solidkg-invariance-incremental-');
    const freshRoot = createRoot('solidkg-invariance-fresh-');
    const firstSource = 'export function caller() { return 1; }\n';
    const finalSource = 'export function target() { return 2; }\nexport function caller() { return target(); }\n';
    fs.writeFileSync(path.join(incrementalRoot, 'src', 'flow.ts'), firstSource);
    fs.writeFileSync(path.join(freshRoot, 'src', 'flow.ts'), finalSource);

    const incremental = SolidKG.initSync(incrementalRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    const fresh = SolidKG.initSync(freshRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await incremental.indexAll();
      fs.writeFileSync(path.join(incrementalRoot, 'src', 'flow.ts'), finalSource);
      await incremental.sync();
      await fresh.indexAll();

      const comparison = compareGraphFingerprints(
        fingerprintGraph(path.join(incrementalRoot, '.solidkg', 'solidkg.db')),
        fingerprintGraph(path.join(freshRoot, '.solidkg', 'solidkg.db')),
      );

      expect(comparison.equal).toBe(true);
      expect(comparison.changedRelations).toEqual([]);
    } finally {
      incremental.close();
      fresh.close();
    }
  });

  it('attributes a changed canonical relation instead of reducing the result to one hash', async () => {
    const leftRoot = createRoot('solidkg-invariance-left-');
    const rightRoot = createRoot('solidkg-invariance-right-');
    fs.writeFileSync(path.join(leftRoot, 'src', 'flow.ts'), 'export function target() { return 1; }\n');
    fs.writeFileSync(path.join(rightRoot, 'src', 'flow.ts'), 'export function other() { return 1; }\n');

    const left = SolidKG.initSync(leftRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    const right = SolidKG.initSync(rightRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await left.indexAll();
      await right.indexAll();

      const comparison = compareGraphFingerprints(
        fingerprintGraph(path.join(leftRoot, '.solidkg', 'solidkg.db')),
        fingerprintGraph(path.join(rightRoot, '.solidkg', 'solidkg.db')),
      );

      expect(comparison.equal).toBe(false);
      expect(comparison.changedRelations).toContain('nodes');
    } finally {
      left.close();
      right.close();
    }
  });

  it('treats JSON object key order as semantically equivalent', async () => {
    const leftRoot = createRoot('solidkg-invariance-json-left-');
    const rightRoot = createRoot('solidkg-invariance-json-right-');
    const source = 'export function target() { return 1; }\n';
    fs.writeFileSync(path.join(leftRoot, 'src', 'flow.ts'), source);
    fs.writeFileSync(path.join(rightRoot, 'src', 'flow.ts'), source);

    const left = SolidKG.initSync(leftRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    const right = SolidKG.initSync(rightRoot, { config: { include: ['**/*.ts'], exclude: [] } });
    let closed = false;
    try {
      await left.indexAll();
      await right.indexAll();
      left.close();
      right.close();
      closed = true;

      const leftPath = path.join(leftRoot, '.solidkg', 'solidkg.db');
      const rightPath = path.join(rightRoot, '.solidkg', 'solidkg.db');
      const leftDb = new DatabaseSync(leftPath);
      const rightDb = new DatabaseSync(rightPath);
      try {
        leftDb.prepare("UPDATE nodes SET decorators = ? WHERE kind = 'function'").run('[{"a":1,"b":2}]');
        rightDb.prepare("UPDATE nodes SET decorators = ? WHERE kind = 'function'").run('[{"b":2,"a":1}]');
      } finally {
        leftDb.close();
        rightDb.close();
      }

      expect(compareGraphFingerprints(fingerprintGraph(leftPath), fingerprintGraph(rightPath))).toMatchObject({
        equal: true,
        changedRelations: [],
      });
    } finally {
      if (!closed) {
        left.close();
        right.close();
      }
    }
  });
});
