import type { Node as SyntaxNode } from '../native-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';
import { extractGroovyCommandImports } from './groovy-command-imports';
import { recoverGroovyClassesMergedIntoImports } from './groovy-command-recovery';

const CONTROL_WORDS = new Set([
  'assert',
  'break',
  'case',
  'catch',
  'continue',
  'else',
  'finally',
  'for',
  'if',
  'return',
  'switch',
  'throw',
  'try',
  'while',
]);

const METHOD_TYPE_WORDS = new Set([
  'boolean',
  'byte',
  'char',
  'def',
  'double',
  'float',
  'int',
  'long',
  'short',
  'void',
]);

const IDENTIFIER = /^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u;
const QUALIFIED_CALL = /[$_\p{ID_Start}][$_\p{ID_Continue}]*(?:\.[$_\p{ID_Start}][$_\p{ID_Continue}]*)*$/u;

type ReferenceKind = 'calls' | 'extends' | 'implements' | 'imports';

function currentScope(ctx: ExtractorContext) {
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  return scopeId ? ctx.nodes.find((node) => node.id === scopeId) : undefined;
}

function directBlock(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type === 'block') ?? null;
}

function directWords(node: SyntaxNode): string[] {
  const words: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'block') break;
    if (child.type !== 'unit') continue;
    const text = child.text.trim();
    if (IDENTIFIER.test(text)) words.push(text);
  }
  return words;
}

function directFunc(unit: SyntaxNode): SyntaxNode | null {
  return unit.namedChildren.find((child) => child.type === 'func') ?? null;
}

function funcName(func: SyntaxNode): string | null {
  return func.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
}

function blockHeaderFunc(block: SyntaxNode): SyntaxNode | null {
  const bodyStart = block.startIndex + block.text.indexOf('{');
  for (const child of block.namedChildren) {
    if (child.startIndex >= bodyStart) break;
    if (child.type !== 'unit') continue;
    const func = directFunc(child);
    if (func) return func;
  }
  return null;
}

function blockHeaderIdentifier(block: SyntaxNode): string | null {
  const bodyStart = block.startIndex + block.text.indexOf('{');
  const unit = block.namedChildren.find((child) => child.type === 'unit' && child.startIndex < bodyStart);
  const text = unit?.text.trim();
  return text && IDENTIFIER.test(text) ? text : null;
}

function hasDirectFunc(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) => child.type === 'unit' && directFunc(child) !== null);
}

function headerText(node: SyntaxNode): string {
  const bodyStart = node.text.indexOf('{');
  return (bodyStart < 0 ? node.text : node.text.slice(0, bodyStart)).trim();
}

function visibility(words: readonly string[]): 'public' | 'private' | 'protected' {
  if (words.includes('private')) return 'private';
  if (words.includes('protected')) return 'protected';
  return 'public';
}

function addReference(name: string, kind: ReferenceKind, node: SyntaxNode, ctx: ExtractorContext): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function visitBlockBody(block: SyntaxNode, ctx: ExtractorContext): void {
  const bodyStart = block.startIndex + block.text.indexOf('{');
  for (const child of block.namedChildren) {
    if (child.startIndex > bodyStart) ctx.visitNode(child);
  }
}

function classKind(words: readonly string[]): { keyword: string; kind: 'class' | 'interface' | 'trait' | 'enum' } | null {
  for (const keyword of ['class', 'interface', 'trait', 'enum'] as const) {
    if (words.includes(keyword)) return { keyword, kind: keyword };
  }
  return null;
}

function typeNames(clause: string | undefined): string[] {
  if (!clause) return [];
  return clause
    .split(',')
    .map((name) => name.trim().replace(/<.*>$/, ''))
    .filter((name) => IDENTIFIER.test(name) || name.includes('.'));
}

function addInheritance(header: string, node: SyntaxNode, ctx: ExtractorContext): void {
  const extendsClause = /\bextends\s+(.+?)(?=\s+implements\b|$)/u.exec(header)?.[1];
  const implementsClause = /\bimplements\s+(.+)$/u.exec(header)?.[1];
  for (const name of typeNames(extendsClause)) addReference(name, 'extends', node, ctx);
  for (const name of typeNames(implementsClause)) addReference(name, 'implements', node, ctx);
}

function visitClass(node: SyntaxNode, words: readonly string[], block: SyntaxNode, ctx: ExtractorContext): boolean {
  const classification = classKind(words);
  if (!classification) return false;
  const keywordIndex = words.indexOf(classification.keyword);
  const name = words[keywordIndex + 1] ?? blockHeaderIdentifier(block);
  if (!name) return true;
  const declaration = ctx.createNode(classification.kind, name, node, {
    signature: headerText(node),
    visibility: visibility(words),
  });
  if (!declaration) return true;
  ctx.pushScope(declaration.id);
  addInheritance(headerText(node), node, ctx);
  visitBlockBody(block, ctx);
  ctx.popScope();
  return true;
}

