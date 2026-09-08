/**
 * SQLite backend reporting.
 *
 * node:sqlite (Node's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / SolidKG report it and come up in WAL.
 */

/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { getDatabasePath, SchemaUpgradeRequiredError, SolidKG } from '../src';
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

  it('enforces physical read-only mode after query_only is disabled', () => {
    const dbPath = path.join(dir, 'test.db');
    const writable = DatabaseConnection.initialize(dbPath);
    writable.getDb().exec('CREATE TABLE physical_read_only_probe (id INTEGER)');
    writable.close();
    const conn = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      conn.getDb().pragma('query_only = OFF');
      expect(() => conn.getDb().exec('CREATE TABLE physical_read_only_probe (id INTEGER)')).toThrow();
      expect(() => conn.getDb().prepare('INSERT INTO physical_read_only_probe (id) VALUES (?)').run(1)).toThrow();
      expect(() => conn.getDb().pragma('user_version = 101')).toThrow();
    } finally {
      conn.close();
    }
  });

  it('leaves the database and WAL frames unchanged after direct write attempts', () => {
    const dbPath = path.join(dir, 'test.db');
    DatabaseConnection.initialize(dbPath).close();
    const before = sqliteFiles(dbPath);
    const conn = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      conn.getDb().pragma('query_only = OFF');
      expect(() => conn.getDb().pragma('user_version = 101')).toThrow();
      expect(() => conn.getDb().exec('CREATE TABLE read_only_wal_probe (id INTEGER)')).toThrow();
    } finally {
      conn.close();
    }
    expect(sqliteFiles(dbPath)).toEqual(before);
  });

  it('fails closed with typed schema details while a WAL writer remains open', () => {
    const dbPath = path.join(dir, 'test.db');
    const writable = DatabaseConnection.initialize(dbPath);
    try {
      writable.getDb().exec('DELETE FROM schema_versions');
      writable.getDb().prepare(
        'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(10, Date.now(), 'test schema');
      const before = sqliteInvariant(dbPath, writable);

      let error: unknown;
      try {
        DatabaseConnection.open(dbPath, { readOnly: true });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(SchemaUpgradeRequiredError);
      if (!(error instanceof SchemaUpgradeRequiredError)) throw error;
      expect(error).toMatchObject({
        code: 'SCHEMA_UPGRADE_REQUIRED',
        currentVersion: 10,
        requiredVersion: 11,
        dbPath,
      });
      expect(sqliteInvariant(dbPath, writable)).toMatchObject({
        logical: before.logical,
        mainDatabaseHash: before.mainDatabaseHash,
        committedWalFrames: before.committedWalFrames,
      });
    } finally {
      writable.close();
    }
  });

  it('keeps public health and drift reads physically read-only across an explicit-layer snapshot workflow', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const initial = 1;\n');
    const writable = await SolidKG.init(dir, { index: true });
    try {
      await writable.createSnapshot('baseline', {
        architecture: { layers: [{ name: 'source', paths: ['src/**'] }] },
      });
      await writable.createSnapshot('legacy');
      getConnection(writable).getDb().prepare(
        'DELETE FROM graph_snapshot_analyses WHERE snapshot_label = ?',
      ).run('legacy');
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), [
        'export const initial = 1;',
        'export const added = initial + 1;',
        '',
      ].join('\n'));
      await writable.sync();
    } finally {
      writable.destroy();
    }

    const dbPath = getDatabasePath(dir);
    const before = sqliteInvariant(dbPath);
    const readOnly = await SolidKG.open(dir, { readOnly: true });
    try {
      const health = readOnly.getArchitectureHealth({
        layers: [{ name: 'source', paths: ['src/**'] }],
      });
      const drift = await readOnly.getSnapshotHealthDrift('baseline');
      expect(health.options.layers).toEqual([{ name: 'source', paths: ['src/**'] }]);
      expect(drift.graphDiffCounts.addedNodes).toBeGreaterThan(0);
      await expect(readOnly.getSnapshotHealthDrift('missing')).rejects.toThrow('Snapshot "missing" not found');
      await expect(readOnly.getSnapshotHealthDrift('legacy')).resolves.toMatchObject({
        comparisonStatus: 'baseline_analysis_unavailable',
        reasons: ['baseline_analysis_unavailable'],
        introduced: [],
        resolved: [],
        persisting: [],
        metricDeltas: [],
      });
    } finally {
      readOnly.destroy();
    }

    const after = sqliteInvariant(dbPath);
    expect(after).toMatchObject({
      logical: before.logical,
      mainDatabaseHash: before.mainDatabaseHash,
      committedWalFrames: before.committedWalFrames,
    });
    expect(after.sidecars).toEqual(expect.objectContaining({
      '-wal': expect.objectContaining({ exists: expect.any(Boolean) }),
      '-shm': expect.objectContaining({ exists: expect.any(Boolean) }),
    }));
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

  it('resolves persisted member-call owner evidence after closing and reopening', async () => {
    fs.writeFileSync(
      path.join(dir, 'service.ts'),
      `class Service { run(): void {} }
export function invoke(): void {
  const service = new Service();
  service.run();
}
`,
    );

    const indexed = await SolidKG.init(dir, { index: true });
    indexed.close();

    const reopened = await SolidKG.open(dir);
    try {
      reopened.resolveReferences();

      const run = reopened.getNodesByKind('method').find(
        (node) => node.qualifiedName === 'Service::run',
      );
      expect(run).toBeDefined();
      if (!run) throw new Error('Expected Service::run to be indexed');
      expect(reopened.getCallers(run.id).map((caller) => caller.node.name)).toContain('invoke');
    } finally {
      reopened.close();
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

function sqliteFiles(dbPath: string): Record<string, Buffer> {
  return Object.fromEntries(
    ['', '-wal'].map((suffix) => {
      const filePath = `${dbPath}${suffix}`;
      return [suffix || 'database', fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0)];
    }),
  );
}

function getConnection(graph: SolidKG): DatabaseConnection {
  return (graph as unknown as { db: DatabaseConnection }).db;
}

function sqliteInvariant(dbPath: string, existingConnection?: DatabaseConnection): {
  logical: { schema: unknown[]; rows: Record<string, unknown[]>; userVersion: unknown };
  mainDatabaseHash: string;
  committedWalFrames: number;
  sidecars: Record<string, { exists: boolean; size: number; mtimeMs: number | null; hash: string | null }>;
} {
  const connection = existingConnection ?? DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = connection.getDb();
    const schema = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    const rows = Object.fromEntries(schema.map(({ name }) => [
      String(name),
      db.prepare(`SELECT * FROM ${quoteIdentifier(String(name))}`).all(),
    ]));
    const database = fs.readFileSync(dbPath);
    return {
      logical: {
        schema,
        rows,
        userVersion: db.pragma('user_version'),
      },
      mainDatabaseHash: createHash('sha256').update(database).digest('hex'),
      committedWalFrames: committedWalFrames(`${dbPath}-wal`),
      sidecars: Object.fromEntries(['-wal', '-shm'].map((suffix) => [suffix, sidecarState(`${dbPath}${suffix}`)])),
    };
  } finally {
    if (!existingConnection) connection.close();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function committedWalFrames(walPath: string): number {
  if (!fs.existsSync(walPath)) return 0;
  const wal = fs.readFileSync(walPath);
  if (wal.length < 32) return 0;
  const pageSize = wal.readUInt32BE(8) || 65_536;
  const frameSize = 24 + pageSize;
  let lastCommittedFrame = 0;
  for (let offset = 32, frame = 1; offset + frameSize <= wal.length; offset += frameSize, frame++) {
    if (wal.readUInt32BE(offset + 4) !== 0) lastCommittedFrame = frame;
  }
  return lastCommittedFrame;
}

function sidecarState(filePath: string): { exists: boolean; size: number; mtimeMs: number | null; hash: string | null } {
  if (!fs.existsSync(filePath)) return { exists: false, size: 0, mtimeMs: null, hash: null };
  const contents = fs.readFileSync(filePath);
  return {
    exists: true,
    size: contents.length,
    mtimeMs: fs.statSync(filePath).mtimeMs,
    hash: createHash('sha256').update(contents).digest('hex'),
  };
}
