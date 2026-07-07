import type { SearchResult } from '../../src/types.ts';
import type { ExpectedLine, ExpectedSet, QueryReport, QueryReportInput, RetrievalQualityReport, RetrievalMetrics, TopResult } from './types.mts';

export class HarnessInvariantError extends Error {
  readonly name = 'HarnessInvariantError';
}

export function first<T>(values: readonly T[], message: string): T {
  const value = values[0];
  if (!value) throw new HarnessInvariantError(message);
  return value;
}

function rankingKinds(result: SearchResult): readonly string[] {
  return (result.rankingReasons ?? []).map((reason) => reason.kind);
}

function chunkEvidence(result: SearchResult): readonly string[] {
  return (result.rankingReasons ?? [])
    .filter((reason) => reason.kind === 'source_body_chunk' && typeof reason.evidence === 'string')
    .map((reason) => String(reason.evidence));
}

function topResults(results: readonly SearchResult[], limit: number): readonly TopResult[] {
  return results.slice(0, limit).map((result, index) => ({
    rank: index + 1,
    symbol: result.node.name,
    filePath: result.node.filePath,
    startLine: result.node.startLine,
    endLine: result.node.endLine,
    score: Number(result.score.toFixed(4)),
    rankingReasons: rankingKinds(result),
    chunkEvidence: chunkEvidence(result),
  }));
}

function overlaps(result: TopResult, expected: ExpectedLine): boolean {
  return result.filePath === expected.filePath && result.startLine <= expected.endLine && result.endLine >= expected.startLine;
}

function metric(expected: ExpectedSet, results: readonly SearchResult[], k: number): RetrievalMetrics {
  const top = topResults(results, k);
  if (expected.symbols.length === 0) {
    const noResults = top.length === 0;
    return { recallAtK: noResults ? 1 : 0, mrr: noResults ? 1 : 0, sourceReferenceFidelity: noResults ? 1 : 0, topResults: top };
  }
  const matchedSymbols = expected.symbols.filter((symbol) => top.some((result) => result.symbol === symbol));
  const firstRank = top.find((result) => expected.symbols.includes(result.symbol))?.rank;
  const lineHits = expected.lines.filter((line) => top.some((result) => overlaps(result, line))).length;
  const chunkHits = expected.chunks.filter((chunk) => top.some((result) => result.chunkEvidence.includes(chunk.id))).length;
  const referenceTotal = expected.lines.length + expected.chunks.length;
  return {
    recallAtK: matchedSymbols.length / expected.symbols.length,
    mrr: firstRank ? 1 / firstRank : 0,
    sourceReferenceFidelity: referenceTotal === 0 ? 1 : (lineHits + chunkHits) / referenceTotal,
    topResults: top,
  };
}

function metadataOnly(results: readonly SearchResult[]): readonly SearchResult[] {
  return results.filter((result) => !rankingKinds(result).includes('source_body_chunk'));
}

function generatedAndTestAreDemoted(results: readonly TopResult[]): boolean {
  const productionRank = results.find((result) => result.filePath === 'src/fulfillment/express.ts')?.rank ?? Number.POSITIVE_INFINITY;
  const generatedRank = results.find((result) => result.filePath.includes('.generated.'))?.rank ?? Number.POSITIVE_INFINITY;
  const testRank = results.find((result) => result.filePath.includes('.test.'))?.rank ?? Number.POSITIVE_INFINITY;
  return productionRank < generatedRank && productionRank < testRank;
}

export function queryReport(args: QueryReportInput): QueryReport {
  const fused = metric(args.expected, args.results, 5);
  const metadata = metric(args.expected, metadataOnly(args.results), 5);
  const exactIntentPreserved = args.kind !== 'exact_query_control' || fused.topResults[0]?.symbol === first(args.expected.symbols, 'exact control expected symbol');
  const generatedOrTestDemoted = args.kind !== 'demotion_control' || generatedAndTestAreDemoted(fused.topResults);
  const materialBodyImprovement = args.kind !== 'body_query' || fused.recallAtK - metadata.recallAtK >= 1;
  const boundedNoResult = args.kind === 'no_match_control' && fused.topResults.length === 0;
  return {
    id: args.id,
    kind: args.kind,
    query: args.query,
    expected: args.expected,
    metadataOnly: metadata,
    fused,
    controlSignals: { exactIntentPreserved, generatedOrTestDemoted, materialBodyImprovement },
    boundedNoResult,
    pass: args.kind === 'no_match_control'
      ? boundedNoResult
      : fused.recallAtK === 1 && fused.mrr > 0 && fused.sourceReferenceFidelity > 0 && exactIntentPreserved && generatedOrTestDemoted && materialBodyImprovement,
  };
}

