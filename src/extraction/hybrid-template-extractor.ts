import { Edge, ExtractionError, ExtractionResult, Language, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

type EmbeddedBlock = { content: string; startLine: number; language: Language };

export class AstroExtractor {
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(private filePath: string, private source: string) {}

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const component = this.createComponentNode();
      for (const block of [...this.extractFrontmatterBlocks(), ...this.extractScriptBlocks()]) {
        this.processEmbeddedBlock(block, component.id);
      }
      this.extractTemplateComponents(component.id);
    } catch (error) {
      this.errors.push({ message: `Astro extraction error: ${error instanceof Error ? error.message : String(error)}`, severity: 'error', code: 'parse_error' });
    }
    return this.result(startTime);
  }

  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const componentName = basename(this.filePath).replace(/\.astro$/i, '');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', componentName, 1),
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'astro',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractFrontmatterBlocks(): EmbeddedBlock[] {
    const match = this.source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return match ? [{ content: match[1] ?? '', startLine: 2, language: 'typescript' }] : [];
  }

  private extractScriptBlocks(): EmbeddedBlock[] {
    const blocks: EmbeddedBlock[] = [];
    const regex = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.source)) !== null) {
      const attrs = match[1] ?? '';
      const language: Language = /lang\s*=\s*["'](?:ts|typescript)["']/i.test(attrs) ? 'typescript' : 'javascript';
      blocks.push({ content: match[2] ?? '', startLine: lineNumber(this.source, match.index) + 1, language });
    }
    return blocks;
  }

  private extractTemplateComponents(componentNodeId: string): void {
    const covered = coveredRanges(this.source, /<script(\s[^>]*)?>[\s\S]*?<\/script>/gi);
    const tagRegex = /<([A-Z][A-Za-z0-9_.]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(this.source)) !== null) {
      if (covered.some(([start, end]) => match!.index >= start && match!.index <= end)) continue;
      const name = (match[1] ?? '').split('.').pop();
      if (!name) continue;
      this.unresolvedReferences.push({
        fromNodeId: componentNodeId,
        referenceName: name,
        referenceKind: 'references',
        line: lineNumber(this.source, match.index),
        column: columnNumber(this.source, match.index),
        filePath: this.filePath,
        language: 'astro',
      });
    }
  }

  private processEmbeddedBlock(block: EmbeddedBlock, parentNodeId: string): void {
    if (!isLanguageSupported(block.language)) return;
    const result = new TreeSitterExtractor(this.filePath, block.content, block.language).extract();
    mergeEmbeddedResult(result, block.startLine - 1, 'astro', parentNodeId, this.nodes, this.edges, this.unresolvedReferences, this.errors, this.filePath);
  }

  private result(startTime: number): ExtractionResult {
    return { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors, durationMs: Date.now() - startTime };
  }
}

export class JinjaExtractor {
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(private filePath: string, private source: string) {}

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = createTemplateFileNode(this.filePath, this.source, 'jinja');
      this.nodes.push(fileNode);
      this.extractBlocks(fileNode.id);
      this.extractTemplateReferences(fileNode.id);
    } catch (error) {
      this.errors.push({ message: `Jinja extraction error: ${error instanceof Error ? error.message : String(error)}`, severity: 'error', code: 'parse_error' });
    }
    return { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors, durationMs: Date.now() - startTime };
  }

  private extractBlocks(fileNodeId: string): void {
    const regex = /\{%[-]?\s*block\s+([A-Za-z_][A-Za-z0-9_-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.source)) !== null) {
      const name = match[1]!;
      const node = templateComponentNode(this.filePath, 'jinja', `block:${name}`, name, lineNumber(this.source, match.index), match[0], match.index, this.source);
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: node.id, kind: 'contains' });
    }
  }

  private extractTemplateReferences(fileNodeId: string): void {
    const regex = /\{%[-]?\s*(extends|include|import|from)\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.source)) !== null) {
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: normalizeTemplatePath(match[2]!),
        referenceKind: 'references',
        line: lineNumber(this.source, match.index),
        column: columnNumber(this.source, match.index),
        filePath: this.filePath,
        language: 'jinja',
      });
    }
  }
}

