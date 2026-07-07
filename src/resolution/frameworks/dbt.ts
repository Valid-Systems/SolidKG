import * as path from 'path';
import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

const REF_RE = /\bref\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const SOURCE_RE = /\bsource\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const MACRO_DEF_RE = /\{%\s*macro\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*%\}/g;
const JINJA_CALL_RE = /\{[{%]\s*([A-Za-z_][\w]*)\s*\(/g;
const DBT_BUILTINS = new Set(['config', 'ref', 'source', 'var', 'env_var', 'doc', 'log', 'run_query', 'adapter', 'exceptions']);

export const dbtResolver: FrameworkResolver = {
  name: 'dbt',
  languages: ['sql', 'yaml'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('dbt_project.yml') || context.fileExists('dbt_project.yaml')) return true;
    return context.getAllFiles().some((file) => {
      if (!file.endsWith('.sql') && !file.endsWith('.yml') && !file.endsWith('.yaml')) return false;
      const content = context.readFile(file);
      return !!content && (/\bref\s*\(/.test(content) || /\bsource\s*\(/.test(content) || /\{%\s*macro\s+/.test(content));
    });
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const exact = context.getNodesByName(ref.referenceName).filter((node) => isDbtTarget(node));
    if (exact.length === 1) return frameworkResult(ref, exact[0]!.id);
    return null;
  },

  extract(filePath: string, content: string) {
    if (!isDbtFile(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const normalized = normalizePath(filePath);

    if (normalized.endsWith('.sql')) {
      extractSqlDbt(filePath, normalized, content, nodes, references);
    } else if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) {
      extractYamlSources(filePath, content, nodes);
    }

    return { nodes, references };
  },
};

function frameworkResult(ref: UnresolvedRef, targetNodeId: string): ResolvedRef {
  return { original: ref, targetNodeId, confidence: 0.95, resolvedBy: 'framework' };
}

function isDbtTarget(node: Node): boolean {
  return node.language === 'sql' || node.language === 'yaml';
}

function isDbtFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.endsWith('.sql') || normalized.endsWith('.yml') || normalized.endsWith('.yaml');
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function extractSqlDbt(
  filePath: string,
  normalizedPath: string,
  content: string,
  nodes: Node[],
  references: UnresolvedRef[]
): void {
  const now = Date.now();
  const modelNode = isModelSql(normalizedPath)
    ? makeNode('struct', modelName(filePath), filePath, 'sql', 1, 0, 1, 0, now, `dbt model ${modelName(filePath)}`)
    : null;
  if (modelNode) nodes.push(modelNode);

  let match: RegExpExecArray | null;
  while ((match = MACRO_DEF_RE.exec(content)) !== null) {
    const name = match[1]!;
    const line = lineAt(content, match.index);
    nodes.push(makeNode('function', name, filePath, 'sql', line, 0, line, match[0].length, now, `macro(${match[2] ?? ''})`));
  }

  if (!modelNode) return;

  while ((match = REF_RE.exec(content)) !== null) {
    addRef(references, modelNode.id, match[1]!, filePath, 'sql', content, match.index);
  }
  while ((match = SOURCE_RE.exec(content)) !== null) {
    addRef(references, modelNode.id, `${match[1]}.${match[2]}`, filePath, 'sql', content, match.index);
  }
  while ((match = JINJA_CALL_RE.exec(content)) !== null) {
    const name = match[1]!;
    if (!DBT_BUILTINS.has(name)) addRef(references, modelNode.id, name, filePath, 'sql', content, match.index, 'calls');
  }
}

function isModelSql(normalizedPath: string): boolean {
  const parts = normalizedPath.split('/');
  return normalizedPath.endsWith('.sql') && parts.includes('models') && !parts.includes('macros');
}

function modelName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function extractYamlSources(filePath: string, content: string, nodes: Node[]): void {
  if (!/\bsources\s*:/.test(content)) return;
  const now = Date.now();
  const lines = content.split(/\r?\n/);
  let currentSource: string | null = null;
  let inTables = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sourceMatch = /^\s*-\s*name\s*:\s*['"]?([\w.-]+)['"]?\s*$/.exec(line);
    if (sourceMatch && !inTables) {
      currentSource = sourceMatch[1]!;
      continue;
    }
    if (/^\s*tables\s*:/.test(line)) {
      inTables = true;
      continue;
    }
    if (inTables) {
      const tableMatch = /^\s*-\s*name\s*:\s*['"]?([\w.-]+)['"]?\s*$/.exec(line);
      if (tableMatch && currentSource) {
        const name = `${currentSource}.${tableMatch[1]!}`;
        nodes.push(makeNode('struct', name, filePath, 'yaml', i + 1, 0, i + 1, line.length, now, 'dbt source'));
      }
      if (/^\s*-\s*name\s*:/.test(line) && !/^\s{6,}-/.test(line)) inTables = false;
    }
  }
}

function addRef(
  references: UnresolvedRef[],
  fromNodeId: string,
  referenceName: string,
  filePath: string,
  language: 'sql',
  content: string,
  index: number,
  referenceKind: 'references' | 'calls' = 'references'
): void {
  references.push({
    fromNodeId,
    referenceName,
    referenceKind,
    line: lineAt(content, index),
    column: columnAt(content, index),
    filePath,
    language,
  });
}

function makeNode(
  kind: Node['kind'],
  name: string,
  filePath: string,
  language: 'sql' | 'yaml',
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  now: number,
  signature?: string
): Node {
  return {
    id: `dbt:${kind}:${filePath}:${name}:${startLine}`,
    kind,
    name,
    qualifiedName: `${filePath}::dbt::${name}`,
    filePath,
    language,
    startLine,
    endLine,
    startColumn,
    endColumn,
    signature,
    updatedAt: now,
  };
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function columnAt(source: string, index: number): number {
  const lastNewline = source.lastIndexOf('\n', index);
  return lastNewline < 0 ? index : index - lastNewline - 1;
}
