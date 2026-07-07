import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';
import type { Node } from '../src/types';

describe('capability footprint vertical slice', () => {
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

  it('stores config-read assertions with coverage and removes stale facts after sync', async () => {
    await createProject(`
export function readConfig(): string {
  const token = process.env.API_TOKEN;
  return token ?? '';
}
`);

    const queries = getQueries(cg!);
    const readConfig = requireNode(queries, 'readConfig');

    const assertions = queries.getCapabilityAssertionsByNodeIds([readConfig.id]);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({
      subjectNodeId: readConfig.id,
      operation: 'read',
      resourceKind: 'config',
      resourceKey: 'API_TOKEN',
      scope: 'node_scoped',
      filePath: 'src/widget.ts',
      origin: 'ast',
      certainty: 'static',
      producerId: 'solidkg.config-read',
      ruleId: 'typescript.process-env',
    });

    const coverage = queries.getCapabilityAnalysisRuns(['src/widget.ts']);
    expect(coverage).toMatchObject([
      {
        filePath: 'src/widget.ts',
        producerId: 'solidkg.config-read',
        status: 'complete',
      },
    ]);

    fs.writeFileSync(path.join(testDir!, 'src', 'widget.ts'), `
export function readConfig(): string {
  return 'no config read now';
}
`);

    await cg!.sync();
    const updatedNode = requireNode(queries, 'readConfig');
    expect(queries.getCapabilityAssertionsByNodeIds([updatedNode.id])).toEqual([]);
    expect(queries.getCapabilityAnalysisRuns(['src/widget.ts'])[0]).toMatchObject({
      filePath: 'src/widget.ts',
      status: 'complete',
    });
  });

  it('ignores config-read text inside comments and string literals while still reporting coverage', async () => {
    await createProject(`
export function documentedOnly(): string {
  // process.env.COMMENT_ONLY should not become a footprint.
  const example = "process.env.STRING_ONLY";
  return example;
}
`);

    const queries = getQueries(cg!);
    const documentedOnly = requireNode(queries, 'documentedOnly');
    expect(queries.getCapabilityAssertionsByNodeIds([documentedOnly.id])).toEqual([]);

    const nodeText = await executeTool('solidkg_node', { symbol: 'documentedOnly', includeCode: false });
    expect(nodeText).toContain('### Capability footprint (solidkg.capability-footprint.v1)');
    expect(nodeText).toContain('Coverage for src/widget.ts: complete');
    expect(nodeText).toContain('No capability assertions returned for this symbol.');
    expect(nodeText).not.toContain('COMMENT_ONLY');
    expect(nodeText).not.toContain('STRING_ONLY');
  });

  it('surfaces per-hop capability evidence, may-footprint aggregate, and hyperedge projections in MCP trace and node', async () => {
    await createProject(`
export function boot(): string {
  return readConfig();
}

export function readConfig(): string {
  return process.env.API_TOKEN ?? '';
}

export function emitWidget(): void {}
export function renderWidget(): void {}
`);

    const queries = getQueries(cg!);
    const emitWidget = requireNode(queries, 'emitWidget');
    const renderWidget = requireNode(queries, 'renderWidget');
    queries.insertHyperedge({
      id: 'hyperedge:event-channel:widget-render',
      kind: 'event_channel',
      sourceFile: 'src/widget.ts',
      line: 8,
      column: 1,
      provenance: 'heuristic',
      confidence: 0.8,
      metadata: { event: 'widget-render' },
      createdAt: 2,
      updatedAt: 2,
    }, [
      { hyperedgeId: 'hyperedge:event-channel:widget-render', nodeId: emitWidget.id, role: 'emitter', ordinal: 0 },
      { hyperedgeId: 'hyperedge:event-channel:widget-render', nodeId: renderWidget.id, role: 'listener', ordinal: 1 },
    ]);

    const traceText = await executeTool('solidkg_trace', { from: 'boot', to: 'readConfig' });
    expect(traceText).toContain('### Capability footprint (solidkg.capability-footprint.v1)');
    expect(traceText).toContain('read config `API_TOKEN`');
    expect(traceText).toContain('May-footprint aggregate');
    expect(traceText).toContain('coverage: complete');

    const nodeText = await executeTool('solidkg_node', { symbol: 'emitWidget', includeCode: false });
    expect(nodeText).toContain('### Capability footprint (solidkg.capability-footprint.v1)');
    expect(nodeText).toContain('emit channel `widget-render`');
    expect(nodeText).toContain('origin: semantic_synthesis');
    expect(nodeText).toContain('scope: relation_scoped');
    expect(nodeText).toContain('### Semantic relations');
  });

  it('does not include neighboring hyperedge projections in trace footprints', async () => {
    await createProject(`
export function boot(): string {
  return readConfig();
}

export function readConfig(): string {
  return process.env.API_TOKEN ?? '';
}

export function listener(): void {}
`);

    const queries = getQueries(cg!);
    const readConfig = requireNode(queries, 'readConfig');
    const listener = requireNode(queries, 'listener');
    queries.insertHyperedge({
      id: 'hyperedge:event-channel:off-path',
      kind: 'event_channel',
      sourceFile: 'src/widget.ts',
      line: 8,
      column: 1,
      provenance: 'heuristic',
      confidence: 0.8,
      metadata: { event: 'off-path-event' },
      createdAt: 2,
      updatedAt: 2,
    }, [
      { hyperedgeId: 'hyperedge:event-channel:off-path', nodeId: readConfig.id, role: 'emitter', ordinal: 0 },
      { hyperedgeId: 'hyperedge:event-channel:off-path', nodeId: listener.id, role: 'listener', ordinal: 1 },
    ]);

    const traceText = await executeTool('solidkg_trace', { from: 'boot', to: 'readConfig' });
    expect(traceText).toContain('read config `API_TOKEN`');
    expect(traceText).not.toContain('off-path-event');

    const nodeText = await executeTool('solidkg_node', { symbol: 'readConfig', includeCode: false });
    expect(nodeText).toContain('emit channel `off-path-event`');
  });

  it('does not project generic route middleware as auth guards', async () => {
    await createProject(`
export function handler(): void {}
export function logMiddleware(): void {}
export function authMiddleware(): void {}
`);

    const queries = getQueries(cg!);
    const handler = requireNode(queries, 'handler');
    const logMiddleware = requireNode(queries, 'logMiddleware');
    const authMiddleware = requireNode(queries, 'authMiddleware');
    queries.insertHyperedge({
      id: 'hyperedge:route:generic-log',
      kind: 'route_binding',
      sourceFile: 'src/widget.ts',
      line: 1,
      column: 1,
      provenance: 'heuristic',
      confidence: 0.8,
      metadata: { method: 'GET', path: '/widgets' },
      createdAt: 2,
      updatedAt: 2,
    }, [
      { hyperedgeId: 'hyperedge:route:generic-log', nodeId: logMiddleware.id, role: 'middleware', ordinal: 0 },
      { hyperedgeId: 'hyperedge:route:generic-log', nodeId: handler.id, role: 'handler', ordinal: 1 },
    ]);
    queries.insertHyperedge({
      id: 'hyperedge:route:auth',
      kind: 'route_binding',
      sourceFile: 'src/widget.ts',
      line: 2,
      column: 1,
      provenance: 'heuristic',
      confidence: 0.8,
      metadata: { method: 'GET', path: '/admin' },
      createdAt: 2,
      updatedAt: 2,
    }, [
      { hyperedgeId: 'hyperedge:route:auth', nodeId: authMiddleware.id, role: 'middleware', ordinal: 0 },
      { hyperedgeId: 'hyperedge:route:auth', nodeId: handler.id, role: 'handler', ordinal: 1 },
    ]);

    const logText = await executeTool('solidkg_node', { symbol: 'logMiddleware', includeCode: false });
    expect(logText).not.toContain('guard auth');

    const authText = await executeTool('solidkg_node', { symbol: 'authMiddleware', includeCode: false });
    expect(authText).toContain('guard auth `/admin`');
  });

  async function createProject(source: string): Promise<void> {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-capabilities-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'widget.ts'), source.trimStart());
    cg = SolidKG.initSync(testDir);
    await cg.indexAll();
  }

  async function executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const handler = new ToolHandler(cg!);
    try {
      const result = await handler.execute(toolName, args);
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
