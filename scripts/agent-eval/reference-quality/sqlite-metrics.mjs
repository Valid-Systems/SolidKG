import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANY_EDGE_KINDS, DECLARATION_KINDS, IMPORT_EDGE_KINDS, SEMANTIC_EDGE_KINDS, ratio } from './policy.mjs';

const CORE_COLUMNS = Object.freeze({
  files: ['path', 'language', 'errors'],
  nodes: ['id', 'kind', 'file_path'],
  edges: ['source', 'target', 'kind', 'metadata', 'provenance'],
  unresolved_refs: ['from_node_id'],
});
const CAPABILITY_STATUSES = Object.freeze(['complete', 'partial', 'unsupported', 'failed', 'not_run', 'stale']);
const quote = (values) => values.map((value) => `'${value}'`).join(',');
const declarations = quote(DECLARATION_KINDS);
export const TRUSTED_GIT_EXECUTABLE = (() => {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const trustedDirectory = directory.replace(/^"|"$/g, '');
    if (!isAbsolute(trustedDirectory)) continue;
    for (const name of names) {
      const candidate = resolve(trustedDirectory, name);
      if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
    }
  }
  return null;
})();

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return Number(row ? Object.values(row)[0] : 0);
}

function tableColumns(db, table) {
  const found = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  if (Number(found?.count ?? 0) === 0) return null;
  return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => String(row.name)));
}

function featureStatus(db, table, requiredColumns, malformedWhere = null) {
  try {
    const columns = tableColumns(db, table);
    if (!columns) return { status: 'absent' };
    const missingColumns = requiredColumns.filter((column) => !columns.has(column));
    if (missingColumns.length > 0) return { status: 'incompatible_columns', missingColumns };
    const rows = scalar(db, `SELECT COUNT(*) FROM ${table}`);
    const malformedRows = malformedWhere ? scalar(db, `SELECT COUNT(*) FROM ${table} WHERE ${malformedWhere}`) : 0;
    if (malformedRows > 0) return { status: 'malformed_data', rows, malformedRows };
    return { status: rows === 0 ? 'available_empty' : 'available_nonempty', rows };
  } catch (error) {
    return { status: 'query_error', message: error instanceof Error ? error.message : String(error) };
  }
}

function isAvailable(feature) {
  return feature.status === 'available_empty' || feature.status === 'available_nonempty';
}

function scipNodeLinkStatus(db) {
  if (!tableColumns(db, 'nodes')?.has('scip_symbol')) return { status: 'incompatible_columns', missingColumns: ['scip_symbol'] };
  const rows = scalar(db, "SELECT COUNT(*) FROM nodes WHERE scip_symbol IS NOT NULL AND trim(scip_symbol)<>''");
  return { status: rows === 0 ? 'available_empty' : 'available_nonempty', rows };
}

function gitValue(repoRoot, args) {
  if (!TRUSTED_GIT_EXECUTABLE) return null;
  const result = spawnSync(TRUSTED_GIT_EXECUTABLE, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitMetadata(repoRoot) {
  const topLevel = gitValue(repoRoot, ['rev-parse', '--show-toplevel']);
  const normalize = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (!topLevel || normalize(topLevel) !== normalize(repoRoot)) return { sourceRevision: null, checkoutDirty: null, canonicalRemote: null };
  const checkoutState = gitValue(repoRoot, ['status', '--porcelain']);
  return {
    sourceRevision: gitValue(repoRoot, ['rev-parse', 'HEAD']),
    checkoutDirty: checkoutState === null ? null : checkoutState !== '',
    canonicalRemote: gitValue(repoRoot, ['remote', 'get-url', 'origin']),
  };
}

function indexedSourceFingerprint(db) {
  if (!tableColumns(db, 'files')?.has('content_hash')) return null;
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT path, content_hash FROM files ORDER BY path').all()) {
    hash.update(String(row.path)); hash.update('\0'); hash.update(String(row.content_hash)); hash.update('\0');
  }
  return hash.digest('hex');
}

function artifactFingerprint(dbPath) {
  const hash = createHash('sha256');
  for (const artifact of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(artifact) || statSync(artifact).size === 0) continue;
    hash.update(basename(artifact));
    hash.update(readFileSync(artifact));
  }
  return hash.digest('hex');
}

