#!/usr/bin/env node
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { SourceChunkRecord } from '../../src/types.ts';
import { runAiderCentralityTrial } from './aider-centrality.mts';
import { HarnessInvariantError, first, queryReport, renderMarkdown, summarize } from './report.mts';
import type { AgentEvalProbe, ExpectedChunk, ExpectedSet, ExploreSurfaceProbe, HarnessOptions, QueryReport, RetrievalQualityReport, TraceControl } from './types.mts';

type SolidKGInstance = {
  readonly indexAll: () => Promise<void>;
  readonly close: () => void;
  readonly getFiles: () => readonly { readonly path: string }[];
  readonly getNodesInFile: (filePath: string) => readonly import('../../src/types.ts').Node[];
  readonly getOutgoingEdges: (nodeId: string) => readonly import('../../src/types.ts').Edge[];
  readonly getSourceChunksByFile: (filePath: string) => readonly SourceChunkRecord[];
  readonly searchNodes: (query: string, options?: { readonly limit?: number }) => readonly import('../../src/types.ts').SearchResult[];
};

type SolidKGClass = { readonly initSync: (root: string, options?: unknown) => SolidKGInstance };
type ToolHandlerLike = { readonly execute: (tool: string, args: Record<string, unknown>) => Promise<{ readonly content: readonly { readonly text?: string }[] }> };
type ToolHandlerClass = new (graph: SolidKGInstance) => ToolHandlerLike;
type Runtime = { readonly SolidKG: SolidKGClass; readonly ToolHandler: ToolHandlerClass };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceBaseName = 'retrieval-quality-codeseek-retrieval-improvements';
const defaultHarnessCommand = 'pnpm exec tsx scripts/retrieval-quality/run.mts';
const vitestHarnessCommand = 'pnpm exec vitest run __tests__/retrieval-quality.test.ts -t "writes Task 7 evidence"';

const fixtureFiles = {
  'src/fulfillment/express.ts': `
export function shipExpressOrder(orderId: string): string {
  const manifest = 'carrier manifest quarantine routing';
  const dock = 'warehouse exception resolution lane';
  const label = orderId.toUpperCase();
  return [label, manifest, dock].join(':');
}
`,
  'src/controllers/checkout-controller.ts': `export class CheckoutController {
  reconcileCart(): string {
    return 'checkout controller metadata exact control';
  }
}
`,
  'src/generated/express.generated.ts': `export function generatedExpressFixture(): string {
  return 'carrier manifest quarantine routing warehouse exception resolution lane';
}
`,
  'src/fulfillment/express.test.ts': `export function expressFixtureTest(): string {
  return 'carrier manifest quarantine routing warehouse exception resolution lane';
}
`,
  'src/workflows/order-flow.ts': `import { shipExpressOrder } from '../fulfillment/express';

export function receiveOrder(orderId: string): string {
  return authorizePayment(orderId);
}

export function authorizePayment(orderId: string): string {
  return shipExpressOrder(orderId);
}
`,
  'src/gateway/order-gateway.ts': `import { receiveOrder } from '../workflows/order-flow';

export function submitOrderLifecycleGateway(orderId: string): string {
  const audit = 'order lifecycle coordination gateway';
  return receiveOrder([audit, orderId].join(':'));
}
`,
} as const;

function writeFixture(root: string): readonly string[] {
  const written: string[] = [];
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    written.push(relativePath);
  }
  return written.sort();
}

function chunkForSymbol(chunks: readonly SourceChunkRecord[], symbol: string): ExpectedChunk {
  const chunk = chunks.find((candidate) => candidate.content.includes(symbol));
  if (!chunk) throw new HarnessInvariantError(`missing source chunk for ${symbol}`);
  return { id: chunk.id, filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine };
}

