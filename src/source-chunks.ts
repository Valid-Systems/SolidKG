import { createHash } from "crypto";
import { buildSourceChunkCodeTokenText } from "./search/query-utils";
import type { FileRecord, Node, SourceChunkDiagnostic, SourceChunkRecord } from "./types";

const SOURCE_CHUNK_INDEXER_VERSION = "source-chunk-indexer-v1";
const MAX_SOURCE_CHUNK_BYTES = 8_192;
const MAX_SOURCE_CHUNKS_PER_FILE = 1_024;
export const SOURCE_CHUNK_PROJECTION_BATCH_FILE_LIMIT = 128;
export const MAX_SOURCE_CHUNK_PROJECTION_BATCH_BYTES = 32 * 1024 * 1024;
const SOURCE_CHUNK_PROJECTION_ROW_OVERHEAD_BYTES = 128;

interface SourceChunkBuildInput { readonly file: FileRecord; readonly nodes: readonly Node[]; readonly content: string; readonly updatedAt: number; }

export function estimateSourceChunkProjectionFileBytes(
  chunks: readonly Pick<SourceChunkRecord, "content" | "codeTokenText">[],
): number {
  return chunks.reduce(
    (byteLength, chunk) => byteLength
      + Buffer.byteLength(chunk.content, "utf8")
      + Buffer.byteLength(chunk.codeTokenText, "utf8")
      + SOURCE_CHUNK_PROJECTION_ROW_OVERHEAD_BYTES,
    0,
  );
}

