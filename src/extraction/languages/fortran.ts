import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function findDescendant(node: SyntaxNode, predicate: (child: SyntaxNode) => boolean): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (predicate(current)) return current;
    queue.push(...current.namedChildren);
  }
  return null;
}

function nestedName(node: SyntaxNode, source: string): string | null {
  const direct = getChildByField(node, 'name') ?? getChildByField(node, 'declarator');
  if (direct) return getNodeText(direct, source).trim();
  const named = findDescendant(node, (child) => child.type === 'name' || child.type === 'type_name' || child.type === 'identifier');
  return named ? getNodeText(named, source).trim() : null;
}

export const fortranExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: ['function', 'subroutine'],
  interfaceTypes: ['interface'],
  structTypes: ['derived_type_definition'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['use_statement'],
  callTypes: ['call_expression', 'subroutine_call'],
  variableTypes: ['variable_declaration'],
  fieldTypes: ['variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  resolveName: (node, source) => nestedName(node, source) ?? undefined,

  resolveBody: (node) => node,

  getSignature: (node, source) => {
    const params = findDescendant(node, (child) => child.type === 'parameters');
    return params ? getNodeText(params, source).trim() : undefined;
  },

  extractImport: (node, source) => {
    const module = node.namedChildren.find((child) => child.type === 'module_name');
    return module ? { moduleName: getNodeText(module, source).trim(), signature: getNodeText(node, source).trim() } : null;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'module') {
      const statement = node.namedChildren.find((child) => child.type === 'module_statement');
      const name = statement ? nestedName(statement, ctx.source) : nestedName(node, ctx.source);
      if (!name) return false;
      const mod = ctx.createNode('module', name, node);
      if (!mod) return true;
      ctx.pushScope(mod.id);
      for (const child of node.namedChildren) ctx.visitNode(child);
      ctx.popScope();
      return true;
    }

    if (node.type === 'derived_type_definition') {
      const name = nestedName(node, ctx.source);
      if (!name) return false;
      const struct = ctx.createNode('struct', name, node);
      if (!struct) return true;
      ctx.pushScope(struct.id);
      for (const child of node.namedChildren) {
        if (child.type === 'variable_declaration') {
          const fieldName = nestedName(child, ctx.source);
          if (fieldName) ctx.createNode('field', fieldName, child);
        }
      }
      ctx.popScope();
      return true;
    }

    if (node.type === 'function' || node.type === 'subroutine') {
      const name = nestedName(node, ctx.source);
      if (!name) return false;
      const func = ctx.createNode('function', name, node, {
        signature: fortranExtractor.getSignature?.(node, ctx.source),
      });
      if (!func) return true;
      ctx.pushScope(func.id);
      for (const child of node.namedChildren) {
        if (
          child.type !== 'function_statement' &&
          child.type !== 'subroutine_statement' &&
          child.type !== 'end_function_statement' &&
          child.type !== 'end_subroutine_statement'
        ) {
          ctx.visitNode(child);
        }
      }
      ctx.popScope();
      return true;
    }

    return false;
  },
};
