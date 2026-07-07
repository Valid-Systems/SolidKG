import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function modifierText(node: SyntaxNode): string {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'modifiers') return child.text;
  }
  return '';
}

function firstIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'identifier') return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') return child;
    const nested = firstIdentifier(child);
    if (nested) return nested;
  }
  return null;
}

function closureBody(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'closure' || child.type === 'block' || child.type === 'lambda_expression') return child;
  }
  return null;
}

export const groovyExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation', 'juxt_function_call'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  extraClassNodeTypes: ['trait_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  classifyClassNode: (node) => node.type === 'trait_declaration' ? 'trait' : 'class',
  visitNode: (node, ctx) => {
    if (node.type === 'local_variable_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const declarator = node.namedChild(i);
        if (declarator?.type !== 'variable_declarator') continue;
        const nameNode = getChildByField(declarator, 'name') ?? declarator.namedChildren.find((c) => c.type === 'identifier');
        const valueNode = getChildByField(declarator, 'value') ?? declarator.namedChildren.find((c) => c.type === 'closure');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, ctx.source);
        if (valueNode?.type === 'closure') {
          const fn = ctx.createNode('function', name, declarator, { signature: getNodeText(valueNode, ctx.source).slice(0, 100) });
          if (fn) {
            ctx.pushScope(fn.id);
            ctx.visitFunctionBody(valueNode, fn.id);
            ctx.popScope();
          }
          continue;
        }
        ctx.createNode('variable', name, declarator);
      }
      return true;
    }

    if (node.type === 'juxt_function_call' && getChildByField(node, 'name')?.text === 'task') {
      const args = getChildByField(node, 'args');
      const taskNameNode = args ? firstIdentifier(args) : null;
      if (!taskNameNode) return false;
      const taskName = getNodeText(taskNameNode, ctx.source);
      const task = ctx.createNode('function', taskName, node, { signature: getNodeText(node, ctx.source).slice(0, 100) });
      const body = node.nextSibling && node.nextSibling.type === 'block' ? node.nextSibling : closureBody(node);
      if (task && body) {
        ctx.pushScope(task.id);
        ctx.visitFunctionBody(body, task.id);
        ctx.popScope();
      }
      return false;
    }

    if (node.type === 'method_invocation' && getChildByField(node, 'object')?.type === 'method_invocation') {
      const nameNode = getChildByField(node, 'name');
      const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (nameNode && callerId) {
        ctx.addUnresolvedReference({
          fromNodeId: callerId,
          referenceName: getNodeText(nameNode, ctx.source),
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return false;
    }

    return false;
  },
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params && !returnType) return undefined;
    const paramsText = params ? getNodeText(params, source) : '';
    return returnType ? `${getNodeText(returnType, source)} ${paramsText}` : paramsText;
  },
  getVisibility: (node) => {
    const text = modifierText(node);
    if (text.includes('private')) return 'private';
    if (text.includes('protected')) return 'protected';
    if (text.includes('public')) return 'public';
    return 'public';
  },
  isStatic: (node) => modifierText(node).includes('static'),
  isAsync: () => false,
  extractImport: (node, source) => {
    const importText = getNodeText(node, source).trim();
    const moduleNode = node.namedChildren.find((c) => c.type === 'scoped_identifier') ?? node.namedChildren.find((c) => c.type === 'identifier');
    if (!moduleNode) return null;
    return { moduleName: getNodeText(moduleNode, source), signature: importText };
  },
};
