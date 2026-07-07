/**
 * SQLite Adapter
 *
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`), exposed
 * through a small better-sqlite3-shaped interface so the rest of the codebase
 * is storage-agnostic.
 *
 * SolidKG ships with a bundled Node runtime, so `node:sqlite` (real SQLite,
 * with WAL + FTS5) is always available — there is no native build step and no
 * wasm fallback. When run from source instead, it requires Node >= 22.5.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * The active SQLite backend. Only one now (`node:sqlite`); kept as a named type
 * so `solidkg status` and the per-instance reporting have a stable shape.
 */
export type SqliteBackend = 'node-sqlite';

const NODE_SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

function loadNodeSqlite(): { DatabaseSync: new (dbPath: string) => any } {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, typeOrOptions?: string | NodeJS.EmitWarningOptions, code?: string, ctor?: Function) => {
    const message = warning instanceof Error ? warning.message : String(warning);
    if (typeOrOptions === 'ExperimentalWarning' && message === NODE_SQLITE_EXPERIMENTAL_WARNING) {
      return;
    }
    if (warning instanceof Error) {
      return emitWarning(warning);
    }
    if (typeof typeOrOptions === 'string') {
      return emitWarning(warning, typeOrOptions, code, ctor);
    }
    return emitWarning(warning, typeOrOptions);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 *
 * node:sqlite is real SQLite compiled into Node, so it supports WAL, FTS5,
 * mmap, and `@named` params natively — the only shims needed are the
 * better-sqlite3 conveniences node:sqlite omits: a `.pragma()` helper, a
 * `.transaction()` helper, and `open` (node:sqlite exposes `isOpen`).
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(dbPath: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this._db = new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    // node:sqlite matches better-sqlite3's calling convention (variadic
    // positional args, or a single object for @named params), so params forward
    // through unchanged.
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    // Write pragma ("key = value"): node:sqlite is real SQLite, so every pragma
    // (WAL, mmap, synchronous, …) applies as-is.
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma. Default: the row object (e.g. { journal_mode: 'wal' }).
    // `{ simple: true }` returns just the single column value, like better-sqlite3.
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      const nested = this.transactionDepth > 0;
      const savepoint = nested ? `solidkg_sp_${++this.savepointCounter}` : '';
      this._db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.transactionDepth++;
      try {
        const result = fn(...args);
        this._db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        if (nested) {
          this._db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this._db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this._db.exec('ROLLBACK');
        }
        throw error;
      } finally {
        this.transactionDepth--;
      }
    };
  }

  close(): void {
    // node:sqlite's DatabaseSync.close() throws if already closed; make it
    // idempotent to match better-sqlite3 (callers may close more than once).
    if (this._db.isOpen) this._db.close();
  }
}

/**
 * Create a database connection backed by `node:sqlite`.
 *
 * Returns the active backend alongside the db so each `DatabaseConnection` can
 * report it per-instance — MCP can open multiple project DBs in one process, so
 * a process-global would race.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  try {
    return { db: new NodeSqliteAdapter(dbPath), backend: 'node-sqlite' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Failed to open SQLite via the built-in node:sqlite module.\n' +
      'SolidKG requires node:sqlite (Node.js 22.5+). Install the self-contained\n' +
      'SolidKG release (it bundles a compatible Node 24.16.0), or run on Node 24 LTS / v24.16.0.\n' +
      `Underlying error: ${msg}`
    );
  }
}
