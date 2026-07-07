import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

type BlockScope = {
  id: string;
  endPattern: RegExp;
};

const BLOCK_TYPES: Array<[RegExp, NodeKind]> = [
  [/^FUNCTION_BLOCK\s+([A-Za-z_][\w]*)\b/i, 'class'],
  [/^FUNCTION\s+([A-Za-z_][\w]*)\b(?:\s*:\s*([^;]+))?/i, 'function'],
  [/^ORGANIZATION_BLOCK\s+([A-Za-z_][\w]*)\b/i, 'class'],
  [/^DATA_BLOCK\s+([A-Za-z_][\w]*)\b/i, 'class'],
];

const CALL_SKIP = new Set(['IF', 'ELSIF', 'FOR', 'WHILE', 'CASE', 'RETURN', 'VAR', 'END_VAR']);

export class SclExtractor {
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(private filePath: string, private source: string) {}

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.parse(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `SCL extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private parse(fileNodeId: string): void {
    const scopes: BlockScope[] = [{ id: fileNodeId, endPattern: /^$/ }];
    const lines = this.source.split('\n');
    let inVarSection = false;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const lineNumber = index + 1;
      const trimmed = this.stripComment(line).trim();
      const upper = trimmed.toUpperCase();

      if (!trimmed) continue;

      if (scopes.length > 1 && scopes[scopes.length - 1]!.endPattern.test(upper)) {
        scopes.pop();
        inVarSection = false;
        continue;
      }

      const block = this.matchBlock(trimmed);
      if (block) {
        const [name, kind, signature, endPattern] = block;
        const node = this.createNode(kind, name, lineNumber, line.length, scopes[scopes.length - 1]!.id, signature ?? line.trim());
        if (node) scopes.push({ id: node.id, endPattern });
        inVarSection = false;
        continue;
      }

      if (/^VAR(?:_(?:INPUT|OUTPUT|IN_OUT|TEMP|CONSTANT|GLOBAL|STAT))?\b/i.test(trimmed)) {
        inVarSection = true;
        continue;
      }
      if (/^END_VAR\b/i.test(trimmed)) {
        inVarSection = false;
        continue;
      }

      if (inVarSection) {
        this.extractVariable(trimmed, lineNumber, line.length, scopes[scopes.length - 1]!.id);
        continue;
      }

      this.extractCalls(line, lineNumber, scopes[scopes.length - 1]!.id);
    }
  }

  private matchBlock(line: string): [string, NodeKind, string | undefined, RegExp] | null {
    for (const [pattern, kind] of BLOCK_TYPES) {
      const match = line.match(pattern);
      if (!match) continue;
      const keyword = pattern.source.split('\\s+')[0]!.replace('^', '');
      return [match[1]!, kind, match[2]?.trim(), new RegExp(`^END_${keyword}\\b`, 'i')];
    }
    return null;
  }

  private extractVariable(line: string, lineNumber: number, endColumn: number, parentId: string): void {
    const match = line.match(/^([A-Za-z_][\w]*)\s*:\s*([^;:=]+)(?:\s*:=\s*([^;]+))?\s*;/);
    if (!match) return;
    const name = match[1]!;
    const typeName = match[2]!.trim();
    this.createNode('variable', name, lineNumber, endColumn, parentId, `${name}: ${typeName}`);
  }

  private extractCalls(line: string, lineNumber: number, fromNodeId: string): void {
    const regex = /\b([A-Za-z_][\w]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const name = match[1]!;
      if (CALL_SKIP.has(name.toUpperCase())) continue;
      this.unresolvedReferences.push({ fromNodeId, referenceName: name, referenceKind: 'calls', line: lineNumber, column: match.index });
    }
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split(/[\\/]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'scl',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private createNode(kind: NodeKind, name: string, line: number, endColumn: number, parentId: string, signature?: string): Node | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name, line);
    const parent = this.nodes.find((node) => node.id === parentId);
    const qualifiedName = parent && parent.kind !== 'file' ? `${parent.qualifiedName}::${name}` : name;
    const node: Node = {
      id,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'scl',
      signature,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: parentId, target: id, kind: 'contains' });
    return node;
  }

  private stripComment(line: string): string {
    return line.replace(/\/\/.*$/, '');
  }
}
