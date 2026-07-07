import * as fs from 'fs';
import * as path from 'path';
import type { Edge, EdgeKind, FileRecord, Node, SearchResult } from '../../src/types.ts';

type GraphLike = {
  readonly getFiles: () => readonly Pick<FileRecord, 'path'>[];
  readonly getNodesInFile: (filePath: string) => readonly Node[];
  readonly getOutgoingEdges: (nodeId: string) => readonly Edge[];
  readonly searchNodes: (query: string, options?: { readonly limit?: number }) => readonly SearchResult[];
};

export type RankedFile = {
  readonly rank: number;
  readonly filePath: string;
  readonly score: number;
  readonly outputChars: number;
  readonly reasons: readonly string[];
};

export type CentralityArmMetrics = {
  readonly recallAtK: number;
  readonly mrr: number;
  readonly filesToCoverExpected: number | null;
  readonly outputCharsToCoverExpected: number | null;
  readonly topFiles: readonly RankedFile[];
};

export type AiderCentralityTrial = {
  readonly id: string;
  readonly query: string;
  readonly expectedFiles: readonly string[];
  readonly baseline: CentralityArmMetrics;
  readonly centrality: CentralityArmMetrics;
  readonly material: {
    readonly improvesRecall: boolean;
    readonly improvesMrr: boolean;
    readonly reducesFilesToCover: boolean;
    readonly reducesOutputCharsToCover: boolean;
    readonly outputCharReductionRatio: number | null;
  };
  readonly pass: boolean;
  readonly notes: readonly string[];
};

type FileGraph = {
  readonly filePaths: readonly string[];
  readonly adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

const PAGE_RANK_DAMPING = 0.85;
const PAGE_RANK_ITERATIONS = 30;
const TRIAL_TOP_K = 5;

const EDGE_WEIGHTS: Partial<Record<EdgeKind, number>> = {
  calls: 3,
  references: 1.5,
  imports: 0.75,
  instantiates: 2,
  implements: 2,
  extends: 2,
  overrides: 1.5,
};

function edgeWeight(kind: EdgeKind): number {
  return EDGE_WEIGHTS[kind] ?? 0;
}

function fileCharCount(root: string, filePath: string): number {
  return fs.readFileSync(path.join(root, filePath), 'utf8').length;
}

function normalizeScores(scores: ReadonlyMap<string, number>, filePaths: readonly string[]): Map<string, number> {
  let total = 0;
  for (const filePath of filePaths) total += scores.get(filePath) ?? 0;
  if (total <= 0) {
    const uniform = 1 / Math.max(filePaths.length, 1);
    return new Map(filePaths.map((filePath) => [filePath, uniform]));
  }
  return new Map(filePaths.map((filePath) => [filePath, (scores.get(filePath) ?? 0) / total]));
}

function buildFileGraph(graph: GraphLike): FileGraph {
  const filePaths = graph.getFiles().map((file) => file.path).sort();
  const nodeToFile = new Map<string, string>();
  for (const filePath of filePaths) {
    for (const node of graph.getNodesInFile(filePath)) nodeToFile.set(node.id, filePath);
  }

  const adjacency = new Map<string, Map<string, number>>();
  for (const filePath of filePaths) adjacency.set(filePath, new Map());
  for (const [nodeId, sourceFile] of nodeToFile) {
    for (const edge of graph.getOutgoingEdges(nodeId)) {
      const targetFile = nodeToFile.get(edge.target);
      if (!targetFile) continue;
      const weight = edgeWeight(edge.kind);
      if (weight <= 0) continue;
      const outgoing = adjacency.get(sourceFile);
      if (!outgoing) continue;
      outgoing.set(targetFile, (outgoing.get(targetFile) ?? 0) + weight);
    }
  }
  return { filePaths, adjacency };
}

function evidenceByFile(results: readonly SearchResult[]): Map<string, number> {
  const scores = new Map<string, number>();
  results.forEach((result, index) => {
    const reciprocalRank = 1 / (index + 1);
    const score = Math.max(result.score, 1) * reciprocalRank;
    scores.set(result.node.filePath, (scores.get(result.node.filePath) ?? 0) + score);
  });
  return scores;
}

function pageRank(fileGraph: FileGraph, personalizationInput: ReadonlyMap<string, number>): Map<string, number> {
  const personalization = normalizeScores(personalizationInput, fileGraph.filePaths);
  let ranks = new Map(personalization);

  for (let i = 0; i < PAGE_RANK_ITERATIONS; i++) {
    const next = new Map(fileGraph.filePaths.map((filePath) => [filePath, (1 - PAGE_RANK_DAMPING) * (personalization.get(filePath) ?? 0)]));
    for (const source of fileGraph.filePaths) {
      const outgoing = fileGraph.adjacency.get(source) ?? new Map<string, number>();
      const sourceRank = ranks.get(source) ?? 0;
      const totalWeight = [...outgoing.values()].reduce((sum, weight) => sum + weight, 0);
      if (totalWeight <= 0) {
        for (const target of fileGraph.filePaths) {
          next.set(target, (next.get(target) ?? 0) + PAGE_RANK_DAMPING * sourceRank * (personalization.get(target) ?? 0));
        }
        continue;
      }
      for (const [target, weight] of outgoing) {
        next.set(target, (next.get(target) ?? 0) + PAGE_RANK_DAMPING * sourceRank * weight / totalWeight);
      }
    }
    ranks = next;
  }

  return ranks;
}

function uniqueBaselineFiles(results: readonly SearchResult[]): readonly string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.node.filePath)) continue;
    seen.add(result.node.filePath);
    files.push(result.node.filePath);
  }
  return files;
}