function coverageRows(db) {
  return db.prepare(`
    WITH declaration_files AS (SELECT DISTINCT n.file_path FROM nodes n JOIN files f ON f.path=n.file_path WHERE n.kind IN (${declarations})),
    incoming AS (
      SELECT tf.path AS target_file,
        MAX(e.kind IN (${quote(ANY_EDGE_KINDS)})) AS any_hit,
        MAX(e.kind IN (${quote(SEMANTIC_EDGE_KINDS)})) AS semantic_hit,
        MAX(e.kind IN (${quote(IMPORT_EDGE_KINDS)})) AS import_hit
      FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
      JOIN files sf ON sf.path=s.file_path JOIN files tf ON tf.path=t.file_path
      WHERE s.file_path<>t.file_path AND e.kind<>'contains' GROUP BY tf.path
    )
    SELECT f.path, f.language, d.file_path IS NOT NULL AS fair,
      COALESCE(i.any_hit,0) AS any_hit, COALESCE(i.semantic_hit,0) AS semantic_hit,
      COALESCE(i.import_hit,0)=1 AND COALESCE(i.semantic_hit,0)=0 AS import_only
    FROM files f LEFT JOIN declaration_files d ON d.file_path=f.path LEFT JOIN incoming i ON i.target_file=f.path ORDER BY f.path
  `).all();
}

function summarizeCoverage(rows, fairOnly) {
  const eligible = fairOnly ? rows.filter((row) => row.fair === 1) : rows;
  return {
    any: ratio(eligible.filter((row) => row.any_hit === 1).length, eligible.length),
    semantic: ratio(eligible.filter((row) => row.semantic_hit === 1).length, eligible.length),
    importOnlyFiles: eligible.filter((row) => row.import_only === 1).length,
    excludedFiles: rows.length - eligible.length,
  };
}

function languageCoverage(rows) {
  const grouped = new Map();
  for (const row of rows.filter((item) => item.fair === 1)) grouped.set(row.language, [...(grouped.get(row.language) ?? []), row]);
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([language, items]) => ({
    language,
    any: ratio(items.filter((row) => row.any_hit === 1).length, items.length),
    semantic: ratio(items.filter((row) => row.semantic_hit === 1).length, items.length),
    importOnlyFiles: items.filter((row) => row.import_only === 1).length,
  }));
}

function routeMetrics(db, features) {
  const routeNodes = scalar(db, "SELECT COUNT(*) FROM nodes n JOIN files f ON f.path=n.file_path WHERE n.kind='route'");
  const linkedRouteNodes = scalar(db, "SELECT COUNT(DISTINCT r.id) FROM nodes r JOIN files rf ON rf.path=r.file_path JOIN edges e ON e.source=r.id JOIN nodes t ON t.id=e.target JOIN files tf ON tf.path=t.file_path WHERE r.kind='route' AND t.kind<>'route' AND e.kind IN ('references','calls')");
  const routeBindingHyperedges = isAvailable(features.hyperedges) ? scalar(db, "SELECT COUNT(*) FROM hyperedges WHERE kind='route_binding'") : null;
  if (routeBindingHyperedges === null || !isAvailable(features.hyperedgeMembers)) {
    return { routeNodes, linkedRouteNodes, linkRate: ratio(linkedRouteNodes, routeNodes), routeBindingHyperedges, validRouteBindings: null, integrityRate: null };
  }
  const validRouteBindings = scalar(db, `
    SELECT COUNT(*) FROM (
      SELECT h.id,
        COUNT(DISTINCT CASE WHEN m.role='route' AND n.kind='route' THEN n.id END) AS routes,
        COUNT(DISTINCT CASE WHEN m.role='handler' AND n.kind IN ('function','method') THEN n.id END) AS handlers,
        SUM(CASE WHEN m.node_id IS NOT NULL AND n.id IS NULL THEN 1 ELSE 0 END) AS orphans
      FROM hyperedges h LEFT JOIN hyperedge_members m ON m.hyperedge_id=h.id LEFT JOIN nodes n ON n.id=m.node_id
      WHERE h.kind='route_binding' GROUP BY h.id
    ) WHERE routes=1 AND handlers>0 AND orphans=0
  `);
  return { routeNodes, linkedRouteNodes, linkRate: ratio(linkedRouteNodes, routeNodes), routeBindingHyperedges, validRouteBindings, integrityRate: ratio(validRouteBindings, routeBindingHyperedges) };
}

