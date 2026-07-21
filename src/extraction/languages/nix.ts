import type { Node as SyntaxNode } from '../native-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function text(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim();
}

function firstIdentifier(node: SyntaxNode, source: string): string | null {
  const child = node.namedChildren.find((c) => c.type === 'identifier');
  return child ? text(child, source) : null;
}

function attrPath(node: SyntaxNode, source: string): string | null {
  const attrpath = getChildByField(node, 'attrpath') ?? (node.type === 'attrpath' ? node : node.namedChildren.find((c) => c.type === 'attrpath'));
  if (!attrpath) return null;
  const parts = attrpath.namedChildren
    .filter((c) => c.type === 'identifier' || c.type === 'string_fragment')
    .map((c) => text(c, source))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('.') : null;
}

function bindingExpression(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'expression') ?? node.namedChildren.find((c) => c.type.endsWith('_expression')) ?? null;
}

function isFunctionExpression(node: SyntaxNode | null): node is SyntaxNode {
  return !!node && node.type === 'function_expression';
}

function functionParams(node: SyntaxNode, source: string): string[] {
  const params: string[] = [];
  let current: SyntaxNode | null = node;
  while (current?.type === 'function_expression') {
    const formals = getChildByField(current, 'formals');
    if (formals) {
      for (const formal of formals.namedChildren.filter((c) => c.type === 'formal')) {
        const name = getChildByField(formal, 'name') ?? formal.namedChildren.find((c) => c.type === 'identifier');
        if (name) params.push(text(name, source));
      }
    } else {
      const universal = getChildByField(current, 'universal') ?? current.namedChildren.find((c) => c.type === 'identifier');
      if (universal) params.push(text(universal, source));
    }
    current = getChildByField(current, 'body');
  }
  return params;
}

function finalFunctionBody(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current?.type === 'function_expression') {
    current = getChildByField(current, 'body');
  }
  return current;
}

function pathLiteral(node: SyntaxNode, source: string): string | null {
  if (node.type === 'path_expression' || node.type === 'spath_expression') return text(node, source);
  const path = node.namedChildren.find((c) => c.type === 'path_expression' || c.type === 'spath_expression');
  return path ? text(path, source) : null;
}

function calleeName(node: SyntaxNode, source: string): string | null {
  if (node.type === 'variable_expression') return firstIdentifier(node, source);
  if (node.type === 'select_expression') {
    const base = getChildByField(node, 'expression');
    const attrs = getChildByField(node, 'attrpath');
    const baseText = base ? calleeName(base, source) ?? text(base, source) : null;
    const attrText = attrs ? attrPath(attrs, source) ?? text(attrs, source) : null;
    return [baseText, attrText].filter(Boolean).join('.') || null;
  }
  return null;
}

function emitReference(ctx: ExtractorContext, node: SyntaxNode, name: string, kind: 'references' | 'calls' | 'imports'): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function emitImport(ctx: ExtractorContext, node: SyntaxNode, moduleName: string): void {
  ctx.createNode('import', moduleName, node, { signature: moduleName });
  emitReference(ctx, node, moduleName, 'imports');
}

export const nixExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'formals',

  visitNode: (node, ctx) => {
    const source = ctx.source;

    if (node.type === 'binding') {
      const name = attrPath(node, source);
      if (!name) return false;
      const expression = bindingExpression(node);

      if (name === 'imports' && expression) {
        for (const child of expression.namedChildren) {
          const imported = pathLiteral(child, source);
          if (imported) emitImport(ctx, child, imported);
        }
      }

      if (isFunctionExpression(expression)) {
        const params = functionParams(expression, source);
        const created = ctx.createNode('function', name, node, {
          signature: params.length > 0 ? `${params.join(': ')}:` : undefined,
        });
        if (created) {
          ctx.pushScope(created.id);
          const body = finalFunctionBody(expression);
          if (body) ctx.visitNode(body);
          ctx.popScope();
        }
        return true;
      }

      const signature = expression ? `= ${text(expression, source).slice(0, 100)}` : undefined;
      const created = ctx.createNode('variable', name, node, { signature });
      if (created && expression) {
        ctx.pushScope(created.id);
        ctx.visitNode(expression);
        ctx.popScope();
      }
      return true;
    }

    if (node.type === 'apply_expression') {
      const fn = getChildByField(node, 'function') ?? node.namedChild(0);
      const arg = getChildByField(node, 'argument') ?? node.namedChild(1);
      const name = fn ? calleeName(fn, source) : null;
      if (name === 'import' && arg) {
        const imported = pathLiteral(arg, source);
        if (imported) emitImport(ctx, arg, imported);
      }
      if (name) emitReference(ctx, node, name, 'calls');
      return false;
    }

    if (node.type === 'variable_expression') {
      const name = firstIdentifier(node, source);
      if (name && !['true', 'false', 'null'].includes(name)) emitReference(ctx, node, name, 'references');
      return false;
    }

    return false;
  },
};
