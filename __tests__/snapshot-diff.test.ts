import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder, type StoredSnapshotGraph } from '../src/db/queries';
import {
  canonicalizeArchitectureHealthReport,
  canonicalJson,
  normalizeArchitectureHealthOptions,
  type StoredSnapshotAnalysisRow,
} from '../src/analysis';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Hyperedge, HyperedgeMember, Node } from '../src/types';

interface SnapshotMetadataInput {
  description?: string;
  metadata?: Record<string, unknown>;
}

interface SnapshotMetadata {
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  hyperedgeMemberCount: number;
}

type SnapshotNodeDiff = Pick<Node, 'id' | 'kind' | 'name' | 'qualifiedName' | 'filePath' | 'language'>;
type SnapshotEdgeDiff = Pick<Edge, 'source' | 'target' | 'kind' | 'metadata' | 'line' | 'column' | 'provenance'>;
type SnapshotHyperedgeDiff = Pick<Hyperedge, 'id' | 'kind' | 'sourceFile' | 'line' | 'column' | 'provenance' | 'confidence' | 'metadata'>;
type SnapshotHyperedgeMemberDiff = Pick<HyperedgeMember, 'hyperedgeId' | 'nodeId' | 'role' | 'ordinal' | 'metadata'>;

interface SnapshotDiff {
  addedNodes: SnapshotNodeDiff[];
  removedNodes: SnapshotNodeDiff[];
  changedNodes: SnapshotNodeDiff[];
  addedEdges: SnapshotEdgeDiff[];
  removedEdges: SnapshotEdgeDiff[];
  changedEdges: SnapshotEdgeDiff[];
  addedHyperedges: SnapshotHyperedgeDiff[];
  removedHyperedges: SnapshotHyperedgeDiff[];
  changedHyperedges: SnapshotHyperedgeDiff[];
  addedHyperedgeMembers: SnapshotHyperedgeMemberDiff[];
  removedHyperedgeMembers: SnapshotHyperedgeMemberDiff[];
  changedHyperedgeMembers: SnapshotHyperedgeMemberDiff[];
}

interface SnapshotSolidKG {
  createSnapshot(label: string, metadata?: SnapshotMetadataInput): Promise<SnapshotMetadata>;
  listSnapshots(): Promise<SnapshotMetadata[]>;
  deleteSnapshot(label: string): Promise<boolean>;
  diffSnapshot(label: string): Promise<SnapshotDiff>;
}

interface SnapshotAnalysisQueries {
  saveSnapshot(
    metadata: SnapshotMetadata,
    graph: StoredSnapshotGraph,
    analyses?: readonly StoredSnapshotAnalysisRow[],
  ): void;
  getSnapshotAnalyses(label: string): StoredSnapshotAnalysisRow[];
}