function optionalMetrics(db, features, eligibleNodes, indexedFiles) {
  const optional = {};
  if (isAvailable(features.sourceChunks)) {
    const row = db.prepare(`
      SELECT COUNT(*) AS rows,
        COUNT(DISTINCT CASE WHEN n.kind IN (${declarations}) AND f.path IS NOT NULL AND c.file_path=n.file_path THEN n.id END) AS attached,
        SUM(CASE WHEN n.id IS NULL OR f.path IS NULL OR c.file_path<>n.file_path THEN 1 ELSE 0 END) AS orphans,
        SUM(CASE WHEN n.id IS NOT NULL AND f.path IS NOT NULL AND c.file_path=n.file_path AND n.kind NOT IN (${declarations}) THEN 1 ELSE 0 END) AS non_declarations
      FROM source_chunks c LEFT JOIN nodes n ON n.id=c.node_id LEFT JOIN files f ON f.path=c.file_path
    `).get();
    optional.sourceChunks = { rows: Number(row.rows), attachedNodes: Number(row.attached), nodeCoverage: ratio(Number(row.attached), eligibleNodes), orphanRows: Number(row.orphans), nonDeclarationRows: Number(row.non_declarations) };
  }
  if (isAvailable(features.scipDocuments)) {
    const documents = scalar(db, 'SELECT COUNT(DISTINCT f.path) FROM scip_documents d JOIN files f ON f.path=d.repo_relative_path');
    const linkedNodes = isAvailable(features.scipNodeLinks) ? scalar(db, `SELECT COUNT(DISTINCT n.id) FROM nodes n JOIN files f ON f.path=n.file_path WHERE n.kind IN (${declarations}) AND n.scip_symbol IS NOT NULL AND trim(n.scip_symbol)<>''`) : null;
    optional.scip = { documents, documentCoverage: ratio(documents, indexedFiles), linkedNodes, linkedNodeCoverage: linkedNodes === null ? null : ratio(linkedNodes, eligibleNodes) };
  }
  if (isAvailable(features.capabilityRuns)) {
    const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM capability_analysis_runs GROUP BY status ORDER BY status').all().map((row) => ({ status: row.status, count: Number(row.count) }));
    const total = statuses.reduce((sum, row) => sum + row.count, 0);
    const complete = statuses.find((row) => row.status === 'complete')?.count ?? 0;
    optional.capabilities = { statuses, completeRate: ratio(complete, total), assertions: isAvailable(features.capabilityAssertions) ? features.capabilityAssertions.rows : null };
  }
  return optional;
}

function healthMetrics(db, eligibleNodes) {
  const base = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM unresolved_refs) AS unresolved,
      (SELECT COUNT(*) FROM unresolved_refs u LEFT JOIN nodes n ON n.id=u.from_node_id WHERE n.id IS NULL) AS dangling_unresolved,
      (SELECT COUNT(*) FROM files WHERE errors IS NOT NULL AND trim(errors) NOT IN ('','[]')) AS file_errors,
      (SELECT COUNT(*) FROM edges e LEFT JOIN nodes s ON s.id=e.source LEFT JOIN nodes t ON t.id=e.target WHERE s.id IS NULL OR t.id IS NULL) AS dangling_edges,
      (SELECT COUNT(*) FROM edges WHERE provenance IS NULL OR trim(provenance)='') AS missing_provenance,
      (SELECT COUNT(*) FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target JOIN files sf ON sf.path=s.file_path JOIN files tf ON tf.path=t.file_path WHERE s.file_path<>t.file_path AND e.kind<>'contains') AS cross_edges,
      (SELECT COUNT(*) FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target JOIN files sf ON sf.path=s.file_path JOIN files tf ON tf.path=t.file_path WHERE s.file_path<>t.file_path AND e.kind<>'contains' AND e.provenance='heuristic') AS heuristic_edges
  `).get();
  const provenanceDistribution = db.prepare("SELECT COALESCE(NULLIF(trim(provenance),''),'missing') AS provenance, COUNT(*) AS count FROM edges GROUP BY 1 ORDER BY 1").all().map((row) => ({ provenance: row.provenance, count: Number(row.count) }));
  const synthesizedFamilies = db.prepare(`SELECT synthesizedBy, COUNT(*) AS count FROM (SELECT CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.synthesizedBy') END AS synthesizedBy FROM edges WHERE provenance='heuristic') WHERE typeof(synthesizedBy)='text' AND trim(synthesizedBy)<>'' GROUP BY synthesizedBy ORDER BY synthesizedBy`).all().map((row) => ({ synthesizedBy: row.synthesizedBy, count: Number(row.count) }));
  const unresolved = Number(base.unresolved); const crossEdges = Number(base.cross_edges); const heuristicEdges = Number(base.heuristic_edges);
  return {
    unresolvedReferences: unresolved, unresolvedPerThousand: eligibleNodes === 0 ? null : Number(((unresolved / eligibleNodes) * 1000).toFixed(3)),
    danglingUnresolvedReferences: Number(base.dangling_unresolved), fileErrors: Number(base.file_errors), danglingEdges: Number(base.dangling_edges),
    missingProvenance: Number(base.missing_provenance), provenanceDistribution, crossFileEdges: crossEdges, heuristicCrossFileEdges: heuristicEdges,
    heuristicShare: crossEdges === 0 ? null : Number((heuristicEdges / crossEdges).toFixed(3)), synthesizedFamilies,
  };
}

