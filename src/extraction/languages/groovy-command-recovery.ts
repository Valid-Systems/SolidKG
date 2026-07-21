import type { Node as SyntaxNode } from '../native-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';

const CLASS_LINE = /^\s*((?:(?:public|private|protected|abstract|final|static)\s+)*)(class|interface|trait|enum)\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)(.*?)\{/u;

function firstWord(node: SyntaxNode): string | null {
  const unit = node.namedChildren.find((child) => child.type === 'unit');
  return unit?.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
}

function blockAtBrace(node: SyntaxNode, braceIndex: number): SyntaxNode | null {
  if (node.type === 'block' && node.startIndex + node.text.indexOf('{') === braceIndex) return node;
  for (const child of node.namedChildren) {
    if (child.startIndex > braceIndex || child.endIndex <= braceIndex) continue;
    const block = blockAtBrace(child, braceIndex);
    if (block) return block;
  }
  return null;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function declarationKind(keyword: string): 'class' | 'interface' | 'trait' | 'enum' {
  if (keyword === 'interface') return 'interface';
  if (keyword === 'trait') return 'trait';
  if (keyword === 'enum') return 'enum';
  return 'class';
}

function visibility(modifiers: string): 'public' | 'private' | 'protected' {
  if (/\bprivate\b/u.test(modifiers)) return 'private';
  if (/\bprotected\b/u.test(modifiers)) return 'protected';
  return 'public';
}

function typeNames(clause: string | undefined): string[] {
  return clause
    ? clause.split(',').map((name) => name.trim().replace(/<.*>$/, '')).filter(Boolean)
    : [];
}

function addInheritance(rest: string, node: SyntaxNode, ctx: ExtractorContext): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  const clauses = [
    ['extends', /\bextends\s+(.+?)(?=\s+implements\b|$)/u.exec(rest)?.[1]],
    ['implements', /\bimplements\s+(.+)$/u.exec(rest)?.[1]],
  ] as const;
  for (const [kind, clause] of clauses) {
    for (const name of typeNames(clause)) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: name,
        referenceKind: kind,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
}

export function recoverGroovyClassesMergedIntoImports(root: SyntaxNode, ctx: ExtractorContext): void {
  const sourceLines = ctx.source.split(/\r?\n/);
  const starts = lineStarts(ctx.source);
  for (const command of root.namedChildren) {
    if (command.type !== 'command' || firstWord(command) !== 'import' || command.startPosition.row === command.endPosition.row) continue;
    let recoveredUntilIndex = command.startIndex;
    for (let row = command.startPosition.row + 1; row <= command.endPosition.row; row++) {
      const rowStart = starts[row];
      if (rowStart === undefined || rowStart < recoveredUntilIndex) continue;
      const line = sourceLines[row] ?? '';
      const match = CLASS_LINE.exec(line);
      const keyword = match?.[2];
      const name = match?.[3];
      if (!keyword || !name) continue;
      const braceColumn = line.indexOf('{');
      if (braceColumn < 0) continue;
      const block = blockAtBrace(command, rowStart + braceColumn);
      if (!block) continue;
      recoveredUntilIndex = block.endIndex;
      const declaration = ctx.createNode(declarationKind(keyword), name, block, {
        signature: line.slice(0, braceColumn).trim(),
        visibility: visibility(match[1] ?? ''),
        startLine: row + 1,
        startColumn: line.indexOf(keyword),
      });
      if (!declaration) continue;
      ctx.pushScope(declaration.id);
      addInheritance(match[4] ?? '', block, ctx);
      const bodyStart = block.startIndex + block.text.indexOf('{');
      for (const child of block.namedChildren) {
        if (child.startIndex > bodyStart) ctx.visitNode(child);
      }
      ctx.popScope();
    }
  }
}