describe('graph snapshots and diffs', () => {
  let testDir: string | undefined;
  let cg: SolidKG | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    testDir = undefined;
  });

  it('snapshot save/list/delete persists explicit snapshot metadata', async () => {
    await createProject({
      'src/index.ts': `
export function greet(name: string): string {
  return formatGreeting(name);
}

function formatGreeting(name: string): string {
  return ` + '`hello ${name}`' + `;
}
`,
    });

    const snapshots = snapshotApi(cg!);
    const saved = await snapshots.createSnapshot('before-refactor', {
      description: 'before extracting greeting formatter',
      metadata: { ticket: 'CG-123', actor: 'vitest' },
    });

    expect(saved).toMatchObject({
      label: 'before-refactor',
      description: 'before extracting greeting formatter',
      metadata: { ticket: 'CG-123', actor: 'vitest' },
      nodeCount: expect.any(Number),
      edgeCount: expect.any(Number),
      hyperedgeCount: 0,
      hyperedgeMemberCount: 0,
      createdAt: expect.any(Number),
    });
    expect(saved.nodeCount).toBeGreaterThan(0);

    await cg!.indexAll();
    await cg!.sync();

    const listed = await snapshots.listSnapshots();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      label: 'before-refactor',
      description: 'before extracting greeting formatter',
      metadata: { ticket: 'CG-123', actor: 'vitest' },
      nodeCount: saved.nodeCount,
      edgeCount: saved.edgeCount,
      hyperedgeCount: saved.hyperedgeCount,
      hyperedgeMemberCount: saved.hyperedgeMemberCount,
    });

    cg!.destroy();
    cg = SolidKG.openSync(testDir!);
    const reopenedSnapshots = snapshotApi(cg!);
    await expect(reopenedSnapshots.listSnapshots()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'before-refactor', nodeCount: saved.nodeCount }),
    ]));

    await expect(reopenedSnapshots.deleteSnapshot('before-refactor')).resolves.toBe(true);
    await expect(reopenedSnapshots.listSnapshots()).resolves.toEqual([]);
  });

  it('snapshot diff reports added node and edge after sync', async () => {
    await createProject({
      'src/base.ts': `
export function baseValue(): number {
  return 1;
}
`,
      'src/index.ts': `
import { baseValue } from './base';

export function readBase(): number {
  return baseValue();
}
`,
    });

    const snapshots = snapshotApi(cg!);
    await snapshots.createSnapshot('baseline');

    writeProjectFile('src/new-feature.ts', `
import { baseValue } from './base';

export function newFeature(): number {
  return baseValue() + 1;
}
`);
    await cg!.sync();

    const diff = await snapshots.diffSnapshot('baseline');
    expectSnapshotDiffShape(diff);
    expect(diff.addedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'newFeature', kind: 'function', filePath: 'src/new-feature.ts' }),
    ]));
    expect(diff.addedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls' }),
    ]));
    expect(diff.removedNodes).toEqual([]);
    expect(diff.removedEdges).toEqual([]);
    expect(diff.changedHyperedges).toEqual([]);
    expect(diff.addedHyperedgeMembers).toEqual([]);
  });

  it('snapshot save and diff work on empty initialized project', async () => {
    await createProject({});

    const snapshots = snapshotApi(cg!);
    const saved = await snapshots.createSnapshot('empty', {
      description: 'empty initialized graph',
    });
    const diff = await snapshots.diffSnapshot('empty');

    expect(saved).toMatchObject({
      label: 'empty',
      description: 'empty initialized graph',
      nodeCount: 0,
      edgeCount: 0,
      hyperedgeCount: 0,
      hyperedgeMemberCount: 0,
    });
    expectSnapshotDiffShape(diff);
    expectEmptyDiff(diff);
  });

  it('unchanged re-index produces empty snapshot diff', async () => {
    await createProject({
      'src/index.ts': `
export function stableValue(): number {
  return 42;
}
`,
    });

    const snapshots = snapshotApi(cg!);
    await snapshots.createSnapshot('baseline');
    await cg!.indexAll();

    const diff = await snapshots.diffSnapshot('baseline');
    expectSnapshotDiffShape(diff);
    expectEmptyDiff(diff);
  });

  it('snapshot diff reports hyperedge and member changes', async () => {
    await createProject({
      'src/widget.ts': `
export function registerWidget(): void {
  renderWidget();
}

export function renderWidget(): void {}
`,
    });

    const snapshots = snapshotApi(cg!);
    await snapshots.createSnapshot('baseline');

    const queries = getQueries(cg!);
    const registerWidget = requireNode(queries, 'registerWidget');
    const renderWidget = requireNode(queries, 'renderWidget');
    queries.insertHyperedge({
      id: 'hyperedge:dynamic-dispatch:widget-render',
      kind: 'dynamic_dispatch',
      sourceFile: 'src/widget.ts',
      line: 2,
      column: 2,
      provenance: 'heuristic',
      confidence: 0.9,
      metadata: { channel: 'widget-render' },
      createdAt: 1,
      updatedAt: 1,
    }, [
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: registerWidget.id, role: 'callback', ordinal: 0 },
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1, metadata: { phase: 'paint' } },
    ]);

    const diff = await snapshots.diffSnapshot('baseline');
    expectSnapshotDiffShape(diff);
    expect(diff.addedHyperedges).toEqual([
      expect.objectContaining({
        id: 'hyperedge:dynamic-dispatch:widget-render',
        kind: 'dynamic_dispatch',
        sourceFile: 'src/widget.ts',
        metadata: { channel: 'widget-render' },
      }),
    ]);
    expect(diff.addedHyperedgeMembers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render',
        nodeId: registerWidget.id,
        role: 'callback',
        ordinal: 0,
      }),
      expect.objectContaining({
        hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render',
        nodeId: renderWidget.id,
        role: 'listener',
        ordinal: 1,
        metadata: { phase: 'paint' },
      }),
    ]));
    expect(diff.changedHyperedges).toEqual([]);
    expect(diff.changedHyperedgeMembers).toEqual([]);
  });

  it('diffing a missing snapshot label rejects with a clear error', async () => {
    await createProject({
      'src/index.ts': `
export function present(): boolean {
  return true;
}
`,
    });

    await expect(snapshotApi(cg!).diffSnapshot('missing-label')).rejects.toThrow(
      'Snapshot "missing-label" not found'
    );
  });

  it('MCP snapshot tool creates, lists, and diffs snapshots', async () => {
    await createProject({
      'src/index.ts': `
export function first(): number {
  return 1;
}
`,
    });

    const handler = new ToolHandler(cg!);
    const created = await handler.execute('solidkg_snapshot', { action: 'create', label: 'mcp-baseline' });
    expect(created.isError).not.toBe(true);
    expect(created.content[0]?.text).toContain('mcp-baseline');

    writeProjectFile('src/second.ts', `
export function second(): number {
  return 2;
}
`);
    await cg!.sync();

    const listed = await handler.execute('solidkg_snapshot', { action: 'list' });
    expect(listed.content[0]?.text).toContain('mcp-baseline');
    const diff = await handler.execute('solidkg_snapshot', { action: 'diff', label: 'mcp-baseline' });
    expect(diff.content[0]?.text).toContain('Added nodes:');
    expect(diff.content[0]?.text).toContain('second');
  });

  it('analysis storage round-trips canonical rows and replaces them with a snapshot', async () => {
    await createProject({
      'src/index.ts': 'export const answer = 42;\n',
    });

    const queries = getQueries(cg!);
    const metadata: SnapshotMetadata = {
      label: 'analysis-baseline',
      createdAt: 1,
      nodeCount: 0,
      edgeCount: 0,
      hyperedgeCount: 0,
      hyperedgeMemberCount: 0,
    };
    const analysis = analysisFor(metadata.label);

    snapshotAnalysisQueries(queries).saveSnapshot(metadata, emptySnapshotGraph(), [analysis]);

    expect(snapshotAnalysisQueries(queries).getSnapshotAnalyses(metadata.label)).toEqual([analysis]);

    snapshotAnalysisQueries(queries).saveSnapshot({ ...metadata, createdAt: 2 }, emptySnapshotGraph());

    expect(snapshotAnalysisQueries(queries).getSnapshotAnalyses(metadata.label)).toEqual([]);
  });

  it('stores analyses after every nonempty snapshot graph record family', () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-snapshot-analysis-order-'));
    const connection = DatabaseConnection.initialize(path.join(testDir!, 'solidkg.db'));
    try {
      const db = connection.getDb();
      db.exec(`
        CREATE TRIGGER reject_analysis_before_snapshot_graph
        BEFORE INSERT ON graph_snapshot_analyses
        WHEN
          (SELECT COUNT(*) FROM graph_snapshot_nodes WHERE snapshot_label = NEW.snapshot_label) = 0
          OR (SELECT COUNT(*) FROM graph_snapshot_edges WHERE snapshot_label = NEW.snapshot_label) = 0
          OR (SELECT COUNT(*) FROM graph_snapshot_hyperedges WHERE snapshot_label = NEW.snapshot_label) = 0
          OR (SELECT COUNT(*) FROM graph_snapshot_hyperedge_members WHERE snapshot_label = NEW.snapshot_label) = 0
        BEGIN
          SELECT RAISE(ABORT, 'snapshot analysis inserted before graph rows');
        END;
      `);

      const metadata: SnapshotMetadata = {
        label: 'analysis-after-graph',
        createdAt: 1,
        nodeCount: 1,
        edgeCount: 1,
        hyperedgeCount: 1,
        hyperedgeMemberCount: 1,
      };
      const graph = nonemptySnapshotGraph();
      const analysis = analysisFor(metadata.label);
      const queries = new QueryBuilder(db);

      snapshotAnalysisQueries(queries).saveSnapshot(metadata, graph, [analysis]);

      expect(queries.getSnapshot(metadata.label)).toEqual({ metadata, graph });
      expect(snapshotAnalysisQueries(queries).getSnapshotAnalyses(metadata.label)).toEqual([analysis]);
    } finally {
      connection.close();
    }
  });

  it('analysis storage migrates v10 databases, explicitly deletes children, and preserves legacy snapshots', () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-snapshot-analysis-migration-'));
    const dbPath = path.join(testDir!, 'solidkg.db');
    const seeded = DatabaseConnection.initialize(dbPath);
    try {
      const db = seeded.getDb();
      new QueryBuilder(db).saveSnapshot({
        label: 'legacy', createdAt: 1, nodeCount: 0, edgeCount: 0, hyperedgeCount: 0, hyperedgeMemberCount: 0,
      }, emptySnapshotGraph());
      db.exec(`
        DROP TABLE IF EXISTS graph_snapshot_analyses;
        DELETE FROM schema_versions WHERE version > 10;
        INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
        VALUES (10, strftime('%s', 'now') * 1000, 'v10 snapshot fixture');
      `);
    } finally {
      seeded.close();
    }

    const migrated = DatabaseConnection.open(dbPath);
    try {
      const db = migrated.getDb();
      expect(migrated.getSchemaVersion()?.version).toBe(11);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'graph_snapshot_analyses'").get()).toBeTruthy();

      const queries = new QueryBuilder(db);
      expect(queries.getSnapshot('legacy')?.metadata.label).toBe('legacy');
      expect(snapshotAnalysisQueries(queries).getSnapshotAnalyses('legacy')).toEqual([]);

      snapshotAnalysisQueries(queries).saveSnapshot({
        label: 'delete-me', createdAt: 2, nodeCount: 0, edgeCount: 0, hyperedgeCount: 0, hyperedgeMemberCount: 0,
      }, emptySnapshotGraph(), [analysisFor('delete-me')]);
      expect(queries.deleteSnapshot('delete-me')).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM graph_snapshot_analyses WHERE snapshot_label = ?').get('delete-me')).toEqual({ count: 0 });
    } finally {
      migrated.close();
    }
  });

  it('analysis storage rolls back a failed replacement without changing the prior snapshot', async () => {
    await createProject({});
    const queries = getQueries(cg!);
    const metadata: SnapshotMetadata = {
      label: 'rollback', createdAt: 1, nodeCount: 1, edgeCount: 1, hyperedgeCount: 1, hyperedgeMemberCount: 1,
    };
    const initial = analysisFor(metadata.label);
    const initialGraph = nonemptySnapshotGraph();
    snapshotAnalysisQueries(queries).saveSnapshot(metadata, initialGraph, [initial]);
    const beforeSnapshot = queries.getSnapshot(metadata.label);
    const beforeAnalyses = snapshotAnalysisQueries(queries).getSnapshotAnalyses(metadata.label);

    expect(() => snapshotAnalysisQueries(queries).saveSnapshot(
      { ...metadata, createdAt: 2 },
      nonemptySnapshotGraph(),
      [analysisFor(metadata.label), analysisFor(metadata.label)],
    )).toThrow();

    expect(queries.getSnapshot(metadata.label)).toEqual(beforeSnapshot);
    expect(snapshotAnalysisQueries(queries).getSnapshotAnalyses(metadata.label)).toEqual(beforeAnalyses);
  });

  it('captures health with a snapshot and reports drift for saved or legacy analyses', async () => {
    await createProject({
      'src/index.ts': 'export const answer = 42;\n',
    });

    const options = { layers: [{ name: 'source', paths: ['src/**'] }] };
    const health = cg!.getArchitectureHealth(options);
    expect(health.options).toEqual(normalizeArchitectureHealthOptions(options));

    await cg!.createSnapshot('health-baseline', { architecture: options });
    const analyses = snapshotAnalysisQueries(getQueries(cg!)).getSnapshotAnalyses('health-baseline');
    expect(analyses).toHaveLength(1);
    expect(JSON.parse(analyses[0]!.payloadJson)).toMatchObject({
      options: normalizeArchitectureHealthOptions(options),
      health: { analysisKind: 'architecture_health', analysisVersion: 1 },
    });

    const drift = await cg!.getSnapshotHealthDrift('health-baseline');
    expect(drift.comparisonStatus).toBe('comparable');
    expect(drift.graphDiffCounts).toEqual({
      addedNodes: 0, removedNodes: 0, changedNodes: 0,
      addedEdges: 0, removedEdges: 0, changedEdges: 0,
      addedHyperedges: 0, removedHyperedges: 0, changedHyperedges: 0,
      addedHyperedgeMembers: 0, removedHyperedgeMembers: 0, changedHyperedgeMembers: 0,
    });

    snapshotAnalysisQueries(getQueries(cg!)).saveSnapshot({
      label: 'legacy-health', createdAt: 1, nodeCount: 0, edgeCount: 0, hyperedgeCount: 0, hyperedgeMemberCount: 0,
    }, emptySnapshotGraph());
    await expect(cg!.getSnapshotHealthDrift('legacy-health')).resolves.toMatchObject({
      comparisonStatus: 'baseline_analysis_unavailable',
      reasons: ['baseline_analysis_unavailable'],
    });
  });

  async function createProject(files: Record<string, string>): Promise<void> {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-snapshot-diff-'));
    for (const [relativePath, contents] of Object.entries(files)) {
      writeProjectFile(relativePath, contents);
    }
    cg = SolidKG.initSync(testDir!);
    await cg.indexAll();
  }

  function writeProjectFile(relativePath: string, contents: string): void {
    if (!testDir) throw new Error('Test directory was not created');
    const fullPath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents.trimStart());
  }
});

