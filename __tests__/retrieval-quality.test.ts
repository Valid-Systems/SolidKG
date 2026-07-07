import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadHarness(): Promise<typeof import('../scripts/retrieval-quality/run.mts')> {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'retrieval-quality', 'run.mts')).href;
  return import(moduleUrl);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('retrieval quality harness', () => {
  it('proves body-query retrieval improves over metadata-only controls without regressing exact and trace controls', async () => {
    // Given: a deterministic local retrieval-quality fixture.
    const outputDir = createTempDir('retrieval-quality-output-');
    const { runRetrievalQualityHarness } = await loadHarness();

    // When: the harness runs without external services.
    const report = await runRetrievalQualityHarness({ outputDir, writeArtifacts: true });

    // Then: body-only behavior queries materially improve over the metadata-only control.
    expect(report.schemaName).toBe('solidkg.retrieval-quality.codeseek.v1');
    expect(report.summary.pass).toBe(true);
    expect(report.summary.materialBodyImprovement).toBe(true);
    expect(report.summary.controlsPass).toBe(true);
    expect(report.summary.externalServicesUsed).toEqual([]);

    const bodyQuery = report.queries.find((query) => query.id === 'body-query-behavior');
    expect(bodyQuery).toMatchObject({
      kind: 'body_query',
      pass: true,
      expected: {
        symbols: ['shipExpressOrder'],
        files: ['src/fulfillment/express.ts'],
      },
      fused: {
        recallAtK: 1,
        mrr: 1,
        sourceReferenceFidelity: 1,
      },
      metadataOnly: {
        recallAtK: 0,
        mrr: 0,
      },
    });
    expect(bodyQuery?.fused.topResults[0]?.rankingReasons).toEqual(expect.arrayContaining(['source_body_chunk', 'fusion']));
    expect(bodyQuery?.expected.chunks[0]?.filePath).toBe('src/fulfillment/express.ts');
    expect(bodyQuery?.expected.lines).toContainEqual({ filePath: 'src/fulfillment/express.ts', startLine: 2, endLine: 7 });

    const exactQuery = report.queries.find((query) => query.id === 'exact-query-control');
    expect(exactQuery?.fused.topResults[0]).toMatchObject({ symbol: 'CheckoutController', filePath: 'src/controllers/checkout-controller.ts' });
    expect(exactQuery?.pass).toBe(true);

    const demotionQuery = report.queries.find((query) => query.id === 'generated-test-demotion-control');
    expect(demotionQuery?.controlSignals.generatedOrTestDemoted).toBe(true);
    expect(demotionQuery?.pass).toBe(true);

    const traceQuery = report.queries.find((query) => query.id === 'trace-control');
    expect(traceQuery?.traceControl).toMatchObject({ found: true, sourceReferenceFidelity: 1 });
    expect(traceQuery?.pass).toBe(true);

    const noMatch = report.queries.find((query) => query.id === 'no-match-failure-control');
    expect(noMatch).toMatchObject({
      kind: 'no_match_control',
      pass: true,
      boundedNoResult: true,
      fused: { recallAtK: 1, mrr: 1, topResults: [] },
    });

    expect(report.aiderCentralityTrial).toMatchObject({
      id: 'aider-centrality-file-budget',
      pass: true,
      expectedFiles: ['src/workflows/order-flow.ts'],
      material: {
        improvesMrr: true,
        reducesFilesToCover: true,
        reducesOutputCharsToCover: true,
      },
    });
    expect(report.aiderCentralityTrial?.baseline.recallAtK).toBe(1);
    expect(report.aiderCentralityTrial?.centrality.recallAtK).toBe(1);
    expect(report.aiderCentralityTrial?.baseline.filesToCoverExpected).toBe(2);
    expect(report.aiderCentralityTrial?.centrality.filesToCoverExpected).toBe(1);
    expect(report.aiderCentralityTrial?.material.outputCharReductionRatio).toBeGreaterThan(0.1);
    expect(report.aiderCentralityTrial?.centrality.topFiles[0]?.filePath).toBe('src/workflows/order-flow.ts');
    expect(report.exploreSurfaceProbe).toMatchObject({
      pass: true,
      firstSourceFile: 'src/workflows/order-flow.ts',
      expectedFirstFile: 'src/workflows/order-flow.ts',
      graphRankedNotice: true,
    });

    const evidencePath = path.join(outputDir, 'retrieval-quality-codeseek-retrieval-improvements.json');
    const markdownPath = path.join(outputDir, 'retrieval-quality-codeseek-retrieval-improvements.md');
    expect(fs.existsSync(evidencePath)).toBe(true);
    expect(fs.readFileSync(markdownPath, 'utf8')).toContain('agent-eval probe summary');
    expect(fs.readFileSync(markdownPath, 'utf8')).toContain('Aider/PageRank candidate');
    expect(fs.readFileSync(markdownPath, 'utf8')).toContain('Explore surface probe');
  });

  it('writes Task 7 evidence through the repo-available Vitest runtime', async () => {
    // Given: the default Task 7 evidence location.
    const evidenceDir = path.resolve(__dirname, '..', '.omo', 'evidence');
    const evidencePath = path.join(evidenceDir, 'retrieval-quality-codeseek-retrieval-improvements.json');
    const taskPath = path.join(evidenceDir, 'task-7-codeseek-retrieval-improvements.txt');
    const { runRetrievalQualityHarness } = await loadHarness();

    // When: the harness writes default artifacts under the repo evidence directory.
    const report = await runRetrievalQualityHarness({ writeArtifacts: true });

    // Then: the deterministic evidence contains the required Task 7 metrics and command path.
    expect(report.summary.pass).toBe(true);
    expect(fs.existsSync(evidencePath)).toBe(true);
    expect(fs.existsSync(taskPath)).toBe(true);
    expect(fs.readFileSync(taskPath, 'utf8')).toContain('pnpm exec vitest run __tests__/retrieval-quality.test.ts -t "writes Task 7 evidence"');
  });
});
