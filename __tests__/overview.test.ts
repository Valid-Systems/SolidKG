import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { buildOverviewTree, formatOverviewTree } from '../src/overview';
import type { FileRecord, Node } from '../src/types';

function file(path: string, language: FileRecord['language'], nodeCount: number): FileRecord {
  return {
    path,
    language,
    nodeCount,
    contentHash: `hash:${path}`,
    size: 10,
    modifiedAt: 1,
    indexedAt: 2,
  };
}

function symbol(id: string, filePath: string, kind: Node['kind'], name: string, startLine: number, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine,
    endLine: startLine,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('overview tree', () => {
  it('builds deterministic rollups from indexed files and symbols', () => {
    const tree = buildOverviewTree({
      files: [
        file('src/api/routes.ts', 'typescript', 2),
        file('src/ui/App.tsx', 'tsx', 3),
        file('README.md', 'unknown', 0),
      ],
      nodes: [
        symbol('route', 'src/api/routes.ts', 'route', 'GET /widgets', 3),
        symbol('component', 'src/ui/App.tsx', 'component', 'App', 1),
      ],
      architectureAssignments: [
        { filePath: 'src/api/routes.ts', packageName: 'solidkg', layerName: 'api' },
        { filePath: 'src/ui/App.tsx', packageName: 'solidkg', layerName: 'ui' },
      ],
    });

    expect(tree.totalFiles).toBe(3);
    expect(tree.totalSymbols).toBe(5);
    expect(tree.root.children.map((child) => child.path)).toEqual(['src', 'README.md']);
    expect(tree.root.languages).toEqual([
      { language: 'tsx', fileCount: 1 },
      { language: 'typescript', fileCount: 1 },
      { language: 'unknown', fileCount: 1 },
    ]);
    expect(tree.root.nodeKinds).toEqual([
      { kind: 'component', count: 1 },
      { kind: 'route', count: 1 },
    ]);
    expect(tree.root.architecture).toEqual({ packages: ['solidkg'], layers: ['api', 'ui'] });
  });

  it('renders a budgeted progressive overview with explicit expansion', () => {
    const tree = buildOverviewTree({
      files: [
        file('src/api/routes.ts', 'typescript', 2),
        file('src/api/service.ts', 'typescript', 4),
        file('src/ui/App.tsx', 'tsx', 3),
        file('tests/api.test.ts', 'typescript', 1),
      ],
      nodes: [
        symbol('route', 'src/api/routes.ts', 'route', 'GET /widgets', 3),
        symbol('service', 'src/api/service.ts', 'class', 'WidgetService', 1),
      ],
    });

    const collapsed = formatOverviewTree(tree, { maxDepth: 1 });
    expect(collapsed).toContain('src/');
    expect(collapsed).toContain('collapsed');
    expect(collapsed).not.toContain('routes.ts');

    const expanded = formatOverviewTree(tree, { maxDepth: 1, expandPaths: ['src/api'] });
    expect(expanded).toContain('api/');
    expect(expanded).toContain('routes.ts');
    expect(expanded).toContain('anchors: GET /widgets');
  });

  it('uses conservative anchors by deduplicating repeated names and preferring public graph facts', () => {
    const tree = buildOverviewTree({
      files: [
        file('src/api/routes.ts', 'typescript', 4),
        file('src/api/duplicate.ts', 'typescript', 4),
        file('src/internal/temp.ts', 'typescript', 4),
      ],
      nodes: [
        symbol('route', 'src/api/routes.ts', 'route', 'GET /widgets', 1, { isExported: true }),
        symbol('duplicate-route', 'src/api/duplicate.ts', 'route', 'GET /widgets', 1, { isExported: true }),
        symbol('service', 'src/api/routes.ts', 'class', 'WidgetService', 2, { visibility: 'public' }),
        symbol('private-helper', 'src/internal/temp.ts', 'function', '_', 3),
        symbol('short-helper', 'src/internal/temp.ts', 'function', 'e', 4),
      ],
    });

    expect(tree.root.notableSymbols.map((entry) => entry.name)).toEqual(['GET /widgets', 'WidgetService']);
    const rendered = formatOverviewTree(tree, { maxDepth: 2 });
    const rootLine = rendered.split('\n').find((line) => line.startsWith('. —')) ?? '';
    expect(rootLine).not.toContain('anchors:');
    expect(rendered).toContain('anchors: GET /widgets, WidgetService');
    expect(rendered).not.toContain('GET /widgets, GET /widgets');
    expect(rendered).not.toContain('anchors: _, e');
  });

  it('suppresses anchors on huge aggregate directories while keeping focused child anchors', () => {
    const files = Array.from({ length: 101 }, (_, index) => file(`src/feature-${index}.ts`, 'typescript', 1));
    const tree = buildOverviewTree({
      files: [file('cli/main.ts', 'typescript', 2), ...files],
      nodes: [
        symbol('root-noise', 'src/feature-1.ts', 'component', 'Counter', 1, { isExported: true }),
        symbol('cli-entry', 'cli/main.ts', 'function', 'runCli', 1, { isExported: true }),
      ],
    });

    const rendered = formatOverviewTree(tree, { maxDepth: 2 });
    const rootLine = rendered.split('\n').find((line) => line.startsWith('. —')) ?? '';
    const srcLine = rendered.split('\n').find((line) => line.includes('src/')) ?? '';
    expect(rootLine).not.toContain('anchors:');
    expect(srcLine).not.toContain('anchors:');
    expect(rendered).toContain('cli/');
    expect(rendered).toContain('anchors: runCli');
  });

  it('focuses and filters without re-scanning the filesystem', () => {
    const tree = buildOverviewTree({
      files: [
        file('src/api/routes.ts', 'typescript', 2),
        file('src/ui/App.tsx', 'tsx', 3),
        file('docs/guide.md', 'unknown', 0),
      ],
    }, { path: 'src', pattern: '**/*.ts' });

    expect(tree.root.path).toBe('src');
    expect(tree.totalFiles).toBe(1);
    expect(formatOverviewTree(tree)).toContain('routes.ts');
    expect(formatOverviewTree(tree)).not.toContain('App.tsx');
  });

  it('uses root-aware path focus for source-root-labeled files', () => {
    const tree = buildOverviewTree({
      files: [
        file('@app/src/service.ts', 'typescript', 6),
        file('@app/tests/service.test.ts', 'typescript', 2),
      ],
      nodes: [
        symbol('service', '@app/src/service.ts', 'class', 'Service', 1),
        symbol('test', '@app/tests/service.test.ts', 'function', 'testService', 1),
      ],
    }, { path: 'src' });

    const rendered = formatOverviewTree(tree, { maxDepth: 2 });
    expect(tree.root.path).toBe('src');
    expect(tree.totalFiles).toBe(1);
    expect(rendered).toContain('service.ts');
    expect(rendered).not.toContain('service.test.ts');
  });

  it('counts node kind rollups from all symbols while capping anchor symbols', () => {
    const tree = buildOverviewTree({
      files: [file('src/many.ts', 'typescript', 6)],
      nodes: [
        symbol('one', 'src/many.ts', 'function', 'one', 1),
        symbol('two', 'src/many.ts', 'function', 'two', 2),
        symbol('three', 'src/many.ts', 'function', 'three', 3),
        symbol('four', 'src/many.ts', 'function', 'four', 4),
        symbol('five', 'src/many.ts', 'function', 'five', 5),
        symbol('six', 'src/many.ts', 'class', 'Six', 6),
      ],
    });

    expect(tree.root.nodeKinds).toEqual([
      { kind: 'function', count: 5 },
      { kind: 'class', count: 1 },
    ]);
    expect(tree.root.notableSymbols).toHaveLength(4);
  });

  it('serves overview output through the existing MCP files tool', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-overview-mcp-'));
    let graph: SolidKG | undefined;
    try {
      fs.mkdirSync(path.join(testDir, 'src'));
      fs.writeFileSync(path.join(testDir, 'src', 'api.ts'), 'export function route(): string { return "ok"; }\n');
      graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await graph.indexAll();

      const result = await new ToolHandler(graph).execute('solidkg_files', {
        format: 'overview',
        maxDepth: 2,
        expandPaths: ['src'],
      });

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('## Repository Overview');
      expect(result.content[0].text).toContain('api.ts');
      expect(result.content[0].text).toContain('route');
    } finally {
      graph?.destroy();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized overview expand path lists through the MCP files tool', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-overview-mcp-'));
    let graph: SolidKG | undefined;
    try {
      fs.mkdirSync(path.join(testDir, 'src'));
      fs.writeFileSync(path.join(testDir, 'src', 'api.ts'), 'export function route(): string { return "ok"; }\n');
      graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await graph.indexAll();

      const result = await new ToolHandler(graph).execute('solidkg_files', {
        format: 'overview',
        expandPaths: Array.from({ length: 51 }, (_, index) => `src/${index}`),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('expandPaths must contain at most 50 paths');
    } finally {
      graph?.destroy();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