function snapshotApi(cg: SolidKG): SnapshotSolidKG {
  return cg as unknown as SnapshotSolidKG;
}

function getQueries(cg: SolidKG): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function snapshotAnalysisQueries(queries: QueryBuilder): SnapshotAnalysisQueries {
  return queries as unknown as SnapshotAnalysisQueries;
}

function emptySnapshotGraph(): StoredSnapshotGraph {
  return { nodes: [], edges: [], hyperedges: [], hyperedgeMembers: [] };
}

function nonemptySnapshotGraph(): StoredSnapshotGraph {
  return {
    nodes: [{
      id: 'snapshot-node',
      kind: 'function',
      name: 'snapshotNode',
      qualifiedName: 'snapshotNode',
      filePath: 'src/snapshot.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 12,
    }],
    edges: [{ source: 'snapshot-node', target: 'snapshot-node', kind: 'calls' }],
    hyperedges: [{ id: 'snapshot-hyperedge', kind: 'event_channel' }],
    hyperedgeMembers: [{
      hyperedgeId: 'snapshot-hyperedge',
      nodeId: 'snapshot-node',
      role: 'publisher',
      ordinal: 0,
    }],
  };
}

function analysisFor(snapshotLabel: string): StoredSnapshotAnalysisRow {
  const options = normalizeArchitectureHealthOptions();
  const health = canonicalizeArchitectureHealthReport({
    analysisKind: 'architecture_health',
    analysisVersion: 1,
    options,
    producer: { solidkgVersion: '0.8.0', schemaVersion: 11, graphFactPolicy: 'all_indexed_architecture_edges_v1' },
    observedGraphFacts: {
      edgeKinds: [],
      edgeProvenanceCounts: [],
      scip: { status: 'unavailable', documentCount: 0, occurrenceCount: 0, relationshipCount: 0 },
    },
    metrics: [],
    signals: [],
  });
  return {
    snapshotLabel,
    analysisKind: 'architecture_health',
    analysisVersion: 1,
    optionsJson: canonicalJson(options),
    payloadJson: canonicalJson({
      options,
      architecture: {
        packages: [], layers: [], fileAssignments: [], packageDependencies: [], layerDependencies: [], coupling: { packages: [], layers: [] },
      },
      health,
    }),
  };
}

