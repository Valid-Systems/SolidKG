import type { Node as SyntaxNode } from '../native-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function findIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'identifier') return node;
  for (const child of node.namedChildren) {
    const found = findIdentifier(child);
    if (found) return found;
  }
  return null;
}

function declarationName(node: SyntaxNode, source: string): string | null {
  const head = node.namedChildren.find((child) => child.type === 'type_head' || child.type === 'signature') ?? node;
  const id = findIdentifier(head);
  return id ? getNodeText(id, source).trim() : null;
}

export const juliaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: ['abstract_definition'],
  structTypes: ['struct_definition'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'using_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['assignment'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  resolveName: (node, source) => declarationName(node, source) ?? undefined,

  resolveBody: (node) => node,

  getSignature: (node, source) => {
    const signature = node.namedChildren.find((child) => child.type === 'signature');
    return signature ? getNodeText(signature, source).trim() : undefined;
  },

  extractImport: (node, source) => {
    const text = getNodeText(node, source).trim();
    const id = findIdentifier(node);
    return id ? { moduleName: getNodeText(id, source).trim(), signature: text } : null;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'module_definition') {
      const name = getChildByField(node, 'name');
      if (!name) return false;
      const mod = ctx.createNode('module', getNodeText(name, ctx.source).trim(), node);
      if (!mod) return true;
      ctx.pushScope(mod.id);
      for (const child of node.namedChildren) ctx.visitNode(child);
      ctx.popScope();
      return true;
    }

    if (node.type === 'struct_definition') {
      const name = declarationName(node, ctx.source);
      if (!name) return false;
      const struct = ctx.createNode('struct', name, node);
      if (!struct) return true;
      ctx.pushScope(struct.id);
      for (const child of node.namedChildren) {
        if (child.type === 'typed_expression') {
          const field = findIdentifier(child);
          if (field) ctx.createNode('field', getNodeText(field, ctx.source).trim(), child);
        } else if (child.type !== 'type_head') {
          ctx.visitNode(child);
        }
      }
      ctx.popScope();
      return true;
    }

    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      const name = declarationName(node, ctx.source);
      if (!name) return false;
      const func = ctx.createNode('function', name, node, {
        signature: juliaExtractor.getSignature?.(node, ctx.source),
      });
      if (!func) return true;
      ctx.pushScope(func.id);
      for (const child of node.namedChildren) {
        if (child.type !== 'signature') ctx.visitNode(child);
      }
      ctx.popScope();
      return true;
    }

    if (node.type === 'assignment') {
      const left = node.namedChild(0);
      const right = node.namedChild(node.namedChildCount - 1);
      if (left?.type === 'identifier' && right?.type !== 'function_definition') {
        const name = getNodeText(left, ctx.source).trim();
        const value = right ? getNodeText(right, ctx.source).trim().slice(0, 100) : undefined;
        ctx.createNode('variable', name, left, value ? { signature: `= ${value}` } : undefined);
        if (right) ctx.visitNode(right);
        return true;
      }
    }

    return false;
  },
};
