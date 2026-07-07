import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('agent-facing graph traversal packet output', () => {
  let testDir: string | undefined;
  let graph: SolidKG | undefined;

  afterEach(() => {
    graph?.destroy();
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    graph = undefined;
    testDir = undefined;
  });

  it('enriches existing callers output with compact bounded graph metadata', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-adjacency-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        'export function leaf(): string { return "ok"; }',
        'export function callerA(): string { return leaf(); }',
        'export function callerB(): string { return leaf(); }',
      ].join('\n'),
    );
    graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('solidkg_callers', { symbol: 'leaf', limit: 1 });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('## Callers of leaf (1 shown, 2 found)');
    expect(text).toContain('### Graph Traversal Packet');
    expect(text).toContain('- Coverage: partial');
    expect(text).toContain('- Limits hit: result_limit');
    expect(text).toContain('- calls: 2');
  });

  it('includes graph traversal packet metadata for empty callees output', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-adjacency-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        'export function leaf(): string { return "ok"; }',
        'export function caller(): string { return leaf(); }',
      ].join('\n'),
    );
    graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('solidkg_callees', { symbol: 'leaf', limit: 5 });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('No callees found for "leaf"');
    expect(text).toContain('### Graph Traversal Packet');
    expect(text).toContain('- Coverage: absent');
  });

  it('reports bounded impact packet coverage instead of unconditional complete coverage', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-adjacency-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        'export function leaf(): string { return "ok"; }',
        'export function callerA(): string { return leaf(); }',
        'export function callerB(): string { return callerA(); }',
      ].join('\n'),
    );
    graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('solidkg_impact', { symbol: 'leaf', depth: 1 });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('### Graph Traversal Packet');
    expect(text).toContain('- Coverage: partial');
    expect(text).toContain('- Limits hit: maxDepth');
  });
});
