import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

type Scope = {
  id: string;
  exitDepth: number;
  callable: boolean;
};

const CALL_SKIP = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'class', 'struct',
  'interface', 'import', 'export', 'super', 'this', 'constructor', 'else', 'do',
]);

export class ArktsExtractor {
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
        message: `ArkTS extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
    const lines = this.source.split('\n');
    const scopes: Scope[] = [{ id: fileNodeId, exitDepth: 0, callable: false }];
    let braceDepth = 0;
    let pendingComponent = false;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const lineNumber = index + 1;
      const trimmed = this.stripLineComment(line).trim();

      if (!trimmed) {
        braceDepth += this.braceDelta(line);
        this.popScopes(scopes, braceDepth);
        continue;
      }

      if (/^@(Component|Entry|CustomDialog|Reusable)\b/.test(trimmed)) {
        pendingComponent = true;
      }

      const importMatch = trimmed.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        this.createImport(importMatch[2]!, line.trim(), lineNumber, scopes[0]!.id);
        braceDepth += this.braceDelta(line);
        this.popScopes(scopes, braceDepth);
        continue;
      }

      const decl = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?(class|struct|interface)\s+([A-Za-z_$][\w$]*)/);
      if (decl) {
        const [, keyword, name] = decl;
        const kind: NodeKind = keyword === 'interface' ? 'interface' : pendingComponent || keyword === 'struct' ? 'component' : 'class';
        const node = this.createNode(kind, name!, lineNumber, line.length, scopes[scopes.length - 1]!.id, line.trim(), { isExported: /^export\b/.test(trimmed) });
        pendingComponent = false;
        if (node && line.includes('{')) scopes.push({ id: node.id, exitDepth: braceDepth + 1, callable: false });
        braceDepth += this.braceDelta(line);
        this.popScopes(scopes, braceDepth);
        continue;
      }

      const fn = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*(?::\s*[^\{]+)?/);
      if (fn) {
        const node = this.createNode('function', fn[1]!, lineNumber, line.length, scopes[scopes.length - 1]!.id, fn[2], { isExported: /^export\b/.test(trimmed), isAsync: /\basync\b/.test(trimmed) });
        if (node && line.includes('{')) scopes.push({ id: node.id, exitDepth: braceDepth + 1, callable: true });
        braceDepth += this.braceDelta(line);
        this.popScopes(scopes, braceDepth);
        continue;
      }

      const method = trimmed.match(/^(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(async)\s+)?([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*(?::\s*[^\{]+)?\s*\{/);
      if (method && scopes.length > 1 && !CALL_SKIP.has(method[4]!)) {
        const node = this.createNode('method', method[4]!, lineNumber, line.length, scopes[scopes.length - 1]!.id, method[5], {
          visibility: method[1] as Node['visibility'],
          isStatic: Boolean(method[2]),
          isAsync: Boolean(method[3]),
        });
        if (node) scopes.push({ id: node.id, exitDepth: braceDepth + 1, callable: true });
        braceDepth += this.braceDelta(line);
        this.popScopes(scopes, braceDepth);
        continue;
      }

      const variable = trimmed.match(/^(?:@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*)*(?:(const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?(?:=|;)/);
      if (variable && !CALL_SKIP.has(variable[2]!)) {
        this.createNode(variable[1] === 'const' ? 'constant' : 'variable', variable[2]!, lineNumber, line.length, scopes[scopes.length - 1]!.id, line.trim());
      }

      const fromNodeId = this.currentCallable(scopes) ?? scopes[scopes.length - 1]!.id;
      this.extractCalls(line, lineNumber, fromNodeId);

      braceDepth += this.braceDelta(line);
      this.popScopes(scopes, braceDepth);
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
      language: 'arkts',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private createImport(moduleName: string, signature: string, line: number, parentId: string): void {
    const node = this.createNode('import', moduleName, line, signature.length, parentId, signature);
    if (!node) return;
    this.unresolvedReferences.push({ fromNodeId: parentId, referenceName: moduleName, referenceKind: 'imports', line, column: 0 });
  }

  private createNode(kind: NodeKind, name: string, line: number, endColumn: number, parentId: string, signature?: string, extra: Partial<Node> = {}): Node | null {
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
      language: 'arkts',
      signature,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(node);
    this.edges.push({ source: parentId, target: id, kind: 'contains' });
    return node;
  }

  private extractCalls(line: string, lineNumber: number, fromNodeId: string): void {
    const regex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const name = match[1]!;
      if (CALL_SKIP.has(name) || /^[A-Z]/.test(name) && ['Column', 'Row', 'Text', 'Button'].includes(name)) continue;
      this.unresolvedReferences.push({ fromNodeId, referenceName: name, referenceKind: 'calls', line: lineNumber, column: match.index });
    }
  }

  private currentCallable(scopes: Scope[]): string | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i]!.callable) return scopes[i]!.id;
    }
    return null;
  }

  private stripLineComment(line: string): string {
    return line.replace(/\/\/.*$/, '');
  }

  private braceDelta(line: string): number {
    const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
    return (withoutStrings.match(/\{/g)?.length ?? 0) - (withoutStrings.match(/\}/g)?.length ?? 0);
  }

  private popScopes(scopes: Scope[], braceDepth: number): void {
    while (scopes.length > 1 && braceDepth < scopes[scopes.length - 1]!.exitDepth) scopes.pop();
  }
}