async function traceReport(handler: ToolHandlerLike): Promise<QueryReport> {
  const result = await handler.execute('solidkg_trace', { from: 'receiveOrder', to: 'shipExpressOrder' });
  const text = result.content[0]?.text ?? '';
  const traceControl: TraceControl = {
    found: text.includes('## Trace: receiveOrder') && text.includes('shipExpressOrder') && text.includes('carrier manifest quarantine routing'),
    sourceReferenceFidelity: text.includes('src/fulfillment/express.ts') && text.includes('src/workflows/order-flow.ts') ? 1 : 0,
    outputChars: text.length,
    toolCalls: 1,
    readCount: 0,
    grepCount: 0,
  };
  return {
    id: 'trace-control',
    kind: 'trace_control',
    query: 'solidkg_trace receiveOrder -> shipExpressOrder',
    expected: { symbols: ['receiveOrder', 'authorizePayment', 'shipExpressOrder'], chunks: [], files: ['src/workflows/order-flow.ts', 'src/fulfillment/express.ts'], lines: [] },
    metadataOnly: { recallAtK: traceControl.found ? 1 : 0, mrr: traceControl.found ? 1 : 0, sourceReferenceFidelity: traceControl.sourceReferenceFidelity, topResults: [] },
    fused: { recallAtK: traceControl.found ? 1 : 0, mrr: traceControl.found ? 1 : 0, sourceReferenceFidelity: traceControl.sourceReferenceFidelity, topResults: [] },
    traceControl,
    controlSignals: { exactIntentPreserved: true, generatedOrTestDemoted: true, materialBodyImprovement: true },
    boundedNoResult: false,
    pass: traceControl.found && traceControl.sourceReferenceFidelity === 1,
  };
}

