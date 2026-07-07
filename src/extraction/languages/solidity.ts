import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function directChildText(node: SyntaxNode, type: string, source: string): string | undefined {
  const child = node.namedChildren.find((candidate) => candidate.type === type);
  return child ? getNodeText(child, source) : undefined;
}

function hasWord(node: SyntaxNode, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(node.text);
}

export const solidityExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['contract_declaration', 'library_declaration'],
  methodTypes: [
    'function_definition',
    'constructor_definition',
    'modifier_definition',
    'event_definition',
    'error_declaration',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_definition'],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['identifier'],
  typeAliasTypes: [],
  importTypes: ['import_directive'],
  callTypes: ['call_expression', 'emit_statement', 'revert_statement'],
  variableTypes: [],
  fieldTypes: ['state_variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  resolveName: (node, source) => {
    if (node.type === 'constructor_definition') return 'constructor';
    const nameNode = getChildByField(node, 'name');
    return nameNode ? getNodeText(nameNode, source) : undefined;
  },
  getSignature: (node, source) => {
    const params = node.namedChildren
      .filter((child) => child.type === 'parameter' || child.type === 'event_paramater' || child.type === 'error_parameter')
      .map((child) => getNodeText(child, source).trim());
    const visibility = directChildText(node, 'visibility', source);
    const mutability = directChildText(node, 'state_mutability', source);
    const returnType = getChildByField(node, 'return_type');
    const parts = [`(${params.join(', ')})`];
    if (visibility) parts.push(visibility);
    if (mutability) parts.push(mutability);
    if (returnType) parts.push(getNodeText(returnType, source).trim());
    return parts.join(' ');
  },
  getVisibility: (node) => {
    const visibility = node.namedChildren.find((child) => child.type === 'visibility');
    const text = visibility?.text;
    if (text === 'public' || text === 'external') return 'public';
    if (text === 'private') return 'private';
    if (text === 'internal') return 'internal';
    return undefined;
  },
  isExported: (node) => {
    if (
      node.type === 'contract_declaration' ||
      node.type === 'interface_declaration' ||
      node.type === 'library_declaration'
    ) {
      return true;
    }
    return solidityExtractor.getVisibility?.(node) === 'public';
  },
  isStatic: (node) => hasWord(node, 'pure') || hasWord(node, 'view'),
  extractImport: (node, source) => {
    const sourceNode = getChildByField(node, 'source') || node.namedChildren.find((child) => child.type === 'string');
    if (!sourceNode) return null;
    const moduleName = getNodeText(sourceNode, source).replace(/^['"]|['"]$/g, '');
    if (!moduleName) return null;
    return { moduleName, signature: getNodeText(node, source).trim() };
  },
};
