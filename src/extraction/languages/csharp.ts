import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const csharpExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  importTypes: ['using_directive'],
  callTypes: ['invocation_expression'],
  variableTypes: ['local_declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter_list',
  getSignature: (node, source) => {
    const text = getNodeText(node, source);
    const header = text.slice(0, text.search(/[;{]/));
    return header.match(/\([^)]*\)/)?.[0];
  },
  visitNode: (node, ctx) => {
    if (node.type !== 'local_function_statement') return false;

    const text = getNodeText(node, ctx.source);
    const header = text.slice(0, text.indexOf('{') >= 0 ? text.indexOf('{') : text.length);
    const classMatch = header.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!classMatch) return false;

    const classNode = ctx.createNode('class', classMatch[1]!, node, {
      visibility: csharpExtractor.getVisibility?.(node),
    });
    if (!classNode) return true;

    ctx.pushScope(classNode.id);
    const body = getChildByField(node, 'body');
    const scope = body ?? node;
    for (let i = 0; i < scope.namedChildCount; i++) {
      const child = scope.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    ctx.popScope();
    return true;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
        if (text === 'internal') return 'internal';
      }
    }
    return 'private'; // C# defaults to private
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'static') {
        return true;
      }
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'async') {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C# using directives: using System, using System.Collections.Generic, using static X, using Alias = X
    const qualifiedName = node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
    if (qualifiedName) {
      return { moduleName: getNodeText(qualifiedName, source), signature: importText };
    }
    // Simple namespace like "using System;" - get the first identifier
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: getNodeText(identifier, source), signature: importText };
    }
    return null;
  },
};
