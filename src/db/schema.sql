-- SolidKG SQLite Schema
-- Version 11

PRAGMA user_version = 11;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- Insert initial version
INSERT INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial schema');

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Nodes: Code symbols (functions, classes, variables, etc.)
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    scip_symbol TEXT,
    scip_kind TEXT,
    scip_display_name TEXT,
    scip_signature TEXT,
    scip_documentation TEXT,
    scip_source_indexers TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT, -- JSON array
    type_parameters TEXT, -- JSON array
    updated_at INTEGER NOT NULL
);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT, -- JSON object
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Hyperedges: N-ary semantic relationships between nodes
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

-- Hyperedge Members: Ordered node roles within semantic hyperedges
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

-- Files: Tracked source files
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT -- JSON array
);

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT, -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- Indexes for Query Performance
-- =============================================================================

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_scip_symbol ON nodes(scip_symbol);

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

-- Full-text search index on node names, docstrings, and signatures
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

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

-- Edge indexes.
-- idx_edges_source / idx_edges_target are intentionally omitted —
-- the (source, kind) and (target, kind) composites below cover the
-- corresponding source-only / target-only lookups via SQLite's
-- left-prefix scan, so the narrow indexes are dead weight on writes.
-- Migration v4 drops them on existing databases.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_dedupe ON edges(source, target, kind, ifnull(line,-1), ifnull(col,-1), ifnull(provenance,''), ifnull(metadata,''));
CREATE INDEX IF NOT EXISTS idx_hyperedges_kind ON hyperedges(kind);
CREATE INDEX IF NOT EXISTS idx_hyperedges_source_file ON hyperedges(source_file);
CREATE INDEX IF NOT EXISTS idx_hyperedges_provenance ON hyperedges(provenance);
CREATE INDEX IF NOT EXISTS idx_hyperedge_members_node ON hyperedge_members(node_id);
CREATE INDEX IF NOT EXISTS idx_hyperedge_members_role ON hyperedge_members(role);
CREATE INDEX IF NOT EXISTS idx_hyperedge_members_hyperedge_ordinal ON hyperedge_members(hyperedge_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_hyperedge_members_node_role ON hyperedge_members(node_id, role);

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name_kind ON unresolved_refs(from_node_id, reference_name, reference_kind);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

-- Project metadata for version/provenance tracking
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS graph_snapshot_analyses (
    snapshot_label TEXT NOT NULL,
    analysis_kind TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    options_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_label, analysis_kind, analysis_version),
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

CREATE INDEX IF NOT EXISTS idx_graph_snapshot_nodes_label ON graph_snapshot_nodes(snapshot_label);
CREATE INDEX IF NOT EXISTS idx_graph_snapshot_edges_label ON graph_snapshot_edges(snapshot_label);
CREATE INDEX IF NOT EXISTS idx_graph_snapshot_hyperedges_label ON graph_snapshot_hyperedges(snapshot_label);
CREATE INDEX IF NOT EXISTS idx_graph_snapshot_members_label ON graph_snapshot_hyperedge_members(snapshot_label);
CREATE INDEX IF NOT EXISTS idx_graph_snapshot_analyses_label ON graph_snapshot_analyses(snapshot_label);
CREATE INDEX IF NOT EXISTS idx_arch_file_packages_package ON arch_file_packages(package_name);
CREATE INDEX IF NOT EXISTS idx_arch_file_layers_layer ON arch_file_layers(layer_name);
CREATE INDEX IF NOT EXISTS idx_capability_assertions_subject ON capability_assertions(subject_node_id);
CREATE INDEX IF NOT EXISTS idx_capability_assertions_file ON capability_assertions(file_path);
CREATE INDEX IF NOT EXISTS idx_capability_assertions_resource ON capability_assertions(resource_kind, resource_key);
CREATE INDEX IF NOT EXISTS idx_capability_assertions_producer ON capability_assertions(producer_id, producer_version);
CREATE INDEX IF NOT EXISTS idx_capability_runs_file ON capability_analysis_runs(file_path);