function requireNode(queries: QueryBuilder, name: string): Node {
  const node = queries.getNodesByName(name)[0];
  if (!node) throw new Error(`Missing node ${name}`);
  return node;
}

function expectSnapshotDiffShape(diff: SnapshotDiff): void {
  expect(Object.keys(diff).sort()).toEqual([
    'addedEdges',
    'addedHyperedgeMembers',
    'addedHyperedges',
    'addedNodes',
    'changedEdges',
    'changedHyperedgeMembers',
    'changedHyperedges',
    'changedNodes',
    'removedEdges',
    'removedHyperedgeMembers',
    'removedHyperedges',
    'removedNodes',
  ]);
}

function expectEmptyDiff(diff: SnapshotDiff): void {
  expect(diff.addedNodes).toEqual([]);
  expect(diff.removedNodes).toEqual([]);
  expect(diff.changedNodes).toEqual([]);
  expect(diff.addedEdges).toEqual([]);
  expect(diff.removedEdges).toEqual([]);
  expect(diff.changedEdges).toEqual([]);
  expect(diff.addedHyperedges).toEqual([]);
  expect(diff.removedHyperedges).toEqual([]);
  expect(diff.changedHyperedges).toEqual([]);
  expect(diff.addedHyperedgeMembers).toEqual([]);
  expect(diff.removedHyperedgeMembers).toEqual([]);
  expect(diff.changedHyperedgeMembers).toEqual([]);
}
