import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
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

function findDescendantByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (node.fieldNameForNamedChild(i) === fieldName) return child;
    const nested = findDescendantByField(child, fieldName);
    if (nested) return nested;
  }
  return null;
}

function simpleName(node: SyntaxNode, source: string): string | null {
  if (node.type === 'simple_identifier' || node.type === 'hierarchical_identifier') {
    const text = getNodeText(node, source).trim();
    return text.split(/[.:]/).pop() || text;
  }
  const named = findDescendantByField(node, 'name') ?? findDescendant(node, (child) =>
    child.type === 'simple_identifier' || child.type === 'hierarchical_identifier'
  );
  return named ? simpleName(named, source) : null;
}

function emitCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return true;
  const target = findDescendant(node, (child) =>
    child.type === 'hierarchical_identifier' || child.type === 'simple_identifier'
  );
  const name = target ? simpleName(target, ctx.source) : null;
  if (name) {
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: name,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
  return true;
}

function emitEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = findDescendantByField(node, 'type_name');
  const name = nameNode ? getNodeText(nameNode, ctx.source).trim() : null;
  if (!name) return false;
  const enumNode = ctx.createNode('enum', name, node);
  if (!enumNode) return true;
  ctx.pushScope(enumNode.id);
  const members: SyntaxNode[] = [];
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'enum_name_declaration') members.push(current);
    queue.push(...current.namedChildren);
  }
  for (const member of members) {
    const memberName = simpleName(member, ctx.source);
    if (memberName) ctx.createNode('enum_member', memberName, member);
  }
  ctx.popScope();
  return true;
}

export const systemverilogExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'task_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: [],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['package_import_declaration'],
  callTypes: [],
  variableTypes: ['data_declaration'],
  fieldTypes: ['class_property'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  resolveName: (node, source) => simpleName(node, source) ?? undefined,

  resolveBody: (node) => {
    if (node.type === 'function_declaration' || node.type === 'task_declaration') {
      return findDescendant(node, (child) =>
        child.type === 'function_statement_or_null' || child.type === 'task_statement_or_null'
      );
    }
    if (node.type === 'class_constructor_declaration') {
      return findDescendant(node, (child) => child.type === 'function_statement_or_null');
    }
    return node;
  },

  getSignature: (node, source) => {
    const params = findDescendant(node, (child) => child.type === 'tf_port_list' || child.type === 'class_constructor_arg_list');
    return params ? getNodeText(params, source) : undefined;
  },

  extractImport: (node, source) => {
    const text = getNodeText(node, source).trim();
    const pkg = findDescendant(node, (child) => child.type === 'package_identifier' || child.type === 'simple_identifier');
    return pkg ? { moduleName: getNodeText(pkg, source).trim(), signature: text } : null;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'module_declaration') {
      const name = simpleName(node, ctx.source);
      if (!name) return false;
      const moduleNode = ctx.createNode('module', name, node);
      if (!moduleNode) return true;
      ctx.pushScope(moduleNode.id);
      for (const child of node.namedChildren) ctx.visitNode(child);
      ctx.popScope();
      return true;
    }

    if (node.type === 'type_declaration' && findDescendant(node, (child) => child.type === 'enum_name_declaration')) {
      return emitEnum(node, ctx);
    }

    if (node.type === 'class_property') {
      const name = findDescendantByField(node, 'name') ?? findDescendant(node, (child) => child.type === 'simple_identifier');
      if (name) ctx.createNode('field', getNodeText(name, ctx.source).trim(), node);
      return true;
    }

    if (node.type === 'class_method') {
      const constructor = node.namedChildren.find((child) => child.type === 'class_constructor_declaration');
      if (constructor) {
        const methodNode = ctx.createNode('method', 'new', constructor, {
          signature: systemverilogExtractor.getSignature?.(constructor, ctx.source),
        });
        if (!methodNode) return true;
        ctx.pushScope(methodNode.id);
        for (const child of constructor.namedChildren) ctx.visitNode(child);
        ctx.popScope();
        return true;
      }
    }

    if (node.type === 'function_subroutine_call' || node.type === 'subroutine_call' || node.type === 'tf_call') {
      return emitCall(node, ctx);
    }

    return false;
  },
};