function rankedFiles(args: {
  readonly root: string;
  readonly order: readonly string[];
  readonly scores: ReadonlyMap<string, number>;
  readonly evidence: ReadonlyMap<string, number>;
  readonly label: string;
}): readonly RankedFile[] {
  return args.order.map((filePath, index) => {
    const score = args.scores.get(filePath) ?? 0;
    const reasons = args.evidence.has(filePath)
      ? [`${args.label}`, 'query_evidence']
      : [`${args.label}`, 'graph_propagation'];
    return {
      rank: index + 1,
      filePath,
      score: Number(score.toFixed(6)),
      outputChars: fileCharCount(args.root, filePath),
      reasons,
    };
  });
}

function armMetrics(args: {
  readonly root: string;
  readonly orderedFiles: readonly string[];
  readonly scores: ReadonlyMap<string, number>;
  readonly evidence: ReadonlyMap<string, number>;
  readonly expectedFiles: readonly string[];
  readonly label: string;
}): CentralityArmMetrics {
  const topFiles = rankedFiles({ root: args.root, order: args.orderedFiles.slice(0, TRIAL_TOP_K), scores: args.scores, evidence: args.evidence, label: args.label });
  const expected = new Set(args.expectedFiles);
  const topMatches = topFiles.filter((file) => expected.has(file.filePath)).length;
  const firstRank = topFiles.find((file) => expected.has(file.filePath))?.rank;
  const remaining = new Set(args.expectedFiles);
  let outputChars = 0;
  let filesToCover: number | null = null;
  let charsToCover: number | null = null;
  for (const [index, filePath] of args.orderedFiles.entries()) {
    outputChars += fileCharCount(args.root, filePath);
    remaining.delete(filePath);
    if (remaining.size === 0) {
      filesToCover = index + 1;
      charsToCover = outputChars;
      break;
    }
  }
  return {
    recallAtK: Number((topMatches / Math.max(args.expectedFiles.length, 1)).toFixed(4)),
    mrr: firstRank ? Number((1 / firstRank).toFixed(4)) : 0,
    filesToCoverExpected: filesToCover,
    outputCharsToCoverExpected: charsToCover,
    topFiles,
  };
}

function reductionRatio(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null || baseline <= 0) return null;
  return Number(((baseline - candidate) / baseline).toFixed(4));
}

export function runAiderCentralityTrial(graph: GraphLike, root: string): AiderCentralityTrial {
  const query = 'order lifecycle coordination gateway';
  const expectedFiles = ['src/workflows/order-flow.ts'];
  const searchResults = graph.searchNodes(query, { limit: 50 });
  const evidence = evidenceByFile(searchResults);
  const fileGraph = buildFileGraph(graph);
  const centralityScores = pageRank(fileGraph, evidence);

  const baselineOrder = uniqueBaselineFiles(searchResults);
  const centralityOrder = [...fileGraph.filePaths].sort((a, b) => (centralityScores.get(b) ?? 0) - (centralityScores.get(a) ?? 0) || a.localeCompare(b));
  const baseline = armMetrics({ root, orderedFiles: baselineOrder, scores: evidence, evidence, expectedFiles, label: 'current_search_order' });
  const centrality = armMetrics({ root, orderedFiles: centralityOrder, scores: centralityScores, evidence, expectedFiles, label: 'aider_style_personalized_pagerank' });
  const outputCharReductionRatio = reductionRatio(baseline.outputCharsToCoverExpected, centrality.outputCharsToCoverExpected);
  const material = {
    improvesRecall: centrality.recallAtK > baseline.recallAtK,
    improvesMrr: centrality.mrr > baseline.mrr,
    reducesFilesToCover: baseline.filesToCoverExpected === null ? centrality.filesToCoverExpected !== null : centrality.filesToCoverExpected !== null && centrality.filesToCoverExpected < baseline.filesToCoverExpected,
    reducesOutputCharsToCover: baseline.outputCharsToCoverExpected === null ? centrality.outputCharsToCoverExpected !== null : centrality.outputCharsToCoverExpected !== null && centrality.outputCharsToCoverExpected < baseline.outputCharsToCoverExpected,
    outputCharReductionRatio,
  };
  return {
    id: 'aider-centrality-file-budget',
    query,
    expectedFiles,
    baseline,
    centrality,
    material,
    pass: centrality.recallAtK >= baseline.recallAtK && (material.improvesRecall || material.reducesFilesToCover || (outputCharReductionRatio ?? 0) >= 0.1),
    notes: [
      'Measured only: product ranking is unchanged by this trial.',
      'Aider inspiration used: personalized PageRank over referencer→definer file graph, seeded by current SolidKG query evidence.',
    ],
  };
}
