import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function getModifiers(node: SyntaxNode): string {
  const modifiers = getChildByField(node, 'modifiers') ?? node.namedChildren.find((c) => c.type === 'modifiers');
  return modifiers ? modifiers.text.toLowerCase() : '';
}

function getVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' | 'internal' | undefined {
  const text = getModifiers(node);
  if (text.includes('private')) return 'private';
  if (text.includes('protected')) return 'protected';
  if (text.includes('friend')) return 'internal';
  if (text.includes('public')) return 'public';
  return undefined;
}

export const vbnetExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_block'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_block'],
  structTypes: ['structure_block'],
  enumTypes: ['enum_block'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  importTypes: ['imports_statement'],
  callTypes: ['invocation'],
  variableTypes: ['field_declaration'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  visitNode: (node, ctx) => {
    if (node.type !== 'module_block') return false;
    const nameNode = getChildByField(node, 'name') ?? node.namedChildren.find((c) => c.type === 'identifier');
    if (!nameNode) return false;
    const moduleNode = ctx.createNode('module', getNodeText(nameNode, ctx.source), node, { visibility: getVisibility(node) });
    if (!moduleNode) return true;
    ctx.pushScope(moduleNode.id);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'modifiers' || child.type === 'identifier') continue;
      ctx.visitNode(child);
    }
    ctx.popScope();
    return true;
  },
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    const paramsText = params ? getNodeText(params, source) : '';
    return returnType ? `${paramsText} As ${getNodeText(returnType, source)}` : paramsText;
  },
  getVisibility,
  isStatic: (node) => getModifiers(node).includes('shared'),
  isAsync: (node) => getModifiers(node).includes('async'),
  extractPropertyName: (node, source) => {
    const nameNode = getChildByField(node, 'name') ?? node.namedChildren.find((c) => c.type === 'identifier');
    return nameNode ? getNodeText(nameNode, source) : null;
  },
  extractImport: (node, source) => {
    const importText = getNodeText(node, source).trim();
    const namespaceNode = getChildByField(node, 'namespace') ?? node.namedChildren.find((c) => c.type === 'namespace_name');
    if (!namespaceNode) return null;
    return { moduleName: getNodeText(namespaceNode, source).replace(/\s+/g, ''), signature: importText };
  },
};
