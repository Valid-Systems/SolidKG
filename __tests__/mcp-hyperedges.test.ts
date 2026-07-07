import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';
import type { Node } from '../src/types';

describe('MCP context semantic hyperedges', () => {
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

  it('solidkg_context includes Semantic Relations with relation members', async () => {
    await createProject(`
export function registerCallback(): void {
  renderWidget();
}

export function renderWidget(): void {}

export function nativeRenderWidget(): void {}
`);

    const queries = getQueries(cg!);
    const registerCallback = requireNode(queries, 'registerCallback');
    const renderWidget = requireNode(queries, 'renderWidget');
    const nativeRenderWidget = requireNode(queries, 'nativeRenderWidget');

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
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: registerCallback.id, role: 'callback', ordinal: 0 },
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1 },
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: nativeRenderWidget.id, role: 'native_implementation', ordinal: 2 },
    ]);

    const markdown = await cg!.buildContext('registerCallback renderWidget', {
      format: 'markdown',
      includeCode: false,
      maxNodes: 4,
      searchLimit: 2,
      traversalDepth: 0,
    }) as string;

    expect(markdown).toContain('### Semantic Relations');
    expect(markdown).toContain('**dynamic_dispatch** - src/widget.ts:2');
    expect(markdown).toContain('callback: registerCallback (src/widget.ts:1)');
    expect(markdown).toContain('listener: renderWidget (src/widget.ts:5)');
    expect(markdown).toContain('native_implementation: nativeRenderWidget (src/widget.ts:7)');

    const json = await cg!.buildContext('registerCallback renderWidget', {
      format: 'json',
      includeCode: false,
      maxNodes: 4,
      searchLimit: 2,
      traversalDepth: 0,
    }) as string;
    const parsed = JSON.parse(json) as {
      nodes: Array<{ name: string }>;
      hyperedges: Array<{ hyperedge: { kind: string }; members: Array<{ role: string; node: { name: string } }> }>;
    };

    expect(parsed.nodes.length).toBeLessThanOrEqual(4);
    expect(parsed.nodes.map((node) => node.name)).toContain('nativeRenderWidget');
    expect(parsed.hyperedges).toHaveLength(1);
    expect(parsed.hyperedges[0]!.hyperedge).toMatchObject({ kind: 'dynamic_dispatch' });
    expect(parsed.hyperedges[0]!.members.map((member) => [member.role, member.node.name])).toEqual([
      ['callback', 'registerCallback'],
      ['listener', 'renderWidget'],
      ['native_implementation', 'nativeRenderWidget'],
    ]);
  });

  it('context omits Semantic Relations when none exist', async () => {
    await createProject(`
export function calculateTotal(): number {
  return 42;
}
`);

    const markdown = await cg!.buildContext('calculateTotal', {
      format: 'markdown',
      includeCode: false,
    }) as string;

    expect(markdown).not.toContain('### Semantic Relations');

    const json = await cg!.buildContext('calculateTotal', {
      format: 'json',
      includeCode: false,
    }) as string;
    const parsed = JSON.parse(json) as { hyperedges: unknown[] };
    expect(parsed.hyperedges).toEqual([]);
  });

  it('solidkg_node includes semantic relations', async () => {
    await createProject(`
export function registerCallback(): void {
  renderWidget();
}

export function renderWidget(): void {}

export function nativeRenderWidget(): void {}

export function auditWidget(): void {}
export function measureWidget(): void {}
export function paintWidget(): void {}
export function queueWidget(): void {}
export function reconcileWidget(): void {}
export function scheduleWidget(): void {}
`);

    const queries = getQueries(cg!);
    const registerCallback = requireNode(queries, 'registerCallback');
    const memberNames = [
      'renderWidget',
      'nativeRenderWidget',
      'auditWidget',
      'measureWidget',
      'paintWidget',
      'queueWidget',
      'reconcileWidget',
      'scheduleWidget',
    ];
    const members = [
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: registerCallback.id, role: 'callback', ordinal: 0 },
      ...memberNames.map((name, index) => ({
        hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render',
        nodeId: requireNode(queries, name).id,
        role: index === 0 ? 'listener' : 'target',
        ordinal: index + 1,
      })),
    ];

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
    }, members);

    expect(cg!.getHyperedgesByNode(registerCallback.id)).toHaveLength(1);
    expect(cg!.findHyperedgesBetweenNodes([registerCallback.id, requireNode(queries, 'renderWidget').id], ['dynamic_dispatch'])).toHaveLength(1);

    const text = await executeNodeTool('registerCallback');

    expect(text).toContain('### Semantic relations');
    expect(text).toContain('**dynamic_dispatch** `widget-render`');
    expect(text).toContain('this node role: callback');
    expect(text).toContain('callback: registerCallback (function, src/widget.ts:1)');
    expect(text).toContain('listener: renderWidget (function, src/widget.ts:5)');
    expect(text).toContain('+1 more members');
    expect(text).toContain('### Trail');
  });

  it('solidkg_node omits semantic relations for unrelated node', async () => {
    await createProject(`
export function registerCallback(): void {
  renderWidget();
}

export function renderWidget(): void {}

export function unrelatedNode(): void {}
`);

    const queries = getQueries(cg!);
    const registerCallback = requireNode(queries, 'registerCallback');
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
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: registerCallback.id, role: 'callback', ordinal: 0 },
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1 },
    ]);

    const text = await executeNodeTool('unrelatedNode');

    expect(text).toContain('## unrelatedNode (function)');
    expect(text).toContain('**Location:** src/widget.ts:7');
    expect(text).not.toContain('### Semantic relations');
    expect(text).not.toContain('widget-render');
  });
  it('solidkg_status includes hyperedge stats', async () => {
    await createProject(`
export function registerCallback(): void {
  renderWidget();
}

export function renderWidget(): void {}

export function emitWidget(): void {}
`);

    const emptyStatusText = await executeStatusTool();
    expect(emptyStatusText).toContain('**Total hyperedges:** 0');
    expect(emptyStatusText).not.toContain('### Hyperedges by Kind:');

    const queries = getQueries(cg!);
    const registerCallback = requireNode(queries, 'registerCallback');
    const renderWidget = requireNode(queries, 'renderWidget');
    const emitWidget = requireNode(queries, 'emitWidget');

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
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: registerCallback.id, role: 'callback', ordinal: 0 },
      { hyperedgeId: 'hyperedge:dynamic-dispatch:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1 },
    ]);
    queries.insertHyperedge({
      id: 'hyperedge:event-channel:widget-render',
      kind: 'event_channel',
      sourceFile: 'src/widget.ts',
      line: 7,
      column: 2,
      provenance: 'heuristic',
      confidence: 0.8,
      metadata: { event: 'widget-render' },
      createdAt: 2,
      updatedAt: 2,
    }, [
      { hyperedgeId: 'hyperedge:event-channel:widget-render', nodeId: emitWidget.id, role: 'emitter', ordinal: 0 },
      { hyperedgeId: 'hyperedge:event-channel:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1 },
    ]);

    const text = await executeStatusTool();

    expect(text).toContain('**Total nodes:**');
    expect(text).toContain('**Total edges:**');
    expect(text).toContain('**Total hyperedges:** 2');
    expect(text).toContain('### Nodes by Kind:');
    expect(text).toContain('### Hyperedges by Kind:');
    expect(text).toContain('- dynamic_dispatch: 1');
    expect(text).toContain('- event_channel: 1');
    expect(text.indexOf('- dynamic_dispatch: 1')).toBeLessThan(text.indexOf('- event_channel: 1'));
    expect(text.indexOf('### Hyperedges by Kind:')).toBeGreaterThan(text.indexOf('### Nodes by Kind:'));
    expect(text.indexOf('### Hyperedges by Kind:')).toBeLessThan(text.indexOf('### Languages:'));
    expect(text).not.toContain('### Pending sync:');
  });

  async function createProject(source: string): Promise<void> {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-context-hyperedges-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'widget.ts'), source.trimStart());
    cg = SolidKG.initSync(testDir);
    await cg.indexAll();
  }

  async function executeNodeTool(symbol: string): Promise<string> {
    const handler = new ToolHandler(cg!);
    try {
      const result = await handler.execute('solidkg_node', { symbol, includeCode: false });
      return result.content[0]?.type === 'text' ? result.content[0].text : '';
    } finally {
      handler.closeAll();
    }
  }
  async function executeStatusTool(): Promise<string> {
    const handler = new ToolHandler(cg!);
    try {
      const result = await handler.execute('solidkg_status', {});
      return result.content[0]?.type === 'text' ? result.content[0].text : '';
    } finally {
      handler.closeAll();
    }
  }
});

function getQueries(cg: SolidKG): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function requireNode(queries: QueryBuilder, name: string): Node {
  const node = queries.getNodesByName(name)[0];
  if (!node) throw new Error(`Missing node ${name}`);
  return node;
}