export class RazorExtractor {
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(private filePath: string, private source: string) {}

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = createTemplateFileNode(this.filePath, this.source, 'razor');
      this.nodes.push(fileNode);
      this.extractModel(fileNode.id);
      this.extractViewReferences(fileNode.id);
      for (const block of this.extractCSharpBlocks()) this.processEmbeddedBlock(block, fileNode.id);
    } catch (error) {
      this.errors.push({ message: `Razor extraction error: ${error instanceof Error ? error.message : String(error)}`, severity: 'error', code: 'parse_error' });
    }
    return { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors, durationMs: Date.now() - startTime };
  }

  private extractModel(fileNodeId: string): void {
    const match = this.source.match(/@model\s+([A-Za-z_][A-Za-z0-9_.<>?]*)/);
    if (!match || match.index === undefined) return;
    const name = match[1]!;
    const line = lineNumber(this.source, match.index);
    const node = templateComponentNode(this.filePath, 'razor', `model:${name}`, name.split('.').pop() ?? name, line, match[0], match.index, this.source);
    node.kind = 'type_alias';
    this.nodes.push(node);
    this.edges.push({ source: fileNodeId, target: node.id, kind: 'contains' });
    this.unresolvedReferences.push({
      fromNodeId: node.id,
      referenceName: stripGenericSuffix(name.split('.').pop() ?? name),
      referenceKind: 'type_of',
      line,
      column: columnNumber(this.source, match.index),
      filePath: this.filePath,
      language: 'razor',
    });
  }

  private extractViewReferences(fileNodeId: string): void {
    const regex = /(?:Html\.)?(?:Partial|PartialAsync|RenderPartial|RenderPartialAsync)\s*\(\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.source)) !== null) {
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: razorViewReference(this.filePath, match[1]!),
        referenceKind: 'references',
        line: lineNumber(this.source, match.index),
        column: columnNumber(this.source, match.index),
        filePath: this.filePath,
        language: 'razor',
      });
    }
  }

  private extractCSharpBlocks(): EmbeddedBlock[] {
    const blocks: EmbeddedBlock[] = [];
    for (const regex of [/@\{([\s\S]*?)\n\}/g, /@functions\s*\{([\s\S]*?)\n\}/g]) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(this.source)) !== null) {
        blocks.push({ content: match[1] ?? '', startLine: lineNumber(this.source, match.index) + 1, language: 'csharp' });
      }
    }
    return blocks;
  }

  private processEmbeddedBlock(block: EmbeddedBlock, parentNodeId: string): void {
    if (!isLanguageSupported('csharp')) return;
    const result = new TreeSitterExtractor(this.filePath, block.content, 'csharp').extract();
    mergeEmbeddedResult(result, block.startLine - 1, 'razor', parentNodeId, this.nodes, this.edges, this.unresolvedReferences, this.errors, this.filePath);
  }
}

function createTemplateFileNode(filePath: string, source: string, language: Language): Node {
  const lines = source.split('\n');
  return { id: generateNodeId(filePath, 'file', filePath, 1), kind: 'file', name: basename(filePath), qualifiedName: filePath, filePath, language, startLine: 1, endLine: lines.length, startColumn: 0, endColumn: lines[lines.length - 1]?.length || 0, updatedAt: Date.now() };
}

function templateComponentNode(filePath: string, language: Language, qualifiedPart: string, name: string, line: number, signature: string, index: number, source: string): Node {
  return { id: generateNodeId(filePath, 'component', qualifiedPart, line), kind: 'component', name, qualifiedName: `${filePath}::${qualifiedPart}`, filePath, language, signature, startLine: line, endLine: line, startColumn: columnNumber(source, index), endColumn: columnNumber(source, index) + signature.length, updatedAt: Date.now() };
}

function mergeEmbeddedResult(result: ExtractionResult, lineOffset: number, hostLanguage: Language, parentNodeId: string, nodes: Node[], edges: Edge[], refs: UnresolvedReference[], errors: ExtractionError[], filePath: string): void {
  const embeddedFileIds = new Set(result.nodes.filter((node) => node.kind === 'file').map((node) => node.id));
  for (const node of result.nodes) {
    if (embeddedFileIds.has(node.id)) continue;
    node.startLine += lineOffset;
    node.endLine += lineOffset;
    node.language = hostLanguage;
    nodes.push(node);
    edges.push({ source: parentNodeId, target: node.id, kind: 'contains' });
  }
  for (const edge of result.edges) {
    if (embeddedFileIds.has(edge.target)) continue;
    if (embeddedFileIds.has(edge.source)) edge.source = parentNodeId;
    if (edge.line) edge.line += lineOffset;
    edges.push(edge);
  }
  for (const ref of result.unresolvedReferences) {
    if (embeddedFileIds.has(ref.fromNodeId)) ref.fromNodeId = parentNodeId;
    ref.line += lineOffset;
    ref.filePath = filePath;
    ref.language = hostLanguage;
    refs.push(ref);
  }
  for (const error of result.errors) {
    if (error.line) error.line += lineOffset;
    errors.push(error);
  }
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function columnNumber(source: string, index: number): number {
  const lastNewline = source.lastIndexOf('\n', index - 1);
  return index - lastNewline - 1;
}

function coveredRanges(source: string, regex: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function normalizeTemplatePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripGenericSuffix(name: string): string {
  return name.replace(/<.*>$/, '').replace(/\?$/, '');
}

function razorViewReference(filePath: string, viewName: string): string {
  const normalized = normalizeTemplatePath(viewName);
  const withExtension = normalized.endsWith('.cshtml') ? normalized : `${normalized}.cshtml`;
  if (withExtension.includes('/')) return withExtension;
  const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return dir ? `${dir}/${withExtension}` : withExtension;
}
