import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === type) return current;
    queue.push(...current.namedChildren);
  }
  return null;
}

function commandName(node: SyntaxNode, source: string): string | null {
  const nameNode = getChildByField(node, 'command_name') ?? node.namedChildren.find((child) => child.type === 'command_name' || child.type === 'command_name_expr');
  if (!nameNode) return null;
  return getNodeText(nameNode, source).trim();
}

function commandArgs(node: SyntaxNode): SyntaxNode[] {
  const elements = node.namedChildren.find((child) => child.type === 'command_elements');
  if (!elements) return [];
  return elements.namedChildren.filter((child) => child.type !== 'command_argument_sep' && child.type !== 'command_parameter');
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function emitImport(commandNode: SyntaxNode, moduleName: string, ctx: ExtractorContext): void {
  const imp = ctx.createNode('import', moduleName, commandNode, {
    signature: getNodeText(commandNode, ctx.source).trim().slice(0, 100),
  });
  if (!imp || ctx.nodeStack.length === 0) return;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return;
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: moduleName,
    referenceKind: 'imports',
    line: commandNode.startPosition.row + 1,
    column: commandNode.startPosition.column,
  });
}

export const powershellExtractor: LanguageExtractor = {
  functionTypes: ['function_statement'],
  classTypes: ['class_statement'],
  methodTypes: ['class_method_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['command'],
  variableTypes: [],
  propertyTypes: ['class_property_definition'],
  nameField: 'name',
  bodyField: 'script_block',
  paramsField: 'parameter_list',

  resolveName: (node, source) => {
    if (node.type === 'function_statement') {
      const name = node.namedChildren.find((child) => child.type === 'function_name');
      return name ? getNodeText(name, source).trim() : undefined;
    }
    if (node.type === 'class_statement' || node.type === 'class_method_definition') {
      const name = node.namedChildren.find((child) => child.type === 'simple_name');
      return name ? getNodeText(name, source).trim() : undefined;
    }
    return undefined;
  },

  extractPropertyName: (node, source) => {
    const variable = node.namedChildren.find((child) => child.type === 'variable');
    return variable ? getNodeText(variable, source).replace(/^\$/, '').replace(/^$/, '') : null;
  },

  getSignature: (node, source) => {
    const params = findDescendant(node, 'parameter_list') ?? findDescendant(node, 'class_method_parameter_list');
    return params ? getNodeText(params, source).trim() : undefined;
  },

  resolveBody: (node) => {
    return node.namedChildren.find((child) => child.type === 'script_block') ?? null;
  },

  visitNode: (node, ctx) => {
    if (node.type !== 'command') return false;

    const name = commandName(node, ctx.source);
    if (!name) return false;

    if (name === 'using') {
      const args = commandArgs(node);
      if (args.length >= 2 && getNodeText(args[0]!, ctx.source).toLowerCase() === 'module') {
        emitImport(node, unquote(getNodeText(args[1]!, ctx.source)), ctx);
        return true;
      }
      return false;
    }

    if (name.toLowerCase() === 'import-module') {
      const arg = commandArgs(node)[0];
      if (arg) emitImport(node, unquote(getNodeText(arg, ctx.source)), ctx);
      return true;
    }

    const firstChild = node.namedChild(0);
    if (firstChild?.type === 'command_invokation_operator' && firstChild.text === '.') {
      emitImport(node, name, ctx);
      return true;
    }

    return false;
  },
};
