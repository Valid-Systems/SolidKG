import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';

type SqliteDb = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

describe('selective local-flow augmentation', () => {
  let testDir: string;
  let cg: SolidKG | null;
  let handler: ToolHandler | null;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-selective-dataflow-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    cg = null;
    handler = null;
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('surfaces the measured canvasNonce JSX prop handoff on the render flow', async () => {
    writeApp(`
import React from 'react';

export class App extends React.Component<any, any> {
  mutateElement(): void {
    this.setState({ canvasNonce: Date.now() });
  }

  render() {
    const canvasNonce = this.state.canvasNonce;
    return <StaticCanvas canvasNonce={canvasNonce} color="red" />;
  }
}

export function StaticCanvas(props: any) {
  return renderStaticScene(props.canvasNonce);
}

export function renderStaticScene(value: unknown) {
  return value;
}
`);

    cg = SolidKG.initSync(testDir, { includePatterns: ['src/**/*.tsx'], excludePatterns: [] });
    await cg.indexAll();

    const mutateElement = requireNode('mutateElement', 'method');
    const renderStaticScene = requireNode('renderStaticScene', 'function');
    const renderPath = cg.findPath(mutateElement.id, renderStaticScene.id, ['calls']);
    expect(renderPath?.map((step) => step.node.name)).toEqual([
      'mutateElement',
      'render',
      'StaticCanvas',
      'renderStaticScene',
    ]);

    const jsxEdge = requireJsxEdge(renderPath);
    const localFlow = jsxEdge.metadata?.localFlow as Record<string, unknown> | undefined;
    expect(localFlow).toMatchObject({
      kind: 'jsx-prop-handoff',
      props: ['canvasNonce'],
      complete: false,
      confidence: 0.55,
      capped: false,
    });
    expect(String(localFlow?.uncertainty)).toContain('selected nonce-like JSX prop handoff only');
    expect(jsxEdge.metadata?.registeredAt).toMatch(/src[\\/]App\.tsx:\d+/);

    const hyperedgeRows = db()
      .prepare(
        `SELECT metadata FROM hyperedges
         WHERE kind='ui_render'
           AND json_extract(metadata,'$.synthesizedBy')='jsx-render'
           AND json_extract(metadata,'$.localFlow.kind')='jsx-prop-handoff'`
      )
      .all() as Array<{ metadata: string }>;
    expect(hyperedgeRows).toHaveLength(1);
    const hyperedgeMetadata = JSON.parse(hyperedgeRows[0]!.metadata) as Record<string, unknown>;
    expect((hyperedgeMetadata.localFlow as Record<string, unknown>).props).toEqual(['canvasNonce']);

    handler = new ToolHandler(cg);
    const trace = await handler.execute('solidkg_trace', { from: 'mutateElement', to: 'renderStaticScene' });
    const text = trace.content?.[0]?.text ?? '';
    expect(text).toContain('local prop handoff `canvasNonce`');
    expect(text).toContain('heuristic incomplete, confidence 0.55');
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('Blockers: none');
    expect(text).toContain('answer_from_returned_evidence');
    expect(text).not.toContain('requires_focused_follow_up');
    expect(text).toContain('heuristic_edge');
    expect(text).not.toContain('safe_to_edit');
    expect(text).not.toContain('safe_to_review');
    expect(text).not.toContain('Suggested next SolidKG tools: solidkg_node');
  });

  it('caps nonce handoff metadata without creating local dataflow nodes or edge fan-out', async () => {
    writeApp(`
import React from 'react';

export class App extends React.Component<any, any> {
  mutateElement(): void {
    this.setState({ canvasNonce: Date.now() });
  }

  render() {
    return (
      <StaticCanvas
        canvasNonce={this.state.canvasNonce}
        paintNonce={this.state.paintNonce}
        layoutNonce={this.state.layoutNonce}
        exportNonce={this.state.exportNonce}
        historyNonce={this.state.historyNonce}
        cursorNonce={this.state.cursorNonce}
        color="red"
      />
    );
  }
}

export function StaticCanvas(props: any) {
  return renderStaticScene(props.canvasNonce);
}

export function renderStaticScene(value: unknown) {
  return value;
}
`);

    cg = SolidKG.initSync(testDir, { includePatterns: ['src/**/*.tsx'], excludePatterns: [] });
    const result = await cg.indexAll();
    expect(result.success).toBe(true);

    const counts = db().prepare(
      `SELECT
         (SELECT COUNT(*) FROM nodes) AS nodes,
         (SELECT COUNT(*) FROM edges) AS edges,
         (SELECT COUNT(*) FROM hyperedges) AS hyperedges`
    ).get() as { nodes: number; edges: number; hyperedges: number };
    expect(counts.nodes).toBeLessThanOrEqual(20);
    expect(counts.edges).toBeLessThanOrEqual(35);
    expect(counts.hyperedges).toBeLessThanOrEqual(3);

    const nonceNodeCount = db()
      .prepare(
        `SELECT COUNT(*) AS count FROM nodes
         WHERE kind IN ('variable','constant','property','field','parameter')
           AND name IN ('canvasNonce','paintNonce','layoutNonce','exportNonce','historyNonce','cursorNonce')`
      )
      .get() as { count: number };
    expect(nonceNodeCount.count).toBe(0);

    const edgeRows = db()
      .prepare(
        `SELECT metadata FROM edges
         WHERE provenance='heuristic'
           AND json_extract(metadata,'$.synthesizedBy')='jsx-render'
           AND json_extract(metadata,'$.via')='StaticCanvas'`
      )
      .all() as Array<{ metadata: string }>;
    expect(edgeRows).toHaveLength(1);
    const metadata = JSON.parse(edgeRows[0]!.metadata) as Record<string, unknown>;
    const localFlow = metadata.localFlow as Record<string, unknown>;
    expect(localFlow.props).toEqual(['canvasNonce', 'paintNonce', 'layoutNonce', 'exportNonce']);
    expect(localFlow.capped).toBe(true);

    const jsxEdgeCount = db()
      .prepare("SELECT COUNT(*) AS count FROM edges WHERE json_extract(metadata,'$.synthesizedBy')='jsx-render'")
      .get() as { count: number };
    expect(jsxEdgeCount.count).toBe(1);
  });

  function writeApp(source: string): void {
    fs.writeFileSync(path.join(testDir, 'src', 'App.tsx'), source.trimStart());
  }

  function db(): SqliteDb {
    return (cg as unknown as { db: { db: SqliteDb } }).db.db;
  }

  function requireNode(name: string, kind: Node['kind']): Node {
    const node = cg?.getNodesByKind(kind).find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Missing ${kind} node ${name}`);
    return node;
  }

  function requireJsxEdge(renderPath: Array<{ node: Node; edge: Edge | null }> | null | undefined): Edge {
    const edge = renderPath
      ?.map((step) => step.edge)
      .find((candidate): candidate is Edge => candidate?.metadata?.synthesizedBy === 'jsx-render');
    if (!edge) throw new Error('Missing jsx-render edge in render path');
    return edge;
  }
});
