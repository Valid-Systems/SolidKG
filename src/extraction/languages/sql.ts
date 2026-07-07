import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const SQL_BUILTIN_CALLS = new Set(['avg', 'cast', 'coalesce', 'count', 'lower', 'max', 'min', 'sum', 'trim', 'upper']);

function cleanSqlIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[`"\[]/, '')
    .replace(/[`"\]]$/, '');
}

function objectName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  const schema = getChildByField(node, 'schema');
  const name = getChildByField(node, 'name');
  if (schema && name) {
    return `${cleanSqlIdentifier(getNodeText(schema, source))}.${cleanSqlIdentifier(getNodeText(name, source))}`;
  }
  if (name) return cleanSqlIdentifier(getNodeText(name, source));
  const text = cleanSqlIdentifier(getNodeText(node, source));
  return text || null;
}

function nodeSignature(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).trim().replace(/\s+/g, ' ');
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function visitNamedChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) ctx.visitNode(child);
  }
}

function createSqlObject(kind: 'struct' | 'function', node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectName(getChildByField(node, 'name') ?? node.namedChildren.find((child) => child.type === 'object_reference') ?? null, ctx.source);
  if (!name) return false;
  const created = ctx.createNode(kind, name, node, { signature: nodeSignature(node, ctx.source) });
  if (!created) return true;

  ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  ctx.popScope();
  return true;
}

function createStandaloneQuery(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.parent?.type !== 'statement') return false;
  const name = `query@${node.startPosition.row + 1}`;
  const created = ctx.createNode('function', name, node, { signature: nodeSignature(node, ctx.source) });
  if (!created) return true;

  ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  ctx.popScope();
  return true;
}

function createCte(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = node.namedChildren.find((child) => child.type === 'identifier');
  if (!nameNode) return false;
  const name = cleanSqlIdentifier(getNodeText(nameNode, ctx.source));
  if (!name) return false;
  const created = ctx.createNode('variable', name, node, { signature: nodeSignature(node, ctx.source) });
  if (!created) return true;

  ctx.pushScope(created.id);
  visitNamedChildren(node, ctx);
  ctx.popScope();
  return true;
}

function createCteNode(name: string, line: number, node: SyntaxNode, ctx: ExtractorContext): void {
  if (ctx.nodes.some((existing) => existing.kind === 'variable' && existing.name === name && existing.filePath === ctx.filePath)) return;
  ctx.createNode('variable', name, node, { signature: `CTE ${name}`, startLine: line, endLine: line });
}

function createCtesFromSource(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const cteRe = /\bwith\s+([A-Za-z_][\w$]*)\s+as\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = cteRe.exec(ctx.source)) !== null) {
    const name = cleanSqlIdentifier(match[1]!);
    if (!name) continue;
    createCteNode(name, lineAt(ctx.source, match.index), node, ctx);
  }
  return false;
}

function addCallsFromSource(ctx: ExtractorContext): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  const callRe = /\b([A-Za-z_][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(ctx.source)) !== null) {
    const name = match[1]!;
    if (SQL_BUILTIN_CALLS.has(name.toLowerCase())) continue;
    if (ctx.nodes.some((node) => node.kind === 'function' && node.name === name && node.filePath === ctx.filePath)) continue;
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: name,
      referenceKind: 'calls',
      line: lineAt(ctx.source, match.index),
      column: columnAt(ctx.source, match.index),
    });
  }
}

function createColumn(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  const name = cleanSqlIdentifier(getNodeText(nameNode, ctx.source));
  if (!name) return false;
  const typeNode = getChildByField(node, 'type');
  const signature = typeNode ? getNodeText(typeNode, ctx.source).trim() : undefined;
  ctx.createNode('field', name, node, { signature });
  return true;
}

function addRelationReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const refNode = node.namedChildren.find((child) => child.type === 'object_reference');
  const name = objectName(refNode ?? null, ctx.source);
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!name || !fromNodeId) return false;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: 'references',
    line: (refNode ?? node).startPosition.row + 1,
    column: (refNode ?? node).startPosition.column,
  });
  return false;
}

export const sqlExtractor: LanguageExtractor = {
  functionTypes: ['create_function'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['invocation'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'function_body',
  paramsField: 'function_arguments',
  returnField: 'returns',

  resolveName: (node, source) => objectName(getChildByField(node, 'name') ?? node.namedChildren.find((child) => child.type === 'object_reference') ?? null, source) ?? undefined,
  getSignature: (node, source) => nodeSignature(node, source),

  visitNode: (node, ctx) => {
    if (node.type === 'program') {
      addCallsFromSource(ctx);
      return createCtesFromSource(node, ctx);
    }
    if (node.type === 'create_table' || node.type === 'create_view') {
      return createSqlObject('struct', node, ctx);
    }
    if (node.type === 'create_function') {
      return createSqlObject('function', node, ctx);
    }
    if (node.type === 'select') {
      return createStandaloneQuery(node, ctx);
    }
    if (node.type === 'cte') {
      return createCte(node, ctx);
    }
    if (node.type === 'column_definition') {
      return createColumn(node, ctx);
    }
    if (node.type === 'relation') {
      return addRelationReference(node, ctx);
    }
    return false;
  },
};

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function columnAt(source: string, index: number): number {
  const lastNewline = source.lastIndexOf('\n', index);
  return lastNewline < 0 ? index : index - lastNewline - 1;
}