export function summarize(queries: readonly QueryReport[]): RetrievalQualityReport['summary'] {
  const passed = queries.filter((query) => query.pass).length;
  const mean = (values: readonly number[]): number => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
  const body = first(queries.filter((query) => query.kind === 'body_query'), 'body query report');
  const controls = queries.filter((query) => query.kind !== 'body_query');
  return {
    pass: passed === queries.length && body.controlSignals.materialBodyImprovement,
    total: queries.length,
    passed,
    failed: queries.length - passed,
    meanRecallAtK: mean(queries.map((query) => query.fused.recallAtK)),
    meanMrr: mean(queries.map((query) => query.fused.mrr)),
    meanSourceReferenceFidelity: mean(queries.map((query) => query.fused.sourceReferenceFidelity)),
    materialBodyImprovement: body.controlSignals.materialBodyImprovement,
    controlsPass: controls.every((query) => query.pass),
    externalServicesUsed: [],
  };
}

export function renderMarkdown(report: RetrievalQualityReport): string {
  const rows = report.queries.map((query) => `| ${query.id} | ${query.pass ? 'PASS' : 'FAIL'} | ${query.fused.recallAtK.toFixed(2)} | ${query.fused.mrr.toFixed(2)} | ${query.fused.sourceReferenceFidelity.toFixed(2)} |`).join('\n');
  const probes = report.agentEvalProbes.map((probe) => `- ${probe.id}: ${probe.status}, toolCalls=${probe.toolCalls}, Read=${probe.readCount}, Grep=${probe.grepCount}, chars=${probe.outputChars}`).join('\n');
  const centrality = report.aiderCentralityTrial
    ? `\n## Aider/PageRank candidate\n\nPass: ${report.aiderCentralityTrial.pass}\n\n| arm | recall@5 | MRR | files-to-cover | chars-to-cover |\n| --- | ---: | ---: | ---: | ---: |\n| baseline | ${report.aiderCentralityTrial.baseline.recallAtK.toFixed(2)} | ${report.aiderCentralityTrial.baseline.mrr.toFixed(2)} | ${report.aiderCentralityTrial.baseline.filesToCoverExpected ?? 'n/a'} | ${report.aiderCentralityTrial.baseline.outputCharsToCoverExpected ?? 'n/a'} |\n| centrality | ${report.aiderCentralityTrial.centrality.recallAtK.toFixed(2)} | ${report.aiderCentralityTrial.centrality.mrr.toFixed(2)} | ${report.aiderCentralityTrial.centrality.filesToCoverExpected ?? 'n/a'} | ${report.aiderCentralityTrial.centrality.outputCharsToCoverExpected ?? 'n/a'} |\n\nDecision: ${report.aiderCentralityTrial.pass ? 'candidate cleared deterministic materiality gate for further product integration' : 'candidate did not clear deterministic materiality gate; keep product retrieval unchanged'}.\n`
    : '';
  const exploreProbe = report.exploreSurfaceProbe
    ? `\n## Explore surface probe\n\nPass: ${report.exploreSurfaceProbe.pass}\n\n- query: ${report.exploreSurfaceProbe.query}\n- maxFiles: ${report.exploreSurfaceProbe.maxFiles}\n- first source file: ${report.exploreSurfaceProbe.firstSourceFile ?? 'n/a'}\n- expected first file: ${report.exploreSurfaceProbe.expectedFirstFile}\n- graph-ranked notice: ${report.exploreSurfaceProbe.graphRankedNotice}\n- output chars: ${report.exploreSurfaceProbe.outputChars}\n`
    : '';
  return `# Retrieval Quality Baseline\n\nPass: ${report.summary.pass}\n\n| query | pass | recall@5 | MRR | source-reference fidelity |\n| --- | --- | ---: | ---: | ---: |\n${rows}\n\n## agent-eval probe summary\n\n${probes}\n\n## Aider/materiality measurement only\n\n${report.budgetRelevanceCriterion.futureMaterialityThreshold}\n${centrality}${exploreProbe}`;
}