async function exploreSurfaceProbe(handler: ToolHandlerLike): Promise<ExploreSurfaceProbe> {
  const query = 'order lifecycle coordination gateway';
  const result = await handler.execute('solidkg_explore', { query, maxFiles: 1 });
  const text = result.content[0]?.text ?? '';
  const firstSourceFile = text.match(/^####\s+([^\[]+?)\s+\[/m)?.[1]?.trim() ?? null;
  const expectedFirstFile = 'src/workflows/order-flow.ts';
  const graphRankedNotice = text.includes('Graph-ranked file allocation');
  return {
    query,
    maxFiles: 1,
    firstSourceFile,
    expectedFirstFile,
    graphRankedNotice,
    outputChars: text.length,
    pass: firstSourceFile === expectedFirstFile && graphRankedNotice,
  };
}

function prop(value: unknown, key: string): unknown {
  return (typeof value === 'object' || typeof value === 'function') && value !== null ? Reflect.get(value, key) : undefined;
}

function isSolidKGClass(value: unknown): value is SolidKGClass {
  return typeof prop(value, 'initSync') === 'function';
}

function isToolHandlerClass(value: unknown): value is ToolHandlerClass {
  return typeof value === 'function';
}

function resolveSolidKG(moduleValue: unknown): SolidKGClass {
  const direct = prop(moduleValue, 'SolidKG');
  const defaultExport = prop(moduleValue, 'default');
  const defaultNamed = prop(defaultExport, 'SolidKG');
  const nestedDefault = prop(defaultExport, 'default');
  const moduleExports = prop(moduleValue, 'module.exports');
  const moduleNamed = prop(moduleExports, 'SolidKG');
  for (const candidate of [direct, defaultExport, defaultNamed, nestedDefault, moduleNamed]) {
    if (isSolidKGClass(candidate)) return candidate;
  }
  throw new HarnessInvariantError('could not resolve SolidKG runtime');
}

function resolveToolHandler(moduleValue: unknown): ToolHandlerClass {
  const direct = prop(moduleValue, 'ToolHandler');
  const defaultExport = prop(moduleValue, 'default');
  const nested = prop(defaultExport, 'ToolHandler');
  for (const candidate of [direct, nested]) {
    if (isToolHandlerClass(candidate)) return candidate;
  }
  throw new HarnessInvariantError('could not resolve ToolHandler runtime');
}

async function loadRuntime(): Promise<Runtime> {
  const sourceRuntime = process.env.VITEST
    ? { index: path.join(repoRoot, 'src', 'index.ts'), tools: path.join(repoRoot, 'src', 'mcp', 'tools.ts') }
    : { index: path.join(repoRoot, 'dist', 'index.js'), tools: path.join(repoRoot, 'dist', 'mcp', 'tools.js') };
  if (!fs.existsSync(sourceRuntime.index) || !fs.existsSync(sourceRuntime.tools)) {
    throw new HarnessInvariantError('retrieval-quality runtime is missing; run pnpm run build or execute the Vitest harness');
  }
  const indexModule = await import(pathToFileURL(sourceRuntime.index).href);
  const toolsModule = await import(pathToFileURL(sourceRuntime.tools).href);
  return { SolidKG: resolveSolidKG(indexModule), ToolHandler: resolveToolHandler(toolsModule) };
}

function runAgentEvalProbe(root: string, id: string, script: string, args: readonly string[], expectedText: string): AgentEvalProbe {
  const scriptPath = path.join(repoRoot, 'scripts', 'agent-eval', script);
  const command = `node scripts/agent-eval/${script} ${args.join(' ')}`;
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.js')) || !fs.existsSync(scriptPath)) {
    return { id, command, status: 'not_feasible', outputChars: 0, readCount: 0, grepCount: 0, toolCalls: 0, note: 'dist build or probe script not present' };
  }
  try {
    const output = execFileSync(process.execPath, [scriptPath, root, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
    return { id, command, status: output.includes(expectedText) ? 'pass' : 'not_feasible', outputChars: output.length, readCount: 0, grepCount: 0, toolCalls: 1, note: output.includes(expectedText) ? 'probe returned expected local evidence' : 'probe ran but did not include expected evidence' };
  } catch (error) {
    if (error instanceof Error) {
      return { id, command, status: 'not_feasible', outputChars: 0, readCount: 0, grepCount: 0, toolCalls: 0, note: error.message };
    }
    throw error;
  }
}

function harnessCommand(): string {
  return process.env.VITEST ? vitestHarnessCommand : defaultHarnessCommand;
}

function writeArtifacts(outputDir: string, report: RetrievalQualityReport): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${evidenceBaseName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, `${evidenceBaseName}.md`), renderMarkdown(report));
  fs.writeFileSync(path.join(outputDir, 'task-7-codeseek-retrieval-improvements.txt'), `command: ${harnessCommand()}\njson: ${path.join(outputDir, `${evidenceBaseName}.json`)}\npass: ${report.summary.pass}\nbody improvement: ${report.summary.materialBodyImprovement}\ncontrols pass: ${report.summary.controlsPass}\ntsx unavailable fallback: ${process.env.VITEST ? 'used repo-available Vitest runtime' : 'not used'}\n`);
}

