import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const RELATIONS = Object.freeze([
  {
    name: 'files',
    sql: 'SELECT path, content_hash, language, size, node_count, errors FROM files ORDER BY path',
    jsonColumns: ['errors'],
  },
  {
    name: 'nodes',
    sql: `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
      start_column, end_column, docstring, signature, visibility, is_exported, is_async,
      is_static, is_abstract, decorators, type_parameters
      FROM nodes ORDER BY id`,
    jsonColumns: ['decorators', 'type_parameters'],
  },
  {
    name: 'edges',
    sql: `SELECT source, target, kind, metadata, line, col, provenance
      FROM edges ORDER BY source, target, kind, ifnull(line, -1), ifnull(col, -1), ifnull(provenance, ''), ifnull(metadata, '')`,
    jsonColumns: ['metadata'],
  },
  {
    name: 'hyperedges',
    sql: `SELECT id, kind, source_file, line, col, provenance, confidence, metadata
      FROM hyperedges ORDER BY id`,
    jsonColumns: ['metadata'],
  },
  {
    name: 'hyperedgeMembers',
    sql: `SELECT hyperedge_id, node_id, role, ordinal, metadata
      FROM hyperedge_members ORDER BY hyperedge_id, ordinal, node_id, role`,
    jsonColumns: ['metadata'],
  },
  {
    name: 'unresolvedReferences',
    sql: `SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
      FROM unresolved_refs ORDER BY from_node_id, reference_name, reference_kind, line, col, file_path, language, candidates`,
    jsonColumns: ['candidates'],
  },
  {
    name: 'sourceChunks',
    sql: `SELECT id, node_id, file_path, language, symbol_kind, start_line, end_line, content_hash,
      source_hash, chunk_ordinal, indexer_version, content, code_token_text, metadata, diagnostics
      FROM source_chunks ORDER BY id`,
    jsonColumns: ['metadata', 'diagnostics'],
  },
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalRow(row, jsonColumns = []) {
  const normalized = { ...row };
  for (const column of jsonColumns) {
    const value = normalized[column];
    if (typeof value !== 'string' || value.length === 0) continue;
    try {
      normalized[column] = canonicalValue(JSON.parse(value));
    } catch {
      // Preserve non-JSON legacy values exactly.
    }
  }
  return canonicalValue(normalized);
}

function relationFingerprint(db, relation) {
  const hash = createHash('sha256');
  const rows = [...db.prepare(relation.sql).iterate()]
    .map((row) => JSON.stringify(canonicalRow(row, relation.jsonColumns)))
    .sort();
  for (const row of rows) {
    hash.update(row);
    hash.update('\n');
  }
  return { hash: hash.digest('hex'), rowCount: rows.length };
}

export function fingerprintGraph(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      schemaName: 'solidkg.graph-fingerprint.v1',
      relations: Object.fromEntries(RELATIONS.map((relation) => [relation.name, relationFingerprint(db, relation)])),
    };
  } finally {
    db.close();
  }
}

export function compareGraphFingerprints(left, right) {
  const relationNames = [...new Set([
    ...Object.keys(left.relations ?? {}),
    ...Object.keys(right.relations ?? {}),
  ])].sort();
  const changedRelations = relationNames.filter((name) => {
    const leftRelation = left.relations?.[name];
    const rightRelation = right.relations?.[name];
    return leftRelation?.hash !== rightRelation?.hash || leftRelation?.rowCount !== rightRelation?.rowCount;
  });
  return {
    schemaName: 'solidkg.graph-fingerprint-comparison.v1',
    equal: changedRelations.length === 0,
    changedRelations,
  };
}
