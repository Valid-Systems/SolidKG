import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';
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

  async function createProject(files: Record<string, string>): Promise<void> {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-snapshot-diff-'));
    for (const [relativePath, contents] of Object.entries(files)) {
      writeProjectFile(relativePath, contents);
    }
    cg = SolidKG.initSync(testDir);
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
