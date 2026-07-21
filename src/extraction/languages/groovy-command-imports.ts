import type { Node as SyntaxNode } from '../native-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';

const IMPORT_LINE = /^\s*import\s+(?:static\s+)?([$_\p{ID_Start}][$_\p{ID_Continue}]*(?:\s*\.\s*(?:[$_\p{ID_Start}][$_\p{ID_Continue}]*|\*))*)(?:\s+as\s+[$_\p{ID_Start}][$_\p{ID_Continue}]*)?\s*;?\s*$/u;

function firstWord(node: SyntaxNode): string | null {
  const unit = node.namedChildren.find((child) => child.type === 'unit');
  return unit?.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
}

export function extractGroovyCommandImports(root: SyntaxNode, ctx: ExtractorContext): void {
  const lines = ctx.source.split(/\r?\n/);
  const importedRows = new Set<number>();
  for (const command of root.namedChildren) {
    if (command.type !== 'command' || firstWord(command) !== 'import') continue;
    const blockRow = command.namedChildren.find((child) => child.type === 'block')?.startPosition.row;
    const endRow = Math.min(command.endPosition.row, blockRow === undefined ? command.endPosition.row : blockRow - 1);
    for (let row = command.startPosition.row; row <= endRow; row++) {
      if (importedRows.has(row)) continue;
      const line = lines[row] ?? '';
      const moduleText = IMPORT_LINE.exec(line)?.[1];
      if (!moduleText) continue;
      importedRows.add(row);
      const moduleName = moduleText.replace(/\s*\.\s*/g, '.');
      const importNode = ctx.createNode('import', moduleName, command, {
        signature: line.trim(),
        startLine: row + 1,
        endLine: row + 1,
        startColumn: line.indexOf('import'),
        endColumn: line.length,
      });
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (!importNode || !fromNodeId) continue;
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: row + 1,
        column: line.indexOf('import'),
      });
    }
  }
}
