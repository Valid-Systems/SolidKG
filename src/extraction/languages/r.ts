import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function findDescendant(node: SyntaxNode, predicate: (child: SyntaxNode) => boolean): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (predicate(current)) return current;
    queue.push(...current.namedChildren);
  }
  return null;
}

function stringContent(node: SyntaxNode, source: string): string | null {
  const content = findDescendant(node, (child) => child.type === 'string_content');
  if (content) return getNodeText(content, source).trim();
  if (node.type === 'string') return getNodeText(node, source).replace(/^['"]|['"]$/g, '');
  return null;
}

function callName(node: SyntaxNode, source: string): string | null {
  const fn = getChildByField(node, 'function') ?? node.namedChild(0);
  return fn ? getNodeText(fn, source).trim() : null;
}

function callArguments(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'arguments') ?? node.namedChildren.find((child) => child.type === 'arguments') ?? null;
}

function emitFunctionAssignment(ctx: ExtractorContext, name: string, fn: SyntaxNode): boolean {
  const params = getChildByField(fn, 'parameters');
  const func = ctx.createNode('function', name, fn, {
    signature: params ? getNodeText(params, ctx.source).trim() : undefined,
  });
  if (!func) return true;
  const body = getChildByField(fn, 'body') ?? fn.namedChildren.find((child) => child.type === 'braced_expression');
  ctx.pushScope(func.id);
  if (body) ctx.visitFunctionBody(body, func.id);
  ctx.popScope();
  return true;
}

function emitR6Class(node: SyntaxNode, ctx: ExtractorContext, name: string, call: SyntaxNode): boolean {
  const cls = ctx.createNode('class', name, node);
  if (!cls) return true;
  ctx.pushScope(cls.id);
  const args = callArguments(call);
  if (args) {
    for (const arg of args.namedChildren.filter((child) => child.type === 'argument')) {
      const value = getChildByField(arg, 'value') ?? arg.namedChildren[arg.namedChildCount - 1];
      if (!value || value.type !== 'call' || callName(value, ctx.source) !== 'list') continue;
      const listArgs = callArguments(value);
      if (!listArgs) continue;
      for (const member of listArgs.namedChildren.filter((child) => child.type === 'argument')) {
        const memberNameNode = getChildByField(member, 'name');
        const memberValue = getChildByField(member, 'value') ?? member.namedChildren[member.namedChildCount - 1];
        if (!memberNameNode || !memberValue) continue;
        const memberName = getNodeText(memberNameNode, ctx.source).trim();
        if (memberValue.type === 'function_definition') {
          emitFunctionAssignment(ctx, memberName, memberValue);
        } else {
          ctx.createNode('field', memberName, member);
        }
      }
    }
  }
  ctx.popScope();
  return true;
}

export const rExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call'],
  variableTypes: ['binary_operator'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  resolveName: (node) => {
    if (node.type === 'function_definition') return '<anonymous>';
    return undefined;
  },

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source).trim() : undefined;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'call') {
      const name = callName(node, ctx.source);
      if (name === 'library' || name === 'require' || name === 'source') {
        const args = callArguments(node);
        const firstArg = args?.namedChildren.find((child) => child.type === 'argument');
        const value = firstArg ? (getChildByField(firstArg, 'value') ?? firstArg.namedChild(0)) : null;
        const moduleName = value ? (stringContent(value, ctx.source) ?? getNodeText(value, ctx.source).trim()) : null;
        if (moduleName) {
          ctx.createNode('import', moduleName, node, { signature: getNodeText(node, ctx.source).trim() });
          const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
          if (fromNodeId) {
            ctx.addUnresolvedReference({
              fromNodeId,
              referenceName: moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
          return true;
        }
      }
      return false;
    }

    if (node.type === 'binary_operator') {
      const lhs = getChildByField(node, 'lhs') ?? node.namedChild(0);
      const rhs = getChildByField(node, 'rhs') ?? node.namedChild(node.namedChildCount - 1);
      if (lhs?.type !== 'identifier' || !rhs) return false;
      const name = getNodeText(lhs, ctx.source).trim();
      if (rhs.type === 'function_definition') return emitFunctionAssignment(ctx, name, rhs);
      if (rhs.type === 'call' && callName(rhs, ctx.source) === 'R6::R6Class') return emitR6Class(node, ctx, name, rhs);
      const value = getNodeText(rhs, ctx.source).trim().slice(0, 100);
      ctx.createNode('variable', name, lhs, value ? { signature: `= ${value}` } : undefined);
      return false;
    }

    return false;
  },
};
