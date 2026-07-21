import type { Node as SyntaxNode } from '../native-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

function childText(node: SyntaxNode, source: string, type: string): string | null {
  const child = node.namedChildren.find((c) => c.type === type);
  return child ? getNodeText(child, source).trim() : null;
}

function stringLabel(node: SyntaxNode, source: string): string | null {
  const literal = node.namedChildren.find((c) => c.type === 'template_literal');
  if (literal) return getNodeText(literal, source).trim();
  return getNodeText(node, source).trim().replace(/^"|"$/g, '') || null;
}

function blockParts(node: SyntaxNode, source: string): string[] {
  const parts: string[] = [];
  const type = childText(node, source, 'identifier');
  if (type) parts.push(type);
  for (const child of node.namedChildren) {
    if (child.type === 'string_lit') {
      const label = stringLabel(child, source);
      if (label) parts.push(label);
    }
  }
  return parts;
}

function blockKind(parts: string[]): NodeKind {
  switch (parts[0]) {
    case 'module':
      return 'module';
    case 'variable':
      return 'variable';
    case 'output':
      return 'export';
    case 'resource':
    case 'data':
    case 'provider':
      return 'component';
    default:
      return 'module';
  }
}

function blockName(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts[0] === 'resource' || parts[0] === 'data') return parts.join('.');
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('.')}` : parts[0]!;
}

function nearestBlockType(node: SyntaxNode, source: string): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'block') return blockParts(current, source)[0] ?? null;
    current = current.parent;
  }
  return null;
}

function attrName(node: SyntaxNode, source: string): string | null {
  const name = childText(node, source, 'identifier');
  return name && name !== '=' ? name : null;
}

function attrExpression(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c) => c.type === 'expression') ?? null;
}

function blockBody(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'body') ?? node.namedChildren.find((c) => c.type === 'body') ?? null;
}

function expressionText(node: SyntaxNode | null, source: string): string | undefined {
  if (!node) return undefined;
  const value = getNodeText(node, source).trim().slice(0, 100);
  return value ? `= ${value}${value.length >= 100 ? '...' : ''}` : undefined;
}

function referenceName(node: SyntaxNode, source: string): string | null {
  const base = getChildByField(node, 'name') ?? node.namedChildren.find((c) => c.type === 'identifier');
  if (!base) return null;
  const parts = [getNodeText(base, source).trim()];
  for (const child of node.namedChildren) {
    if (child.type !== 'get_attr') continue;
    const name = child.namedChildren.find((c) => c.type === 'identifier');
    if (name) parts.push(getNodeText(name, source).trim());
  }
  let sibling = node.nextNamedSibling;
  while (sibling?.type === 'get_attr') {
    const name = sibling.namedChildren.find((c) => c.type === 'identifier');
    if (name) parts.push(getNodeText(name, source).trim());
    sibling = sibling.nextNamedSibling;
  }
  return parts.filter(Boolean).join('.');
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

function moduleSource(node: SyntaxNode, source: string): string | null {
  const name = attrName(node, source);
  if (name !== 'source') return null;
  const expression = attrExpression(node);
  const stringNode = expression?.namedChildren.find((c) => c.type === 'literal_value')
    ?.namedChildren.find((c) => c.type === 'string_lit')
    ?? expression?.namedChildren.find((c) => c.type === 'string_lit');
  return stringNode ? stringLabel(stringNode, source) : null;
}

export const hclExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['function_call'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'function_arguments',

  visitNode: (node, ctx) => {
    const source = ctx.source;

    if (node.type === 'block') {
      const parts = blockParts(node, source);
      const name = blockName(parts);
      const kind = blockKind(parts);
      const created = ctx.createNode(kind, name, node, {
        signature: getNodeText(node, source).split('\n')[0]?.trim(),
      });
      if (!created) return true;
      ctx.pushScope(created.id);
      const body = blockBody(node);
      if (body) {
        for (const child of body.namedChildren) {
          if (parts[0] === 'locals' && child.type === 'attribute') {
            const localName = attrName(child, source);
            const expression = attrExpression(child);
            if (localName) {
              const localNode = ctx.createNode('variable', localName, child, { signature: expressionText(expression, source) });
              if (localNode) {
                ctx.pushScope(localNode.id);
                if (expression) ctx.visitNode(expression);
                ctx.popScope();
              }
            }
          } else {
            ctx.visitNode(child);
          }
        }
      }
      ctx.popScope();
      return true;
    }

    if (node.type === 'attribute') {
      const name = attrName(node, source);
      if (!name) return false;
      const expression = attrExpression(node);
      const blockType = nearestBlockType(node, source);
      const sourceValue = blockType === 'module' ? moduleSource(node, source) : null;
      if (sourceValue) {
        ctx.createNode('import', sourceValue, node, { signature: `source = ${sourceValue}` });
        emitReference(ctx, node, sourceValue, 'imports');
      }
      if (blockType === 'locals' || !blockType) {
        const created = ctx.createNode('variable', name, node, { signature: expressionText(expression, source) });
        if (created) {
          ctx.pushScope(created.id);
          if (expression) ctx.visitNode(expression);
          ctx.popScope();
        }
        return true;
      }
      if (expression) ctx.visitNode(expression);
      return true;
    }

    if (node.type === 'variable_expr') {
      const ref = referenceName(node, source);
      if (ref) emitReference(ctx, node, ref, 'references');
      return false;
    }

    if (node.type === 'function_call') {
      const name = childText(node, source, 'identifier');
      if (name) emitReference(ctx, node, name, 'calls');
      return false;
    }

    return false;
  },
};