function isMethodPrefix(words: readonly string[], scopeName: string, name: string): boolean {
  if (name === scopeName) return true;
  const typeWord = [...words].reverse().find((word) => !['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized'].includes(word));
  if (!typeWord) return false;
  return METHOD_TYPE_WORDS.has(typeWord) || /^[A-Z]/u.test(typeWord) || typeWord.includes('.') || typeWord.includes('<');
}

function visitMethod(node: SyntaxNode, words: readonly string[], block: SyntaxNode, ctx: ExtractorContext): boolean {
  const scope = currentScope(ctx);
  if (!scope || !['class', 'interface', 'trait', 'enum'].includes(scope.kind)) return false;
  const func = blockHeaderFunc(block);
  const name = func ? funcName(func) : null;
  if (!name || !isMethodPrefix(words, scope.name, name)) return false;
  const method = ctx.createNode('method', name, node, {
    signature: headerText(node),
    visibility: visibility(words),
    isStatic: words.includes('static'),
  });
  if (!method) return true;
  ctx.pushScope(method.id);
  visitBlockBody(block, ctx);
  ctx.popScope();
  return true;
}

function closureDeclarationName(words: readonly string[], block: SyntaxNode): string | null {
  if (!block.text.slice(0, block.text.indexOf('{')).includes('=')) return null;
  const defIndex = words.indexOf('def');
  return words[defIndex + 1] ?? words[words.length - 1] ?? null;
}

function visitClosureDeclaration(node: SyntaxNode, words: readonly string[], block: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = closureDeclarationName(words, block);
  if (!name || !IDENTIFIER.test(name)) return false;
  const scope = currentScope(ctx);
  const kind = scope && ['class', 'interface', 'trait', 'enum'].includes(scope.kind) ? 'method' : 'function';
  const declaration = ctx.createNode(kind, name, node, {
    signature: headerText(node),
    visibility: visibility(words),
    isStatic: words.includes('static'),
  });
  if (!declaration) return true;
  ctx.pushScope(declaration.id);
  visitBlockBody(block, ctx);
  ctx.popScope();
  return true;
}

function blockCallName(block: SyntaxNode): string | null {
  const bodyOffset = block.text.indexOf('{');
  if (bodyOffset < 0 || block.text.slice(0, bodyOffset).includes('=')) return null;
  const bodyStart = block.startIndex + bodyOffset;
  const unit = block.namedChildren.find((child) => child.type === 'unit' && child.startIndex < bodyStart);
  if (!unit || directFunc(unit)) return null;
  return QUALIFIED_CALL.exec(unit.text.trim())?.[0] ?? null;
}

function callName(func: SyntaxNode): string | null {
  const name = funcName(func);
  if (!name || CONTROL_WORDS.has(name)) return null;
  const unit = func.parent?.type === 'unit' ? func.parent : null;
  const candidate = unit ? QUALIFIED_CALL.exec(unit.text.slice(0, unit.text.indexOf('(')).trim())?.[0] : null;
  const qualifiedName = candidate ?? name;
  return qualifiedName.replace(/^(?:this|super)\./u, '');
}

function taskName(block: SyntaxNode): string | null {
  const bodyStart = block.startIndex + block.text.indexOf('{');
  const unit = block.namedChildren.find((child) => child.type === 'unit' && child.startIndex < bodyStart);
  return unit && IDENTIFIER.test(unit.text.trim()) ? unit.text.trim() : null;
}

function visitCommand(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const words = directWords(node);
  if (words.includes('package') || words.includes('import') || /^\s*(?:package|import)\b/u.test(node.text)) return true;
  const block = directBlock(node);
  if (block && visitClass(node, words, block, ctx)) return true;
  if (block && visitMethod(node, words, block, ctx)) return true;
  if (block && visitClosureDeclaration(node, words, block, ctx)) return true;
  if (block && words[0] === 'task') {
    const name = taskName(block);
    if (!name) return true;
    const task = ctx.createNode('function', name, node, { signature: headerText(node) });
    if (!task) return true;
    ctx.pushScope(task.id);
    visitBlockBody(block, ctx);
    ctx.popScope();
    return true;
  }

  const scope = currentScope(ctx);
  if (!scope || !['function', 'method'].includes(scope.kind)) return false;
  const closureCall = block ? blockCallName(block) : null;
  if (block && closureCall) addReference(closureCall, 'calls', block, ctx);
  const keyword = words[0];
  if (!closureCall && keyword && !CONTROL_WORDS.has(keyword) && !hasDirectFunc(node)) {
    addReference(keyword, 'calls', node, ctx);
  }
  return false;
}

export function visitGroovyCommandNode(node: SyntaxNode, ctx: ExtractorContext): boolean | undefined {
  if (node.type === 'source_file') {
    extractGroovyCommandImports(node, ctx);
    recoverGroovyClassesMergedIntoImports(node, ctx);
    return false;
  }
  if (node.type === 'command') return visitCommand(node, ctx);
  if (node.type !== 'func') return undefined;
  const directName = funcName(node);
  if (directName && CONTROL_WORDS.has(directName)) return false;
  const name = callName(node);
  if (name) addReference(name, 'calls', node, ctx);
  return true;
}
