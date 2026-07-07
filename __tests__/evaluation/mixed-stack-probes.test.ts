import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import SolidKG from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';
import type { ArchitectureReport } from '../../src/index';
import type { Edge, Node } from '../../src/types';
import { initGrammars, loadAllGrammars } from '../../src/extraction/grammars';
import { writeScipFixture } from '../scip-test-helpers';

type ProbeResult = {
  id: string;
  status: 'pass' | 'fail';
  summary: string;
  path?: {
    found: boolean;
    hopCount: number;
    symbols: string[];
    metadata?: Record<string, unknown>;
  };
  sourceCompleteness?: {
    status: string;
    returnedFiles: string[];
    truncatedFiles: string[];
    omittedFiles: string[];
    unreadableFiles: string[];
    staleFiles: string[];
  };
};

const repoRoot = path.resolve(__dirname, '../..');
const corpusManifestPath = path.join(repoRoot, 'fixtures', 'evaluation-corpus', 'manifest.json');
const syntheticFixtureIdentity = 'synthetic://evaluation-corpus/task-8-mixed-stack';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Task 8 synthetic mixed-stack probes', () => {
  let testDir: string | undefined;
  let cg: SolidKG | undefined;
  let handler: ToolHandler | undefined;

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    handler = undefined;
    cg = undefined;
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    testDir = undefined;
  });

  it('covers route flow, callback/render flow, architecture coupling, SCIP precise refs, and writes schema evidence on demand', async () => {
    const manifest = JSON.parse(fs.readFileSync(corpusManifestPath, 'utf8')) as {
      corpora: unknown[];
      syntheticFixtures?: Array<{ name?: string; identity?: string; probes?: string[]; realCorpus?: boolean }>;
    };
    expect(manifest.corpora).toEqual([]);
    const fixture = manifest.syntheticFixtures?.find((entry) => entry.identity === syntheticFixtureIdentity);
    expect(fixture).toMatchObject({
      name: 'task-8-mixed-stack-synthetic',
      realCorpus: false,
    });
    expect(fixture?.probes).toEqual(expect.arrayContaining([
      'route-flow',
      'callback-render-flow',
      'architecture-coupling',
      'scip-precise-refs',
    ]));

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-task-8-mixed-stack-'));
    writeSyntheticMixedStackProject(testDir);

    cg = SolidKG.initSync(testDir, {
      includePatterns: ['packages/**/*.ts', 'packages/**/*.tsx', 'packages/**/package.json'],
      excludePatterns: [],
    });
    const indexResult = await cg.indexAll();
    expect(indexResult.success).toBe(true);
    handler = new ToolHandler(cg);

    const routeResult = assertRouteFlow();
    const renderResult = await assertCallbackRenderFlow();
    const architectureResult = assertArchitectureCoupling();
    const scipResult = await assertScipPreciseRefs();
    const results = [routeResult, renderResult, architectureResult, scipResult];

    expect(results.every((result) => result.status === 'pass')).toBe(true);
    maybeWriteReadinessEvidence(results);
  });

  function assertRouteFlow(): ProbeResult {
    const route = requireNode('GET /api/profile/:id', 'route');
    const handlerNode = requireNode('profileRoute', 'function');
    const formatter = requireNode('formatProfile', 'function');

    const routeEdges = cg!.getOutgoingEdges(route.id);
    expect(routeEdges.some((edge) => edge.target === handlerNode.id && edge.kind === 'references')).toBe(true);

    const pathToService = cg!.findPath(route.id, formatter.id, ['references', 'calls']);
    const symbols = pathToService?.map((step) => step.node.name) ?? [];
    expect(symbols).toEqual(['GET /api/profile/:id', 'profileRoute', 'loadProfile', 'formatProfile']);
    expect(cg!.getHyperedgesByNode(route.id).some((relation) => relation.hyperedge.kind === 'route_binding')).toBe(true);

    return {
      id: 'route-flow',
      status: 'pass',
      summary: 'Synthetic Hono route resolves route -> handler -> service -> formatter.',
      path: {
        found: Boolean(pathToService),
        hopCount: Math.max(0, symbols.length - 1),
        symbols,
        metadata: { edgeKinds: ['references', 'calls'], routeBinding: true },
      },
      sourceCompleteness: completeSource(['packages/web/src/api.ts', 'packages/core/src/profile.ts']),
    };
  }

  async function assertCallbackRenderFlow(): Promise<ProbeResult> {
    const mutate = requireNode('mutateElement', 'method');
    const renderStaticScene = requireNode('renderStaticScene', 'function');
    const renderPath = cg!.findPath(mutate.id, renderStaticScene.id, ['calls']);
    const symbols = renderPath?.map((step) => step.node.name) ?? [];
    expect(symbols).toEqual(['mutateElement', 'render', 'StaticCanvas', 'renderStaticScene']);

    const jsxEdge = requireJsxEdge(renderPath);
    expect(jsxEdge.metadata?.synthesizedBy).toBe('jsx-render');
    expect(jsxEdge.metadata?.localFlow).toMatchObject({
      kind: 'jsx-prop-handoff',
      props: ['canvasNonce'],
      complete: false,
      confidence: 0.55,
    });

    const trace = await handler!.execute('solidkg_trace', { from: 'mutateElement', to: 'renderStaticScene' });
    const text = trace.content?.[0]?.text ?? '';
    expect(text).toContain('local prop handoff `canvasNonce`');

    return {
      id: 'callback-render-flow',
      status: 'pass',
      summary: 'Synthetic callback/render path crosses setState render and JSX child edges with bounded local-flow metadata.',
      path: {
        found: Boolean(renderPath),
        hopCount: Math.max(0, symbols.length - 1),
        symbols,
        metadata: { synthesizedBy: 'jsx-render', localFlow: jsxEdge.metadata?.localFlow },
      },
      sourceCompleteness: completeSource(['packages/web/src/App.tsx']),
    };
  }

  function assertArchitectureCoupling(): ProbeResult {
    const report = cg!.analyzeArchitecture({
      layers: [
        { name: 'web', paths: ['packages/web/**'] },
        { name: 'core', paths: ['packages/core/**'] },
      ],
    });
    expect(report.packageDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'web', target: 'core' }),
    ]));
    expect(report.layerDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'web', target: 'core' }),
    ]));
    expect(couplingFor(report, 'web')).toMatchObject({ Ca: 0, Ce: 1, instability: 1 });
    expect(couplingFor(report, 'core')).toMatchObject({ Ca: 1, Ce: 0, instability: 0 });

    return {
      id: 'architecture-coupling',
      status: 'pass',
      summary: 'Synthetic package/layer rollup records web -> core coupling and instability metrics.',
      path: {
        found: true,
        hopCount: 1,
        symbols: ['web', 'core'],
        metadata: {
          packageDependencies: report.packageDependencies.map((dependency) => ({
            from: dependency.source,
            to: dependency.target,
            edgeKinds: dependency.edgeKinds,
          })),
          layerDependencies: report.layerDependencies.map((dependency) => ({
            from: dependency.source,
            to: dependency.target,
            edgeKinds: dependency.edgeKinds,
          })),
          coupling: report.coupling.packages,
        },
      },
      sourceCompleteness: completeSource(['packages/web/src/api.ts', 'packages/core/src/profile.ts']),
    };
  }

  async function assertScipPreciseRefs(): Promise<ProbeResult> {
    const loadProfile = requireNode('loadProfile', 'function');
    const indexFile = writeScipFixture(testDir!, 'task-8-profile.scip', {
      relativePath: 'packages/core/src/profile.ts',
      symbol: 'npm synthetic-mixed-stack 1.0.0 ProfileService#loadProfile().',
      displayName: 'loadProfile',
      range: [0, 16, 27],
      referenceRange: [4, 9, 20],
    });

    await cg!.importScipIndexes([indexFile]);
    const linked = cg!.getNode(loadProfile.id);
    expect(linked?.scipSymbol).toBe('npm synthetic-mixed-stack 1.0.0 ProfileService#loadProfile().');

    const precise = await handler!.execute('solidkg_precise_refs', { nodeId: loadProfile.id, includeReferences: true });
    const text = precise.content?.[0]?.text ?? '';
    expect(text).toContain('## Precise references');
    expect(text).toContain('packages/core/src/profile.ts:1');
    expect(text).toContain('References');

    return {
      id: 'scip-precise-refs',
      status: 'pass',
      summary: 'Synthetic SCIP fixture links loadProfile to exact definition and reference locations.',
      path: {
        found: true,
        hopCount: 0,
        symbols: ['loadProfile'],
        metadata: {
          nodeId: loadProfile.id,
          scipSymbol: linked?.scipSymbol,
          includeReferences: true,
        },
      },
      sourceCompleteness: completeSource(['packages/core/src/profile.ts']),
    };
  }

  function maybeWriteReadinessEvidence(results: ProbeResult[]): void {
    if (process.env.SOLIDKG_TASK8_WRITE_EVIDENCE !== '1') return;
    const outPath = process.env.SOLIDKG_TASK8_EVIDENCE_PATH || path.join(repoRoot, '.omo', 'evidence', 'task-8-mixed-stack-probes.json');
    const inputPath = path.join(testDir!, 'task-8-evidence-input.json');
    const failed = results.find((result) => result.status !== 'pass');
    const route = results.find((result) => result.id === 'route-flow');
    const render = results.find((result) => result.id === 'callback-render-flow');
    const scip = results.find((result) => result.id === 'scip-precise-refs');
    const evidenceInput = {
      generatedAt: '2026-06-04T00:00:00.000Z',
      prompt: 'Task 8 synthetic mixed-stack probes: route flow, callback/render flow, architecture coupling, and SCIP precise refs.',
      subject: {
        kind: 'evaluation',
        solidkgVersion: '0.7.0-local',
        repo: {
          name: 'task-8-mixed-stack-synthetic',
          identity: syntheticFixtureIdentity,
          privacy: 'synthetic',
          corpusManifest: 'fixtures/evaluation-corpus/manifest.json',
          revision: 'synthetic-fixture-v1',
        },
      },
      command: {
        commandLine: 'node scripts/agent-eval/task-8-mixed-stack-probes.mjs',
        cwd: repoRoot,
        argv: ['node', 'scripts/agent-eval/task-8-mixed-stack-probes.mjs'],
      },
      metrics: {
        durationMs: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        toolCalls: { total: 4, read: 0, grep: 0, bash: 0, solidkg: 4, other: 0 },
      },
      graphAnswer: {
        path: {
          found: results.every((result) => result.path?.found !== false),
          hopCount: Math.max(...results.map((result) => result.path?.hopCount ?? 0)),
          symbols: [...new Set(results.flatMap((result) => result.path?.symbols ?? []))],
          metadata: {
            syntheticFixture: syntheticFixtureIdentity,
            route: route?.path,
            render: render?.path,
            architecture: results.find((result) => result.id === 'architecture-coupling')?.path,
            scip: scip?.path,
            probes: results.map(({ id, status, summary }) => ({ id, status, summary })),
          },
        },
        sourceCompleteness: {
          status: 'complete',
          returnedFiles: [...new Set(results.flatMap((result) => result.sourceCompleteness?.returnedFiles ?? []))],
          truncatedFiles: [],
          omittedFiles: [],
          unreadableFiles: [],
          staleFiles: [],
        },
      },
      result: {
        status: failed ? 'fail' : 'pass',
        summary: failed ? failed.summary : 'All synthetic mixed-stack probes passed within the small-fixture budget.',
        failureTaxonomyTag: failed ? 'partial_coverage' : 'pass',
      },
      artifacts: {
        evidencePath: outPath,
        manifestPath: 'fixtures/evaluation-corpus/manifest.json',
        probeResults: results.map(({ id, status, summary }) => ({ id, status, summary })),
      },
    };

    fs.writeFileSync(inputPath, JSON.stringify(evidenceInput, null, 2));
    execFileSync('node', ['scripts/readiness/write-evidence.mjs', '--input', inputPath, '--out', outPath], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  function requireNode(name: string, kind: Node['kind']): Node {
    const node = cg!.getNodesByKind(kind).find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Missing ${kind} node ${name}`);
    return node;
  }

  function requireJsxEdge(renderPath: Array<{ node: Node; edge: Edge | null }> | null | undefined): Edge {
    const edge = renderPath
      ?.map((step) => step.edge)
      .find((candidate): candidate is Edge => candidate?.metadata?.synthesizedBy === 'jsx-render');
    if (!edge) throw new Error('Missing jsx-render edge in callback/render path');
    return edge;
  }

  function couplingFor(report: ArchitectureReport, name: string): ArchitectureReport['coupling']['packages'][number] | undefined {
    return report.coupling.packages.find((metric) => metric.name === name);
  }

  function completeSource(returnedFiles: string[]): ProbeResult['sourceCompleteness'] {
    return {
      status: 'complete',
      returnedFiles,
      truncatedFiles: [],
      omittedFiles: [],
      unreadableFiles: [],
      staleFiles: [],
    };
  }
});

function writeSyntheticMixedStackProject(root: string): void {
  fs.mkdirSync(path.join(root, 'packages', 'web', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'core', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({ name: 'web' }));
  fs.writeFileSync(path.join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: 'core' }));
  fs.writeFileSync(
    path.join(root, 'packages', 'core', 'src', 'profile.ts'),
    `export function loadProfile(id: string): string {
  return formatProfile(id);
}

export function formatProfile(id: string): string {
  return \`profile:\${id}\`;
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'web', 'src', 'api.ts'),
    `import { Hono } from 'hono';
import { loadProfile } from '../../core/src/profile';

const app = new Hono();

export function profileRoute(c: { req: { param(name: string): string } }): string {
  return loadProfile(c.req.param('id'));
}

app.get('/api/profile/:id', profileRoute);
`,
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'web', 'src', 'App.tsx'),
    `import React from 'react';

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
`,
  );
}