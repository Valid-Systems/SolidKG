/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 11;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

function tableHasColumn(db: SqliteDatabase, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function addColumnIfMissing(db: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  if (!tableHasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description: 'Add hyperedge schema for n-ary semantic relationships and pairwise edge dedupe',
    up: (db) => {
      db.exec(`
        DELETE FROM edges
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM edges
          GROUP BY source, target, kind, ifnull(line,-1), ifnull(col,-1), ifnull(provenance,''), ifnull(metadata,'')
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_dedupe ON edges(source, target, kind, ifnull(line,-1), ifnull(col,-1), ifnull(provenance,''), ifnull(metadata,''));
        CREATE TABLE IF NOT EXISTS hyperedges (
          id TEXT NOT NULL PRIMARY KEY,
          kind TEXT NOT NULL,
          source_file TEXT,
          line INTEGER,
          col INTEGER,
          provenance TEXT,
          confidence REAL,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hyperedge_members (
          hyperedge_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          role TEXT NOT NULL,
          ordinal INTEGER NOT NULL DEFAULT 0,
          metadata TEXT,
          PRIMARY KEY (hyperedge_id, node_id, role, ordinal),
          FOREIGN KEY (hyperedge_id) REFERENCES hyperedges(id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_hyperedges_kind ON hyperedges(kind);
        CREATE INDEX IF NOT EXISTS idx_hyperedges_source_file ON hyperedges(source_file);
        CREATE INDEX IF NOT EXISTS idx_hyperedges_provenance ON hyperedges(provenance);
        CREATE INDEX IF NOT EXISTS idx_hyperedge_members_node ON hyperedge_members(node_id);
        CREATE INDEX IF NOT EXISTS idx_hyperedge_members_role ON hyperedge_members(role);
        CREATE INDEX IF NOT EXISTS idx_hyperedge_members_hyperedge_ordinal ON hyperedge_members(hyperedge_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_hyperedge_members_node_role ON hyperedge_members(node_id, role);
      `);
    },
  },
  {
    version: 6,
    description: 'Add SCIP precision-layer storage and node identity columns',
    up: (db) => {
      addColumnIfMissing(db, 'nodes', 'scip_symbol', 'scip_symbol TEXT');
      addColumnIfMissing(db, 'nodes', 'scip_kind', 'scip_kind TEXT');
      addColumnIfMissing(db, 'nodes', 'scip_display_name', 'scip_display_name TEXT');
      addColumnIfMissing(db, 'nodes', 'scip_signature', 'scip_signature TEXT');
      addColumnIfMissing(db, 'nodes', 'scip_documentation', 'scip_documentation TEXT');
      addColumnIfMissing(db, 'nodes', 'scip_source_indexers', 'scip_source_indexers TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_scip_symbol ON nodes(scip_symbol);

        CREATE TABLE IF NOT EXISTS scip_indexes (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          tool_name TEXT,
          tool_version TEXT,
          arguments TEXT,
          text_document_encoding TEXT,
          created_at INTEGER NOT NULL,
          metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS scip_documents (
          id TEXT PRIMARY KEY,
          index_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          repo_relative_path TEXT NOT NULL,
          language TEXT NOT NULL,
          position_encoding TEXT,
          text_sha256 TEXT,
          metadata TEXT,
          FOREIGN KEY (index_id) REFERENCES scip_indexes(id) ON DELETE CASCADE,
          UNIQUE(index_id, repo_relative_path)
        );
        CREATE TABLE IF NOT EXISTS scip_symbols (
          symbol TEXT PRIMARY KEY,
          scheme TEXT,
          package_manager TEXT,
          package_name TEXT,
          package_version TEXT,
          display_name TEXT,
          kind TEXT,
          enclosing_symbol TEXT,
          documentation TEXT,
          signature_language TEXT,
          signature_text TEXT,
          source_index_ids TEXT,
          metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS scip_occurrences (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          symbol TEXT,
          start_line INTEGER NOT NULL,
          start_character INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          end_character INTEGER NOT NULL,
          symbol_roles INTEGER,
          syntax_kind TEXT,
          enclosing_start_line INTEGER,
          enclosing_start_character INTEGER,
          enclosing_end_line INTEGER,
          enclosing_end_character INTEGER,
          override_documentation TEXT,
          diagnostics TEXT,
          FOREIGN KEY (document_id) REFERENCES scip_documents(id) ON DELETE CASCADE,
          FOREIGN KEY (symbol) REFERENCES scip_symbols(symbol) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS scip_relationships (
          id TEXT PRIMARY KEY,
          source_symbol TEXT NOT NULL,
          target_symbol TEXT NOT NULL,
          is_reference INTEGER NOT NULL DEFAULT 0,
          is_implementation INTEGER NOT NULL DEFAULT 0,
          is_type_definition INTEGER NOT NULL DEFAULT 0,
          is_definition INTEGER NOT NULL DEFAULT 0,
          metadata TEXT,
          FOREIGN KEY (source_symbol) REFERENCES scip_symbols(symbol) ON DELETE CASCADE,
          FOREIGN KEY (target_symbol) REFERENCES scip_symbols(symbol) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scip_documents_path ON scip_documents(repo_relative_path);
        CREATE INDEX IF NOT EXISTS idx_scip_documents_language ON scip_documents(language);
        CREATE INDEX IF NOT EXISTS idx_scip_occurrences_symbol ON scip_occurrences(symbol);
        CREATE INDEX IF NOT EXISTS idx_scip_occurrences_document ON scip_occurrences(document_id);
        CREATE INDEX IF NOT EXISTS idx_scip_occurrences_range ON scip_occurrences(document_id, start_line, start_character);
        CREATE INDEX IF NOT EXISTS idx_scip_relationships_source ON scip_relationships(source_symbol);
        CREATE INDEX IF NOT EXISTS idx_scip_relationships_target ON scip_relationships(target_symbol);
      `);
    },
  },
  {
    version: 7,
    description: 'Add graph snapshots and architecture rollup storage',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_snapshots (
          label TEXT PRIMARY KEY,
          description TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          node_count INTEGER NOT NULL,
          edge_count INTEGER NOT NULL,
          hyperedge_count INTEGER NOT NULL,
          hyperedge_member_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS graph_snapshot_nodes (
          snapshot_label TEXT NOT NULL,
          node_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (snapshot_label, node_id),
          FOREIGN KEY (snapshot_label) REFERENCES graph_snapshots(label) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS graph_snapshot_edges (
          snapshot_label TEXT NOT NULL,
          edge_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (snapshot_label, edge_key),
          FOREIGN KEY (snapshot_label) REFERENCES graph_snapshots(label) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS graph_snapshot_hyperedges (
          snapshot_label TEXT NOT NULL,
          hyperedge_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (snapshot_label, hyperedge_id),
          FOREIGN KEY (snapshot_label) REFERENCES graph_snapshots(label) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS graph_snapshot_hyperedge_members (
          snapshot_label TEXT NOT NULL,
          member_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (snapshot_label, member_key),
          FOREIGN KEY (snapshot_label) REFERENCES graph_snapshots(label) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS architecture_reports (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arch_packages (
          name TEXT PRIMARY KEY,
          root TEXT NOT NULL,
          provenance TEXT NOT NULL,
          file_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arch_layers (
          name TEXT PRIMARY KEY,
          provenance TEXT NOT NULL,
          file_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arch_file_packages (
          file_path TEXT PRIMARY KEY,
          package_name TEXT NOT NULL,
          package_root TEXT NOT NULL,
          provenance TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arch_file_layers (
          file_path TEXT PRIMARY KEY,
          layer_name TEXT NOT NULL,
          provenance TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arch_package_deps (
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          edge_kinds TEXT NOT NULL,
          PRIMARY KEY (source, target)
        );
        CREATE TABLE IF NOT EXISTS arch_layer_deps (
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          edge_kinds TEXT NOT NULL,
          PRIMARY KEY (source, target)
        );
        CREATE TABLE IF NOT EXISTS arch_coupling (
          scope TEXT NOT NULL,
          name TEXT NOT NULL,
          ca INTEGER NOT NULL,
          ce INTEGER NOT NULL,
          instability REAL NOT NULL,
          PRIMARY KEY (scope, name)
        );
        CREATE INDEX IF NOT EXISTS idx_graph_snapshot_nodes_label ON graph_snapshot_nodes(snapshot_label);
        CREATE INDEX IF NOT EXISTS idx_graph_snapshot_edges_label ON graph_snapshot_edges(snapshot_label);
        CREATE INDEX IF NOT EXISTS idx_graph_snapshot_hyperedges_label ON graph_snapshot_hyperedges(snapshot_label);
        CREATE INDEX IF NOT EXISTS idx_graph_snapshot_members_label ON graph_snapshot_hyperedge_members(snapshot_label);
        CREATE INDEX IF NOT EXISTS idx_arch_file_packages_package ON arch_file_packages(package_name);
        CREATE INDEX IF NOT EXISTS idx_arch_file_layers_layer ON arch_file_layers(layer_name);
      `);
    },
  },
  {
    version: 8,
    description: 'Add unresolved reference covering index for resolver cleanup',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_unresolved_from_name_kind ON unresolved_refs(from_node_id, reference_name, reference_kind);
      `);
    },
  },
  {
    version: 9,
    description: 'Add capability assertion storage and producer coverage runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS capability_assertions (
          id TEXT PRIMARY KEY,
          subject_node_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          resource_kind TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          target_node_id TEXT,
          scope TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          start_column INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          end_column INTEGER NOT NULL,
          origin TEXT NOT NULL,
          certainty TEXT NOT NULL,
          producer_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          producer_version TEXT NOT NULL,
          supporting_hyperedge_id TEXT,
          metadata TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (subject_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (target_node_id) REFERENCES nodes(id) ON DELETE SET NULL,
          FOREIGN KEY (supporting_hyperedge_id) REFERENCES hyperedges(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS capability_analysis_runs (
          file_path TEXT NOT NULL,
          producer_id TEXT NOT NULL,
          producer_version TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          diagnostics TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (file_path, producer_id)
        );
        CREATE INDEX IF NOT EXISTS idx_capability_assertions_subject ON capability_assertions(subject_node_id);
        CREATE INDEX IF NOT EXISTS idx_capability_assertions_file ON capability_assertions(file_path);
        CREATE INDEX IF NOT EXISTS idx_capability_assertions_resource ON capability_assertions(resource_kind, resource_key);
        CREATE INDEX IF NOT EXISTS idx_capability_assertions_producer ON capability_assertions(producer_id, producer_version);
        CREATE INDEX IF NOT EXISTS idx_capability_runs_file ON capability_analysis_runs(file_path);
      `);
    },
  },
  {
    version: 10,
    description: 'Add source chunk projection storage and dedicated FTS',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_chunks (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          language TEXT NOT NULL,
          symbol_kind TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          chunk_ordinal INTEGER NOT NULL,
          indexer_version TEXT NOT NULL,
          content TEXT NOT NULL,
          code_token_text TEXT NOT NULL,
          metadata TEXT,
          diagnostics TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_source_chunks_identity ON source_chunks(
          node_id,
          file_path,
          language,
          symbol_kind,
          start_line,
          end_line,
          content_hash,
          source_hash,
          chunk_ordinal,
          indexer_version
        );
        CREATE INDEX IF NOT EXISTS idx_source_chunks_node_id ON source_chunks(node_id);
        CREATE INDEX IF NOT EXISTS idx_source_chunks_file_path ON source_chunks(file_path);
        CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
          id,
          node_id,
          file_path,
          language,
          symbol_kind,
          content,
          code_token_text,
          content='source_chunks',
          content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS source_chunks_ai AFTER INSERT ON source_chunks BEGIN
          INSERT INTO source_chunks_fts(rowid, id, node_id, file_path, language, symbol_kind, content, code_token_text)
          VALUES (NEW.rowid, NEW.id, NEW.node_id, NEW.file_path, NEW.language, NEW.symbol_kind, NEW.content, NEW.code_token_text);
        END;
        CREATE TRIGGER IF NOT EXISTS source_chunks_ad AFTER DELETE ON source_chunks BEGIN
          INSERT INTO source_chunks_fts(source_chunks_fts, rowid, id, node_id, file_path, language, symbol_kind, content, code_token_text)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.node_id, OLD.file_path, OLD.language, OLD.symbol_kind, OLD.content, OLD.code_token_text);
        END;
        CREATE TRIGGER IF NOT EXISTS source_chunks_au AFTER UPDATE ON source_chunks BEGIN
          INSERT INTO source_chunks_fts(source_chunks_fts, rowid, id, node_id, file_path, language, symbol_kind, content, code_token_text)
          VALUES ('delete', OLD.rowid, OLD.id, OLD.node_id, OLD.file_path, OLD.language, OLD.symbol_kind, OLD.content, OLD.code_token_text);
          INSERT INTO source_chunks_fts(rowid, id, node_id, file_path, language, symbol_kind, content, code_token_text)
          VALUES (NEW.rowid, NEW.id, NEW.node_id, NEW.file_path, NEW.language, NEW.symbol_kind, NEW.content, NEW.code_token_text);
        END;
      `);
    },
  },
  {
    version: 11,
    description: 'Add snapshot-scoped architecture analysis storage',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_snapshot_analyses (
          snapshot_label TEXT NOT NULL,
          analysis_kind TEXT NOT NULL,
          analysis_version INTEGER NOT NULL,
          options_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (snapshot_label, analysis_kind, analysis_version),
          FOREIGN KEY (snapshot_label) REFERENCES graph_snapshots(label) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_graph_snapshot_analyses_label ON graph_snapshot_analyses(snapshot_label);
        PRAGMA user_version = 11;
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}
