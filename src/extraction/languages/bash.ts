import type { Node as SyntaxNode } from '../native-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function commandName(node: SyntaxNode, source: string): string | null {
  const nameNode = getChildByField(node, 'name') ?? node.namedChild(0);
  if (!nameNode) return null;
  return getNodeText(nameNode, source).trim();
}

function stripShellQuotes(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function firstCommandArgument(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const field = node.fieldNameForNamedChild(i);
    if (field === 'argument') return child;
  }
  return null;
}

function hasAncestor(node: SyntaxNode, type: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === type) return true;
    current = current.parent;
  }
  return false;
}

function emitImport(callNode: SyntaxNode, moduleName: string, ctx: ExtractorContext): void {
  const imp = ctx.createNode('import', moduleName, callNode, {
    signature: getNodeText(callNode, ctx.source).trim().slice(0, 100),
  });
  if (!imp || ctx.nodeStack.length === 0) return;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return;
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: moduleName,
    referenceKind: 'imports',
    line: callNode.startPosition.row + 1,
    column: callNode.startPosition.column,
  });
}

export const bashExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['command'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: '',

  resolveName: (node, source) => {
    if (node.type === 'function_definition') {
      const name = getChildByField(node, 'name');
      return name ? getNodeText(name, source).trim() : undefined;
    }
    return undefined;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'command') {
      const name = commandName(node, ctx.source);
      if (name === 'source' || name === '.') {
        const arg = firstCommandArgument(node);
        if (arg) emitImport(node, stripShellQuotes(getNodeText(arg, ctx.source)), ctx);
        return true;
      }
      return false;
    }

    if (node.type === 'variable_assignment' && !hasAncestor(node, 'function_definition')) {
      const name = getChildByField(node, 'name');
      if (!name) return false;
      const value = getChildByField(node, 'value');
      const signature = value ? '= ' + getNodeText(value, ctx.source).slice(0, 100) : undefined;
      ctx.createNode('variable', getNodeText(name, ctx.source), node, { signature });
      return true;
    }

    return false;
  },
};