export function analyzeIndexDatabase(dbPath, options) {
  const started = performance.now();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const incompatibleCore = Object.entries(CORE_COLUMNS).flatMap(([table, required]) => {
      const columns = tableColumns(db, table); const missingColumns = required.filter((column) => !columns?.has(column));
      return missingColumns.length === 0 ? [] : [{ table, missingColumns }];
    });
    if (incompatibleCore.length > 0) return { repoId: options.repoId, status: 'incompatible_schema', incompatibleCore, scanDurationMs: Math.round(performance.now() - started) };
    const features = {
      hyperedges: featureStatus(db, 'hyperedges', ['id', 'kind'], "id IS NULL OR trim(id)='' OR kind IS NULL OR trim(kind)=''"),
      hyperedgeMembers: featureStatus(db, 'hyperedge_members', ['hyperedge_id', 'node_id', 'role'], "hyperedge_id IS NULL OR trim(hyperedge_id)='' OR node_id IS NULL OR trim(node_id)='' OR role IS NULL OR trim(role)=''"),
      sourceChunks: featureStatus(db, 'source_chunks', ['id', 'node_id', 'file_path'], "id IS NULL OR trim(id)='' OR node_id IS NULL OR trim(node_id)='' OR file_path IS NULL OR trim(file_path)=''"),
      scipDocuments: featureStatus(db, 'scip_documents', ['id', 'repo_relative_path'], "id IS NULL OR trim(id)='' OR repo_relative_path IS NULL OR trim(repo_relative_path)=''"),
      scipNodeLinks: scipNodeLinkStatus(db),
      capabilityRuns: featureStatus(db, 'capability_analysis_runs', ['file_path', 'status'], `file_path IS NULL OR trim(file_path)='' OR status NOT IN (${quote(CAPABILITY_STATUSES)})`),
      capabilityAssertions: featureStatus(db, 'capability_assertions', ['id', 'file_path'], "id IS NULL OR trim(id)='' OR file_path IS NULL OR trim(file_path)=''"),
    };
    const rows = coverageRows(db); const fairRows = rows.filter((row) => row.fair === 1);
    const eligibleNodes = scalar(db, `SELECT COUNT(*) FROM nodes n JOIN files f ON f.path=n.file_path WHERE n.kind IN (${declarations})`);
    const schemaColumns = tableColumns(db, 'schema_versions');
    const metadataColumns = tableColumns(db, 'project_metadata');
    const schemaVersion = schemaColumns?.has('version') ? scalar(db, 'SELECT COALESCE(MAX(version),0) FROM schema_versions') : 0;
    const producerVersion = metadataColumns?.has('key') && metadataColumns.has('value') ? db.prepare("SELECT value FROM project_metadata WHERE key='solidkg:version'").get()?.value ?? null : null;
    const repoRoot = options.repoPath ?? dirname(dirname(dbPath));
    const source = gitMetadata(repoRoot);
    return {
      repoId: options.repoId, status: rows.length === 0 ? 'empty' : 'measured', schemaVersion, producerVersion,
      ...source, sourceFingerprint: indexedSourceFingerprint(db),
      indexFingerprint: artifactFingerprint(dbPath), databaseBytes: statSync(dbPath).size,
      counts: { files: rows.length, fairFiles: fairRows.length, eligibleNodes, edges: scalar(db, 'SELECT COUNT(*) FROM edges') },
      coverage: { raw: summarizeCoverage(rows, false), fair: summarizeCoverage(rows, true) }, languages: languageCoverage(rows), features,
      routes: routeMetrics(db, features), optional: optionalMetrics(db, features, eligibleNodes, rows.length), health: healthMetrics(db, eligibleNodes),
      scanDurationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { repoId: options.repoId, status: 'corrupt', error: error instanceof Error ? error.message : String(error), scanDurationMs: Math.round(performance.now() - started) };
  } finally {
    db?.close();
  }
}
