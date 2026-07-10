import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality', 'sqlite-metrics.mjs');
const moduleUrl = new URL(`file://${modulePath.replace(/\\/g, '/')}`).href;

function runFixture(body: string): unknown {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import * as metrics from ${JSON.stringify(moduleUrl)};
    const root = mkdtempSync(join(tmpdir(), 'solidkg-reference-quality-'));
    try { ${body} } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const coreSchema = `
  CREATE TABLE files(path TEXT PRIMARY KEY, language TEXT NOT NULL, errors TEXT);
  CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, file_path TEXT NOT NULL, scip_symbol TEXT);
  CREATE TABLE edges(id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT, provenance TEXT);
  CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY, from_node_id TEXT NOT NULL);
  CREATE TABLE schema_versions(version INTEGER PRIMARY KEY);
  CREATE TABLE project_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

describe('reference quality SQLite metrics', () => {
  it('computes exact cross-file coverage from denominator subsets despite duplicate edges', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      const file = db.prepare('INSERT INTO files VALUES (?, ?, NULL)');
      const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, NULL)');
      for (const [id, language, kind] of [['a.ts','typescript','function'],['b.ts','typescript','function'],['c.ts','typescript','function'],['d.py','python','function'],['e.py','python','function'],['notes.md','markdown','file']]) { file.run(id, language); node.run(id, kind, id); }
      const edge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, NULL, ?)');
      edge.run(1,'a.ts','b.ts','calls','tree-sitter'); edge.run(2,'c.ts','d.py','references','heuristic');
      edge.run(3,'a.ts','a.ts','calls','tree-sitter'); edge.run(4,'a.ts','b.ts','calls','tree-sitter'); edge.run(5,'e.py','c.ts','imports','tree-sitter');
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'fixture' })));
    `) as { coverage: { raw: { any: unknown }; fair: { any: unknown; semantic: unknown; importOnlyFiles: number; excludedFiles: number } }; languages: unknown[] };
    expect(report.coverage.raw.any).toEqual({ numerator: 3, denominator: 6, rate: 0.5 });
    expect(report.coverage.fair).toMatchObject({ any: { numerator: 3, denominator: 5, rate: 0.6 }, semantic: { numerator: 2, denominator: 5, rate: 0.4 }, importOnlyFiles: 1, excludedFiles: 1 });
    expect(report.languages).toEqual(expect.arrayContaining([expect.objectContaining({ language: 'python', any: { numerator: 1, denominator: 2, rate: 0.5 } }), expect.objectContaining({ language: 'typescript', any: { numerator: 2, denominator: 3, rate: 0.667 } })]));
  });

  it('rejects a required core table with incompatible columns before querying it', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath);
      db.exec(${JSON.stringify(coreSchema.replace(', metadata TEXT', ''))}); db.close();
      console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'bad-core' })));
    `) as { status: string; incompatibleCore: unknown };
    expect(report).toMatchObject({ status: 'incompatible_schema', incompatibleCore: [{ table: 'edges', missingColumns: ['metadata'] }] });
  });

  it('reports absent members, malformed rows, and optional query failures without fabricating metrics', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec("CREATE TABLE hyperedges(id TEXT, kind TEXT); INSERT INTO hyperedges VALUES ('binding', 'route_binding')");
      db.exec("CREATE TABLE source_chunks(id TEXT, node_id TEXT, file_path TEXT); INSERT INTO source_chunks VALUES ('', 'node', 'a.ts')");
      db.exec("CREATE VIEW scip_documents(id, repo_relative_path) AS SELECT id, path FROM missing_scip_rows");
      db.exec("CREATE TABLE capability_analysis_runs(file_path TEXT, status TEXT); INSERT INTO capability_analysis_runs VALUES ('a.ts', 'mystery')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'optional' })));
    `) as { features: Record<string, { status: string }>; routes: Record<string, unknown>; optional: Record<string, unknown> };
    expect(report.features).toMatchObject({ hyperedges: { status: 'available_nonempty' }, hyperedgeMembers: { status: 'absent' }, sourceChunks: { status: 'malformed_data' }, scipDocuments: { status: 'query_error' }, capabilityRuns: { status: 'malformed_data' } });
    expect(report.routes).toMatchObject({ routeBindingHyperedges: 1, validRouteBindings: null, integrityRate: null });
    expect(report.optional).toEqual({});
  });

  it('deduplicates chunk nodes and restricts chunk and SCIP numerators to tracked declarations', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec("INSERT INTO files VALUES ('a.ts','typescript',NULL),('b.ts','typescript',NULL)");
      db.exec("INSERT INTO nodes VALUES ('a','function','a.ts','scip:a'),('b','class','b.ts',NULL),('local','parameter','a.ts','scip:local')");
      db.exec('CREATE TABLE source_chunks(id TEXT, node_id TEXT, file_path TEXT)');
      db.exec("INSERT INTO source_chunks VALUES ('c1','a','a.ts'),('c2','a','a.ts'),('c3','local','a.ts'),('c4','missing','a.ts'),('c5','b','ghost.ts')");
      db.exec('CREATE TABLE scip_documents(id TEXT, repo_relative_path TEXT)');
      db.exec("INSERT INTO scip_documents VALUES ('d1','a.ts'),('d2','ghost.ts'),('d3','a.ts')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'attachments' })));
    `) as { optional: { sourceChunks: unknown; scip: unknown } };
    expect(report.optional.sourceChunks).toEqual({ rows: 5, attachedNodes: 1, nodeCoverage: { numerator: 1, denominator: 2, rate: 0.5 }, orphanRows: 2, nonDeclarationRows: 1 });
    expect(report.optional.scip).toEqual({ documents: 1, documentCoverage: { numerator: 1, denominator: 2, rate: 0.5 }, linkedNodes: 1, linkedNodeCoverage: { numerator: 1, denominator: 2, rate: 0.5 } });
  });

  it('measures tracked SCIP documents while keeping an unavailable node-link column null', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema.replace(', scip_symbol TEXT', ''))});
      db.exec("INSERT INTO files VALUES ('a.ts','typescript',NULL); INSERT INTO nodes VALUES ('a','function','a.ts')");
      db.exec("CREATE TABLE scip_documents(id TEXT, repo_relative_path TEXT); INSERT INTO scip_documents VALUES ('d1','a.ts')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'scip-columns' })));
    `) as { status: string; features: Record<string, unknown>; optional: { scip: unknown } };
    expect(report.status).toBe('measured');
    expect(report.features.scipNodeLinks).toEqual({ status: 'incompatible_columns', missingColumns: ['scip_symbol'] });
    expect(report.optional.scip).toEqual({ documents: 1, documentCoverage: { numerator: 1, denominator: 1, rate: 1 }, linkedNodes: null, linkedNodeCoverage: null });
  });

  it('keeps unavailable capability assertions null when complete runs are measurable', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec('CREATE TABLE capability_analysis_runs(file_path TEXT, status TEXT)');
      db.exec("INSERT INTO capability_analysis_runs VALUES ('a.ts','complete'),('b.ts','failed')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'capabilities' })));
    `) as { optional: { capabilities: unknown } };
    expect(report.optional.capabilities).toEqual({ statuses: [{ status: 'complete', count: 1 }, { status: 'failed', count: 1 }], completeRate: { numerator: 1, denominator: 2, rate: 0.5 }, assertions: null });
  });

  it('measures one of two linked routes and rejects malformed route bindings', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec("INSERT INTO files VALUES ('routes.ts','typescript',NULL),('handlers.ts','typescript',NULL)");
      db.exec("INSERT INTO nodes VALUES ('r1','route','routes.ts',NULL),('r2','route','routes.ts',NULL),('h','function','handlers.ts',NULL)");
      db.exec("INSERT INTO edges VALUES (1,'r1','h','references',NULL,'tree-sitter')");
      db.exec('CREATE TABLE hyperedges(id TEXT, kind TEXT); CREATE TABLE hyperedge_members(hyperedge_id TEXT, node_id TEXT, role TEXT)');
      db.exec("INSERT INTO hyperedges VALUES ('good','route_binding'),('bad','route_binding'); INSERT INTO hyperedge_members VALUES ('good','r1','route'),('good','h','handler'),('bad','h','handler')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'routes' })));
    `) as { routes: unknown };
    expect(report.routes).toEqual({ routeNodes: 2, linkedRouteNodes: 1, linkRate: { numerator: 1, denominator: 2, rate: 0.5 }, routeBindingHyperedges: 2, validRouteBindings: 1, integrityRate: { numerator: 1, denominator: 2, rate: 0.5 } });
  });

  it('reports unresolved, file-error, dangling, provenance, and synthesized-family health', () => {
    const report = runFixture(`
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec("INSERT INTO files VALUES ('a.ts','typescript','[\\\"parse failed\\\"]'),('b.ts','typescript','[]'); INSERT INTO nodes VALUES ('a','function','a.ts',NULL),('b','function','b.ts',NULL)");
      db.exec("INSERT INTO edges VALUES (1,'a','b','calls',NULL,'tree-sitter'),(2,'a','b','calls','{\\\"synthesizedBy\\\":\\\"callback\\\"}','heuristic'),(3,'a','b','references','{\\\"synthesizedBy\\\":\\\"callback\\\"}','heuristic'),(4,'a','missing','calls',NULL,NULL)");
      db.exec("INSERT INTO unresolved_refs VALUES (1,'a'),(2,'missing')");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'health' })));
    `) as { health: Record<string, unknown> };
    expect(report.health).toMatchObject({ unresolvedReferences: 2, unresolvedPerThousand: 1000, danglingUnresolvedReferences: 1, fileErrors: 1, danglingEdges: 1, missingProvenance: 1, crossFileEdges: 3, heuristicCrossFileEdges: 2, heuristicShare: 0.667 });
    expect(report.health.provenanceDistribution).toEqual([{ provenance: 'heuristic', count: 2 }, { provenance: 'missing', count: 1 }, { provenance: 'tree-sitter', count: 1 }]);
    expect(report.health.synthesizedFamilies).toEqual([{ synthesizedBy: 'callback', count: 2 }]);
  });

  it('continues with empty and corrupt indexes and leaves unavailable git state nullable', () => {
    const result = runFixture(`
      const emptyPath = join(root, 'empty.db'); const db = new DatabaseSync(emptyPath); db.exec(${JSON.stringify(coreSchema)}); db.close();
      const empty = metrics.analyzeIndexDatabase(emptyPath, { repoId: 'empty', repoPath: root });
      const corruptPath = join(root, 'corrupt.db'); writeFileSync(corruptPath, 'not sqlite');
      const corrupt = metrics.analyzeIndexDatabase(corruptPath, { repoId: 'corrupt', repoPath: root });
      console.log(JSON.stringify({ empty, corrupt }));
    `) as { empty: { status: string; checkoutDirty: boolean | null }; corrupt: { status: string } };
    expect(result.empty).toMatchObject({ status: 'empty', checkoutDirty: null });
    expect(result.corrupt.status).toBe('corrupt');
  });

  it('derives a stable indexed-source fingerprint and rejects an unrelated parent checkout', () => {
    const report = runFixture(`
      const fs = process.getBuiltinModule('node:fs'); const child = process.getBuiltinModule('node:child_process');
      const repoPath = join(root, 'nested-repo'); fs.mkdirSync(repoPath);
      child.spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)});
      db.exec("INSERT INTO files VALUES ('a.ts','typescript',NULL); INSERT INTO nodes VALUES ('a','function','a.ts',NULL)");
      db.exec("ALTER TABLE files ADD COLUMN content_hash TEXT; UPDATE files SET content_hash='hash-a'");
      db.close(); console.log(JSON.stringify(metrics.analyzeIndexDatabase(dbPath, { repoId: 'identity', repoPath })));
    `) as { sourceFingerprint: string | null; sourceRevision: string | null; checkoutDirty: boolean | null; canonicalRemote: string | null };
    expect(report.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report).toMatchObject({ sourceRevision: null, checkoutDirty: null, canonicalRemote: null });
  });

  it.runIf(process.platform === 'win32')('does not execute a corpus-controlled git command shim', () => {
    const result = runFixture(`
      const fs = process.getBuiltinModule('node:fs'); const repoPath = join(root, 'repo'); fs.mkdirSync(repoPath);
      fs.writeFileSync(join(repoPath, 'git.cmd'), '@echo hijacked>marker.txt\\r\\n');
      const dbPath = join(root, 'solidkg.db'); const db = new DatabaseSync(dbPath); db.exec(${JSON.stringify(coreSchema)}); db.close();
      const report = metrics.analyzeIndexDatabase(dbPath, { repoId: 'hijack', repoPath });
      console.log(JSON.stringify({ report, marker: fs.existsSync(join(repoPath, 'marker.txt')) }));
    `) as { marker: boolean };
    expect(result.marker).toBe(false);
  });
});
