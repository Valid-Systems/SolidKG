import type { Edge, EdgeKind, Node } from '../types';

export type ExploreFileGroup = {
  readonly nodes: readonly Node[];
  readonly score: number;
};

type ExploreGraphRankSource = {
  readonly getNodesInFile: (filePath: string) => readonly Node[];
  readonly getOutgoingEdges: (nodeId: string) => readonly Edge[];
};

const DAMPING = 0.85;
const ITERATIONS = 24;

export function buildExploreGraphRankedFileScores(
  graph: ExploreGraphRankSource,
  fileGroups: ReadonlyMap<string, ExploreFileGroup>
): Map<string, number> {
  const filePaths = [...fileGroups.keys()].sort();
  if (filePaths.length < 2) return new Map();

  const filePathSet = new Set(filePaths);
  const nodeToFile = new Map<string, string>();
  for (const filePath of filePaths) {
    for (const node of graph.getNodesInFile(filePath)) {
      nodeToFile.set(node.id, filePath);
    }
  }

  const adjacency = new Map<string, Map<string, number>>();
  for (const filePath of filePaths) adjacency.set(filePath, new Map());
  for (const [nodeId, sourceFile] of nodeToFile) {
    for (const edge of graph.getOutgoingEdges(nodeId)) {
      const targetFile = nodeToFile.get(edge.target);
      if (!targetFile || !filePathSet.has(targetFile)) continue;
      const weight = edgeWeight(edge.kind);
      if (weight <= 0) continue;
      const outgoing = adjacency.get(sourceFile);
      if (!outgoing) continue;
      outgoing.set(targetFile, (outgoing.get(targetFile) ?? 0) + weight);
    }
  }

  const personalization = normalizeScores(
    new Map(filePaths.map((filePath) => [filePath, fileGroups.get(filePath)?.score ?? 0])),
    filePaths
  );
  let ranks = new Map(personalization);
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map(filePaths.map((filePath) => [filePath, (1 - DAMPING) * (personalization.get(filePath) ?? 0)]));
    for (const sourceFile of filePaths) {
      const outgoing = adjacency.get(sourceFile) ?? new Map<string, number>();
      const sourceRank = ranks.get(sourceFile) ?? 0;
      const totalWeight = [...outgoing.values()].reduce((sum, weight) => sum + weight, 0);
      if (totalWeight <= 0) {
        for (const targetFile of filePaths) {
          next.set(targetFile, (next.get(targetFile) ?? 0) + DAMPING * sourceRank * (personalization.get(targetFile) ?? 0));
        }
        continue;
      }
      for (const [targetFile, weight] of outgoing) {
        next.set(targetFile, (next.get(targetFile) ?? 0) + DAMPING * sourceRank * weight / totalWeight);
      }
    }
    ranks = next;
  }
  return ranks;
}

function normalizeScores(scores: ReadonlyMap<string, number>, filePaths: readonly string[]): Map<string, number> {
  const total = filePaths.reduce((sum, filePath) => sum + (scores.get(filePath) ?? 0), 0);
  if (total <= 0) {
    const uniform = 1 / Math.max(filePaths.length, 1);
    return new Map(filePaths.map((filePath) => [filePath, uniform]));
  }
  return new Map(filePaths.map((filePath) => [filePath, (scores.get(filePath) ?? 0) / total]));
}

function edgeWeight(kind: EdgeKind): number {
  switch (kind) {
    case 'calls':
      return 3;
    case 'instantiates':
    case 'extends':
    case 'implements':
      return 2;
    case 'references':
    case 'overrides':
      return 1.5;
    case 'imports':
      return 0.75;
    default:
      return 0;
  }
}