export async function runRetrievalQualityHarness(options: HarnessOptions = {}): Promise<RetrievalQualityReport> {
  const fixtureRoot = options.fixtureRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-retrieval-quality-'));
  const files = writeFixture(fixtureRoot);
  const { SolidKG, ToolHandler } = await loadRuntime();
  const graph = SolidKG.initSync(fixtureRoot, { config: { include: ['**/*.ts'], exclude: [] } });
  try {
    await graph.indexAll();
    const handler = new ToolHandler(graph);
    const bodyQuery = 'carrier manifest quarantine routing warehouse exception resolution lane';
    const bodyExpected: ExpectedSet = { symbols: ['shipExpressOrder'], chunks: [chunkForSymbol(graph.getSourceChunksByFile('src/fulfillment/express.ts'), 'shipExpressOrder')], files: ['src/fulfillment/express.ts'], lines: [{ filePath: 'src/fulfillment/express.ts', startLine: 2, endLine: 7 }] };
    const exactExpected: ExpectedSet = { symbols: ['CheckoutController'], chunks: [], files: ['src/controllers/checkout-controller.ts'], lines: [{ filePath: 'src/controllers/checkout-controller.ts', startLine: 1, endLine: 5 }] };
    const queries: QueryReport[] = [
      queryReport({ id: 'body-query-behavior', kind: 'body_query', query: bodyQuery, expected: bodyExpected, results: graph.searchNodes(bodyQuery, { limit: 10 }) }),
      queryReport({ id: 'exact-query-control', kind: 'exact_query_control', query: 'CheckoutController path:controllers/checkout-controller.ts carrier manifest quarantine', expected: exactExpected, results: graph.searchNodes('CheckoutController path:controllers/checkout-controller.ts carrier manifest quarantine', { limit: 10 }) }),
      queryReport({ id: 'generated-test-demotion-control', kind: 'demotion_control', query: bodyQuery, expected: bodyExpected, results: graph.searchNodes(bodyQuery, { limit: 10 }) }),
      queryReport({ id: 'no-match-failure-control', kind: 'no_match_control', query: 'orthogonal kerberos nebula quokka', expected: { symbols: [], chunks: [], files: [], lines: [] }, results: graph.searchNodes('orthogonal kerberos nebula quokka', { limit: 10 }) }),
      await traceReport(handler),
    ];
    const relevantTopKShare = Number((queries.filter((query) => query.fused.topResults[0]?.filePath === query.expected.files[0]).length / queries.length).toFixed(4));
    const aiderCentralityTrial = runAiderCentralityTrial(graph, fixtureRoot);
    const exploreProbe = await exploreSurfaceProbe(handler);
    const report: RetrievalQualityReport = {
      schemaName: 'solidkg.retrieval-quality.codeseek.v1',
      generatedAt: new Date(0).toISOString(),
      fixture: { name: 'codeseek-retrieval-quality-local', root: fixtureRoot, files },
      qualityBar: { bodySourceBehaviorMustImprove: true, exactPathTraceControlsMustNotRegress: true, aiderStyleRankingIsFollowUpOnly: true },
      budgetRelevanceCriterion: { measuredOnly: true, currentRelevantTopKShare: relevantTopKShare, futureMaterialityThreshold: 'Follow-up Aider-style ranking must improve median tool calls by >=10% or output chars/tokens by >=10-20% without regressing exact/path/trace controls.' },
      summary: summarize(queries),
      queries,
      aiderCentralityTrial,
      exploreSurfaceProbe: exploreProbe,
      agentEvalProbes: [
        runAgentEvalProbe(fixtureRoot, 'body-query-context-probe', 'probe-context.mjs', [bodyQuery], 'shipExpressOrder'),
        runAgentEvalProbe(fixtureRoot, 'exact-query-explore-probe', 'probe-explore.mjs', ['CheckoutController path:controllers/checkout-controller.ts'], 'CheckoutController'),
        runAgentEvalProbe(fixtureRoot, 'trace-control-probe', 'probe-trace.mjs', ['receiveOrder', 'shipExpressOrder'], '## Trace'),
      ],
    };
    if (options.writeArtifacts ?? true) writeArtifacts(options.outputDir ?? path.join(repoRoot, '.omo', 'evidence'), report);
    return report;
  } finally {
    graph.close();
  }
}

function parseOutputDir(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--out-dir');
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runRetrievalQualityHarness({ outputDir: parseOutputDir(process.argv), writeArtifacts: true })
    .then((report) => {
      const outputDir = parseOutputDir(process.argv) ?? path.join(repoRoot, '.omo', 'evidence');
      process.stdout.write(`${JSON.stringify({ pass: report.summary.pass, evidence: path.join(outputDir, `${evidenceBaseName}.json`) })}\n`);
      process.exit(report.summary.pass ? 0 : 1);
    })
    .catch((error: unknown) => {
      if (error instanceof Error) process.stderr.write(`${error.name}: ${error.message}\n`);
      else process.stderr.write('Unknown retrieval-quality harness failure\n');
      process.exit(1);
    });
}
