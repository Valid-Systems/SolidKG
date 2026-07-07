import { createHash } from 'crypto';
import { buildSourceChunkCodeTokenText } from './search/query-utils';
import type { FileRecord, Node, SourceChunkDiagnostic, SourceChunkRecord } from './types';

const SOURCE_CHUNK_INDEXER_VERSION = 'source-chunk-indexer-v1';

interface SourceChunkBuildInput {
  readonly file: FileRecord;
  readonly nodes: readonly Node[];
  readonly content: string;
  readonly updatedAt: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function chunkId(node: Node, chunkOrdinal: number): string {
  const identity = [
    SOURCE_CHUNK_INDEXER_VERSION,
    node.id,
    node.filePath,
    String(node.startLine),
    String(node.endLine),
    String(chunkOrdinal),
  ].join('\0');
  return `source-chunk:${sha256Hex(identity).slice(0, 32)}`;
}

function contentForNode(content: string, node: Node): { readonly content: string; readonly diagnostics?: readonly SourceChunkDiagnostic[] } {
  const lines = content.split(/\r?\n/);
  const lineCount = Math.max(lines.length, 1);
  const startLine = Math.min(Math.max(1, node.startLine), lineCount);
  const endLine = Math.min(Math.max(startLine, node.endLine), lineCount);
  const chunkContent = lines.slice(startLine - 1, endLine).join('\n');
  if (startLine === node.startLine && endLine === node.endLine) {
    return { content: chunkContent };
  }
  return {
    content: chunkContent,
    diagnostics: [{
      message: 'Node source range was clamped to file bounds while generating source chunk',
      severity: 'warning',
      code: 'source_chunk.range_clamped',
      line: startLine,
      metadata: { requestedStartLine: node.startLine, requestedEndLine: node.endLine, lineCount },
    }],
  };
}

export function buildSourceChunksForFile(input: SourceChunkBuildInput): SourceChunkRecord[] {
  const chunks: SourceChunkRecord[] = [];
  for (const node of input.nodes) {
    const chunkOrdinal = 0;
    const extracted = contentForNode(input.content, node);
    if (extracted.content.trim().length === 0) continue;
    chunks.push({
      id: chunkId(node, chunkOrdinal),
      nodeId: node.id,
      filePath: input.file.path,
      language: input.file.language,
      symbolKind: node.kind,
      startLine: node.startLine,
      endLine: node.endLine,
      contentHash: sha256Hex(extracted.content),
      sourceHash: input.file.contentHash,
      chunkOrdinal,
      indexerVersion: SOURCE_CHUNK_INDEXER_VERSION,
      content: extracted.content,
      codeTokenText: buildSourceChunkCodeTokenText(extracted.content),
      metadata: {
        producer: 'solidkg.source-chunks',
        nodeName: node.name,
        qualifiedName: node.qualifiedName,
      },
      diagnostics: extracted.diagnostics,
      updatedAt: input.updatedAt,
    });
  }
  return chunks;
}
