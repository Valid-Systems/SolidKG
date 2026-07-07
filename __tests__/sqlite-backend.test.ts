/**
 * SQLite backend reporting.
 *
 * node:sqlite (Node's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / SolidKG report it and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { SolidKG } from '../src';
import packageJson from '../package.json';

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the node-sqlite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('persists the SolidKG package version in initialized DB metadata', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    try {
      const queries = new QueryBuilder(conn.getDb());

      expect(queries.getMetadata('solidkg:version')).toBe(packageJson.version);
    } finally {
      conn.close();
    }
  });

  it('SolidKG.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await SolidKG.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('node-sqlite');
    } finally {
      cg.destroy();
    }
  });

  it('reports WAL from an external SolidKG data directory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-backend-data-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
      const cg = await SolidKG.init(dir, { dataDir, index: true });
      try {
        expect(cg.getDataDir()).toBe(path.resolve(dataDir));
        expect(cg.getBackend()).toBe('node-sqlite');
        expect(cg.getJournalMode()).toBe('wal');
      } finally {
        cg.destroy();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
