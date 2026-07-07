import type { Node } from '../../types';
import type { QueryBuilder } from '../../db/queries';

export const MAX_CALLBACKS_PER_CHANNEL = 40;
export const EVENT_FANOUT_CAP = 6;
export const MAX_JSX_CHILDREN = 30;

const FN_KINDS = new Set(['method', 'function', 'component']);

export function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

export function enclosingFn(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const node of nodesInFile) {
    if (!FN_KINDS.has(node.kind)) continue;
    const end = node.endLine ?? node.startLine;
    if (node.startLine <= line && end >= line) {
      if (!best || node.startLine >= best.startLine) best = node;
    }
  }
  return best;
}

export function methodsContainedBy(queries: QueryBuilder, classId: string): Node[] {
  return queries
    .getOutgoingEdges(classId, ['contains'])
    .map((edge) => queries.getNodeById(edge.target))
    .filter((node): node is Node => node !== null && node.kind === 'method');
}
