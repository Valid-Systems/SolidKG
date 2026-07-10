/**
 * SOLIDKG_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Unset uses the
 * compact explore-only profile; `all` restores the complete advanced surface.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, tools } from '../src/mcp/tools';
import SolidKG from '../src/index';

const ENV = 'SOLIDKG_MCP_TOOLS';

describe('SOLIDKG_MCP_TOOLS allowlist', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('exposes only explore when unset', () => {
    delete process.env[ENV];
    expect(listed()).toEqual(['solidkg_explore']);
  });

  it('restores the full advanced surface when all is requested', () => {
    process.env[ENV] = 'all';
    const all = listed();
    expect(all).toContain('solidkg_explore');
    expect(all).toContain('solidkg_context');
    expect(all).toContain('solidkg_trace');
    expect(all.length).toBe(tools.length);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[ENV] = 'trace,search,node';
    expect(listed()).toEqual(['solidkg_node', 'solidkg_search', 'solidkg_trace']);
  });

  it('keeps context as the only tool when context is allowlisted', () => {
    process.env[ENV] = 'context';
    expect(listed()).toEqual(['solidkg_context']);
  });

  it('accepts fully-qualified solidkg_ names and ignores whitespace', () => {
    process.env[ENV] = ' solidkg_trace , search ';
    expect(listed()).toEqual(['solidkg_search', 'solidkg_trace']);
  });

  it('treats an empty/whitespace value as the compact default', () => {
    process.env[ENV] = '   ';
    expect(listed()).toEqual(['solidkg_explore']);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'trace';
    const res = await new ToolHandler(null).execute('solidkg_explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled via SOLIDKG_MCP_TOOLS/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No SolidKG attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('solidkg_search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled via SOLIDKG_MCP_TOOLS/);
  });

  it('keeps hidden advanced tools callable for cached clients under the compact default', async () => {
    delete process.env[ENV];
    const res = await new ToolHandler(null).execute('solidkg_search', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toMatch(/disabled via SOLIDKG_MCP_TOOLS/);
    expect(res.content[0].text).toMatch(/No SolidKG project is loaded/);
  });
});

describe('MCP raw tool names', () => {
  const documentedToolNames = [
    'solidkg_architecture',
    'solidkg_callers',
    'solidkg_callees',
    'solidkg_context',
    'solidkg_explore',
    'solidkg_files',
    'solidkg_impact',
    'solidkg_node',
    'solidkg_precise_refs',
    'solidkg_search',
    'solidkg_snapshot',
    'solidkg_status',
    'solidkg_trace',
  ].sort();

  it('publishes each documented solidkg_* server tool name exactly once', () => {
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(documentedToolNames);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not double-prefix raw server tool names', () => {
    process.env[ENV] = 'all';
    const names = new ToolHandler(null).getTools().map((tool) => tool.name);
    expect(names.every((name) => name.startsWith('solidkg_'))).toBe(true);
    expect(names.some((name) => name.startsWith('solidkg_solidkg_'))).toBe(false);
  });

  it('publishes detailLevel on the existing context tool schema', () => {
    const contextTool = tools.find((tool) => tool.name === 'solidkg_context');
    expect(contextTool?.inputSchema.properties).toMatchObject({
      detailLevel: {
        type: 'string',
        enum: ['standard', 'minimal'],
        default: 'standard',
      },
    });
    expect(contextTool?.inputSchema.required).toEqual(['task']);
  });

  it('publishes overview options on the existing files tool schema', () => {
    const filesTool = tools.find((tool) => tool.name === 'solidkg_files');
    expect(filesTool?.inputSchema.properties).toMatchObject({
      format: {
        type: 'string',
        enum: ['tree', 'flat', 'grouped', 'overview'],
        default: 'tree',
      },
      expandPaths: {
        type: 'array',
        items: { type: 'string' },
      },
      maxEntries: {
        type: 'number',
      },
    });
    expect(filesTool?.inputSchema.properties.expandPaths.description).toContain('max 50 paths');
  });

  it('describes explore as the natural-language answer surface without prerequisite tools', () => {
    const exploreTool = tools.find((tool) => tool.name === 'solidkg_explore');

    expect(exploreTool?.description).toContain('natural-language question');
    expect(exploreTool?.description).toContain('ONE answer-producing call');
    expect(exploreTool?.description).not.toContain('Use it after solidkg_context');
    expect(exploreTool?.description).not.toContain('run solidkg_search first');
  });

  it('keeps dataDir discoverable when dynamic stats are unavailable', () => {
    process.env[ENV] = 'all';
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-tools-schema-'));
    const cg = SolidKG.initSync(testDir);
    const statsSpy = vi.spyOn(cg, 'getStats').mockImplementation(() => {
      throw new Error('stats unavailable');
    });

    try {
      const contextTool = new ToolHandler(cg).getTools().find((tool) => tool.name === 'solidkg_context');

      expect(contextTool?.inputSchema.properties).toMatchObject({
        projectPath: { type: 'string' },
        dataDir: { type: 'string' },
      });
    } finally {
      statsSpy.mockRestore();
      cg.destroy();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