export function shouldFlushSourceChunkProjectionBatch(input: {
  readonly currentFileCount: number;
  readonly currentByteLength: number;
  readonly nextFileByteLength: number;
}): boolean {
  return input.currentFileCount > 0 && (
    input.currentFileCount >= SOURCE_CHUNK_PROJECTION_BATCH_FILE_LIMIT
    || input.currentByteLength + input.nextFileByteLength > MAX_SOURCE_CHUNK_PROJECTION_BATCH_BYTES
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chunkId(node: Node, chunkOrdinal: number): string {
  const identity = [SOURCE_CHUNK_INDEXER_VERSION, node.id, node.filePath, String(node.startLine), String(node.endLine), String(chunkOrdinal)].join("\0");
  return `source-chunk:${sha256Hex(identity).slice(0, 32)}`;
}

interface SourceRange { readonly startLine: number; readonly endLine: number; readonly diagnostics?: readonly SourceChunkDiagnostic[]; }
interface SourceChunkPart { readonly content: string; readonly startLine: number; readonly endLine: number; }
interface SourceChunkPartition { readonly parts: readonly SourceChunkPart[]; readonly hasMore: boolean; }

function sourceRangeForNode(lines: readonly string[], node: Node): SourceRange {
  const lineCount = Math.max(lines.length, 1);
  const startLine = Math.min(Math.max(1, node.startLine), lineCount);
  const endLine = Math.min(Math.max(startLine, node.endLine), lineCount);
  if (startLine === node.startLine && endLine === node.endLine) {
    return { startLine, endLine };
  }
  return { startLine, endLine, diagnostics: [{ message: "Node source range was clamped to file bounds while generating source chunk", severity: "warning", code: "source_chunk.range_clamped", line: startLine, metadata: { requestedStartLine: node.startLine, requestedEndLine: node.endLine, lineCount } }] };
}

function contentForRange(lines: readonly string[], range: SourceRange): string {
  return lines.slice(range.startLine - 1, range.endLine).join("\n");
}

function hasNonWhitespaceContent(lines: readonly string[], range: SourceRange): boolean {
  return lines.slice(range.startLine - 1, range.endLine).some((line) => line.trim().length > 0);
}

function sourceRangeByteLength(lines: readonly string[], range: SourceRange): number {
  let byteLength = 0;
  let isFirstLine = true;
  for (const line of lines.slice(range.startLine - 1, range.endLine)) {
    if (!isFirstLine) byteLength += 1;
    byteLength += Buffer.byteLength(line, "utf8");
    isFirstLine = false;
  }
  return byteLength;
}

function splitUtf8(value: string, maxFragments: number): { readonly fragments: readonly string[]; readonly hasMore: boolean; } {
  const fragments: string[] = [];
  let currentCodePoints: string[] = [];
  let currentByteLength = 0;

  for (const codePoint of value) {
    const codePointByteLength = Buffer.byteLength(codePoint, "utf8");
    if (currentByteLength > 0 && currentByteLength + codePointByteLength > MAX_SOURCE_CHUNK_BYTES) {
      if (fragments.length === maxFragments) return { fragments, hasMore: true };
      fragments.push(currentCodePoints.join(""));
      currentCodePoints = [];
      currentByteLength = 0;
    }
    currentCodePoints.push(codePoint);
    currentByteLength += codePointByteLength;
  }

  if (currentCodePoints.length === 0) return { fragments, hasMore: false };
  if (fragments.length === maxFragments) return { fragments, hasMore: true };
  fragments.push(currentCodePoints.join(""));
  return { fragments, hasMore: false };
}

function partitionOversizedRange(lines: readonly string[], range: SourceRange, maxParts: number): SourceChunkPartition {
  const parts: SourceChunkPart[] = [];
  let currentParts: string[] = [];
  let currentByteLength = 0;
  let currentStartLine = range.startLine;
  let currentEndLine = range.startLine;
  let currentStarted = false;
  let lineNumber = range.startLine;

  for (const line of lines.slice(range.startLine - 1, range.endLine)) {
    const segment = `${lineNumber === range.startLine ? "" : "\n"}${line}`;
    const segmentByteLength = Buffer.byteLength(segment, "utf8");

    if (segmentByteLength > MAX_SOURCE_CHUNK_BYTES) {
      if (currentByteLength > 0) {
        if (parts.length === maxParts) return { parts, hasMore: true };
        parts.push({ content: currentParts.join(""), startLine: currentStartLine, endLine: currentEndLine });
        currentParts = [];
        currentByteLength = 0;
        currentStarted = false;
      }
      const fragmentStartLine = currentStarted ? currentStartLine : lineNumber;
      const fragments = splitUtf8(segment, maxParts - parts.length);
      for (const [fragmentOrdinal, content] of fragments.fragments.entries()) {
        parts.push({ content, startLine: fragmentOrdinal === 0 ? fragmentStartLine : lineNumber, endLine: lineNumber });
      }
      if (fragments.hasMore) return { parts, hasMore: true };
      const finalFragment = fragments.fragments.at(-1);
      if (finalFragment !== undefined) {
        parts.length -= 1;
        currentParts = [finalFragment];
        currentByteLength = Buffer.byteLength(finalFragment, "utf8");
        currentStartLine = fragments.fragments.length === 1 ? fragmentStartLine : lineNumber;
        currentEndLine = lineNumber;
        currentStarted = true;
      }
      lineNumber += 1;
      continue;
    }

    if (currentByteLength > 0 && currentByteLength + segmentByteLength > MAX_SOURCE_CHUNK_BYTES) {
      if (parts.length === maxParts) return { parts, hasMore: true };
      parts.push({ content: currentParts.join(""), startLine: currentStartLine, endLine: currentEndLine });
      currentParts = [];
      currentByteLength = 0;
      currentStarted = false;
    }
    if (!currentStarted) {
      currentStartLine = lineNumber;
      currentStarted = true;
    }
    currentParts.push(segment);
    currentByteLength += segmentByteLength;
    currentEndLine = lineNumber;
    lineNumber += 1;
  }

  if (!currentStarted) return { parts, hasMore: false };
  if (parts.length === maxParts) return { parts, hasMore: true };
  parts.push({ content: currentParts.join(""), startLine: currentStartLine, endLine: currentEndLine });
  return { parts, hasMore: false };
}

function sourcePartsForRange(lines: readonly string[], range: SourceRange, maxParts: number): SourceChunkPartition {
  if (maxParts === 0) return { parts: [], hasMore: true };
  const partitionRange =
    range.endLine === lines.length - 1 && lines.at(-1) === ""
      ? { ...range, endLine: range.endLine + 1 }
      : range;
  if (sourceRangeByteLength(lines, partitionRange) > MAX_SOURCE_CHUNK_BYTES) {
    return partitionOversizedRange(lines, partitionRange, maxParts);
  }
  return {
    parts: [{ content: contentForRange(lines, range), startLine: range.startLine, endLine: range.endLine }],
    hasMore: false,
  };
}

export function buildSourceChunksForFile(input: SourceChunkBuildInput): SourceChunkRecord[] {
  const lines = input.content.split(/\r?\n/);
  const chunks: SourceChunkRecord[] = [];
  let omittedNodeCount = 0;

  for (const [nodeIndex, node] of input.nodes.entries()) {
    if (chunks.length === MAX_SOURCE_CHUNKS_PER_FILE) {
      omittedNodeCount = input.nodes.length - nodeIndex;
      break;
    }
    const range = sourceRangeForNode(lines, node);
    if (!hasNonWhitespaceContent(lines, range)) continue;
    const partition = sourcePartsForRange(lines, range, MAX_SOURCE_CHUNKS_PER_FILE - chunks.length);
    for (const [chunkOrdinal, part] of partition.parts.entries()) {
      chunks.push({
        id: chunkId(node, chunkOrdinal),
        nodeId: node.id,
        filePath: input.file.path,
        language: input.file.language,
        symbolKind: node.kind,
        startLine: part.startLine,
        endLine: part.endLine,
        contentHash: sha256Hex(part.content),
        sourceHash: input.file.contentHash,
        chunkOrdinal,
        indexerVersion: SOURCE_CHUNK_INDEXER_VERSION,
        content: part.content,
        codeTokenText: buildSourceChunkCodeTokenText(part.content),
        metadata: {
          producer: "solidkg.source-chunks",
          nodeName: node.name,
          qualifiedName: node.qualifiedName,
        },
        diagnostics: chunkOrdinal === 0 ? range.diagnostics : undefined,
        updatedAt: input.updatedAt,
      });
    }
    if (partition.hasMore) {
      omittedNodeCount = input.nodes.length - nodeIndex;
      break;
    }
  }

  if (omittedNodeCount > 0) {
    const lastChunk = chunks.at(-1);
    if (lastChunk !== undefined) {
      chunks[chunks.length - 1] = {
        ...lastChunk,
        diagnostics: [
          ...(lastChunk.diagnostics ?? []),
          {
            message: "Source chunk output was capped at the per-file chunk limit",
            severity: "warning",
            code: "source_chunk.file_chunk_limit",
            line: lastChunk.endLine,
            metadata: {
              maxChunksPerFile: MAX_SOURCE_CHUNKS_PER_FILE,
              emittedChunkCount: chunks.length,
              omittedNodeCount,
            },
          },
        ],
      };
    }
  }
  return chunks;
}
