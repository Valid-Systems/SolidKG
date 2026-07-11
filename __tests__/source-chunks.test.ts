import { describe, expect, it, vi } from "vitest";
import {
  buildSourceChunksForFile,
  estimateSourceChunkProjectionFileBytes,
  MAX_SOURCE_CHUNK_PROJECTION_BATCH_BYTES,
  shouldFlushSourceChunkProjectionBatch,
} from "../src/source-chunks";
import type { FileRecord, Node } from "../src/types";

const MAX_CHUNK_BYTES = 8_192;
const MAX_CHUNKS_PER_FILE = 1_024;
const FILE_PATH = "src/workflows/invoice.ts";

interface NodeFixture {
  readonly id: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

function createFile(content: string, nodeCount: number): FileRecord {
  return {
    path: FILE_PATH,
    contentHash: "sha256:invoice-source",
    language: "typescript",
    size: Buffer.byteLength(content, "utf8"),
    modifiedAt: 1_000,
    indexedAt: 1_000,
    nodeCount,
  };
}

function createNode(fixture: NodeFixture): Node {
  return {
    id: fixture.id,
    kind: "function",
    name: fixture.name,
    qualifiedName: `${FILE_PATH}::${fixture.name}`,
    filePath: FILE_PATH,
    language: "typescript",
    startLine: fixture.startLine,
    endLine: fixture.endLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1_000,
  };
}

describe("source chunk construction", () => {
  it("splits a file into lines once before projecting its ordinary nodes", () => {
    // Given: three separate extracted nodes from one realistic source file.
    const content = [
      'export function parseInvoice() { return "parse"; }',
      'export function validateInvoice() { return "validate"; }',
      'export function persistInvoice() { return "persist"; }',
    ].join("\n");
    const nodes = [
      createNode({ id: "parse", name: "parseInvoice", startLine: 1, endLine: 1 }),
      createNode({ id: "validate", name: "validateInvoice", startLine: 2, endLine: 2 }),
      createNode({ id: "persist", name: "persistInvoice", startLine: 3, endLine: 3 }),
    ];
    const split = vi.spyOn(String.prototype, "split");

    try {
      // When: source chunks are built for the complete file projection.
      buildSourceChunksForFile({ file: createFile(content, nodes.length), nodes, content, updatedAt: 2_000 });

      // Then: newline indexing is computed once rather than once per node.
      const newlineSplits = split.mock.calls.filter(
        ([separator]) => separator instanceof RegExp && separator.source === "\\r?\\n",
      );
      expect(newlineSplits).toHaveLength(1);
    } finally {
      split.mockRestore();
    }
  });

  it("keeps small node chunks compatible while giving them stable IDs and source order", () => {
    // Given: the normal small functions already persisted as one chunk per node.
    const content = [
      "export function parseInvoice() {",
      '  return "parsed";',
      "}",
      "",
      "export function persistInvoice() {",
      '  return "persisted";',
      "}",
    ].join("\n");
    const nodes = [
      createNode({ id: "parse", name: "parseInvoice", startLine: 1, endLine: 3 }),
      createNode({ id: "persist", name: "persistInvoice", startLine: 5, endLine: 7 }),
    ];
    const input = { file: createFile(content, nodes.length), nodes, content, updatedAt: 2_000 };

    // When: the same projection is constructed twice.
    const first = buildSourceChunksForFile(input);
    const second = buildSourceChunksForFile(input);

    // Then: ordinary chunks retain their one-chunk shape, input order, and deterministic identities.
    expect(second).toEqual(first);
    expect(first).toMatchObject([
      {
        id: expect.stringMatching(/^source-chunk:[a-f0-9]{32}$/),
        nodeId: "parse",
        filePath: FILE_PATH,
        language: "typescript",
        symbolKind: "function",
        chunkOrdinal: 0,
        startLine: 1,
        endLine: 3,
        sourceHash: "sha256:invoice-source",
        indexerVersion: "source-chunk-indexer-v1",
        content: 'export function parseInvoice() {\n  return "parsed";\n}',
        codeTokenText: expect.stringContaining("parseInvoice"),
        metadata: { producer: "solidkg.source-chunks", nodeName: "parseInvoice", qualifiedName: `${FILE_PATH}::parseInvoice` },
        diagnostics: undefined,
      },
      {
        id: expect.stringMatching(/^source-chunk:[a-f0-9]{32}$/),
        nodeId: "persist",
        filePath: FILE_PATH,
        language: "typescript",
        symbolKind: "function",
        chunkOrdinal: 0,
        startLine: 5,
        endLine: 7,
        sourceHash: "sha256:invoice-source",
        indexerVersion: "source-chunk-indexer-v1",
        content: 'export function persistInvoice() {\n  return "persisted";\n}',
        codeTokenText: expect.stringContaining("persistInvoice"),
        metadata: { producer: "solidkg.source-chunks", nodeName: "persistInvoice", qualifiedName: `${FILE_PATH}::persistInvoice` },
        diagnostics: undefined,
      },
    ]);
  });

  it("partitions oversized Unicode source at UTF-8-safe byte boundaries", () => {
    // Given: one extracted symbol whose source is larger than one bounded chunk and contains four-byte glyphs.
    const content = `export const invoiceGlyphs = "${"😀".repeat(3_000)}";\n`;
    const node = createNode({ id: "glyphs", name: "invoiceGlyphs", startLine: 1, endLine: 1 });
    const input = { file: createFile(content, 1), nodes: [node], content, updatedAt: 2_000 };

    // When: source chunks are built twice for the oversized node.
    const first = buildSourceChunksForFile(input);
    const second = buildSourceChunksForFile(input);

    // Then: no chunk exceeds the byte ceiling, split strings are valid UTF-8, and all source survives in ordinal order.
    expect(first).toHaveLength(2);
    expect(first.map((chunk) => chunk.chunkOrdinal)).toEqual([0, 1]);
    expect(first.map((chunk) => chunk.id)).toEqual(second.map((chunk) => chunk.id));
    expect(new Set(first.map((chunk) => chunk.id)).size).toBe(first.length);
    expect(first.map((chunk) => Buffer.byteLength(chunk.content, "utf8")).every((size) => size <= MAX_CHUNK_BYTES)).toBe(true);
    expect(first.map((chunk) => Buffer.from(chunk.content, "utf8").toString("utf8"))).toEqual(first.map((chunk) => chunk.content));
    expect(first.map((chunk) => chunk.content).join("")).toBe(content);
  });

  it("retains all ordinary nodes when a file has more than 64 chunks", () => {
    // Given: an ordinary file with more than the old legacy cap of extracted functions.
    const nodeCount = 72;
    const content = Array.from(
      { length: nodeCount },
      (_, index) => `export function invoiceStep${index + 1}() { return "${index + 1}"; }`,
    ).join("\n");
    const nodes = Array.from({ length: nodeCount }, (_, index) => createNode({
      id: `step-${index + 1}`,
      name: `invoiceStep${index + 1}`,
      startLine: index + 1,
      endLine: index + 1,
    }));

    // When: all ordinary nodes are projected in source order.
    const chunks = buildSourceChunksForFile({
      file: createFile(content, nodes.length),
      nodes,
      content,
      updatedAt: 2_000,
    });

    // Then: every ordinary node remains available to retrieval without truncation diagnostics.
    expect(chunks).toHaveLength(nodeCount);
    expect(chunks.map((chunk) => chunk.nodeId)).toEqual(nodes.map((node) => node.id));
    expect(chunks.flatMap((chunk) => chunk.diagnostics ?? [])).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source_chunk.file_chunk_limit" })]),
    );
  });

  it("flushes a source projection batch for the byte budget without allocating a large fixture", () => {
    // Given: UTF-8 content and code-token text whose estimated storage includes bounded row overhead.
    const estimatedFileBytes = estimateSourceChunkProjectionFileBytes([
      { content: "😀", codeTokenText: "invoiceToken" },
    ]);

    // When: an already-populated batch would cross its byte or file ceiling, including an oversized single file.
    const flushForBytes = shouldFlushSourceChunkProjectionBatch({
      currentFileCount: 1,
      currentByteLength: MAX_SOURCE_CHUNK_PROJECTION_BATCH_BYTES - 1,
      nextFileByteLength: 2,
    });
    const flushForFiles = shouldFlushSourceChunkProjectionBatch({
      currentFileCount: 128,
      currentByteLength: 0,
      nextFileByteLength: estimatedFileBytes,
    });
    const flushOversizedSingleFile = shouldFlushSourceChunkProjectionBatch({
      currentFileCount: 0,
      currentByteLength: 0,
      nextFileByteLength: MAX_SOURCE_CHUNK_PROJECTION_BATCH_BYTES + 1,
    });

    // Then: both persisted text fields are counted as UTF-8, and an oversized file forms its own batch.
    expect(estimatedFileBytes).toBe(Buffer.byteLength("😀", "utf8") + Buffer.byteLength("invoiceToken", "utf8") + 128);
    expect(flushForBytes).toBe(true);
    expect(flushForFiles).toBe(true);
    expect(flushOversizedSingleFile).toBe(false);
  });

  it("caps only files beyond 1024 chunks and reports structured truncation", () => {
    // Given: a generated-style source file with more extracted functions than the per-file retention budget.
    const nodeCount = MAX_CHUNKS_PER_FILE + 8;
    const content = Array.from(
      { length: nodeCount },
      (_, index) => `export function invoiceStep${index + 1}() { return "${"x".repeat(128)}"; }`,
    ).join("\n");
    const nodes = Array.from({ length: nodeCount }, (_, index) => createNode({
      id: `step-${index + 1}`,
      name: `invoiceStep${index + 1}`,
      startLine: index + 1,
      endLine: index + 1,
    }));

    // When: all nodes are projected in source order.
    const chunks = buildSourceChunksForFile({
      file: createFile(content, nodes.length),
      nodes,
      content,
      updatedAt: 2_000,
    });
    const truncationDiagnostics = chunks
      .flatMap((chunk) => chunk.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.code === "source_chunk.file_chunk_limit");

    // Then: retained chunks are bounded and the omitted source is visible through machine-readable diagnostics.
    expect(chunks).toHaveLength(MAX_CHUNKS_PER_FILE);
    expect(chunks.map((chunk) => chunk.nodeId)).toEqual(nodes.slice(0, MAX_CHUNKS_PER_FILE).map((node) => node.id));
    expect(truncationDiagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "source_chunk.file_chunk_limit",
        metadata: expect.objectContaining({
          maxChunksPerFile: MAX_CHUNKS_PER_FILE,
          emittedChunkCount: MAX_CHUNKS_PER_FILE,
          omittedNodeCount: nodeCount - MAX_CHUNKS_PER_FILE,
        }),
      }),
    ]);
  });

  it("counts all remaining overlapping nodes when the chunk cap is reached", () => {
    // Given: more overlapping symbols than the file chunk cap, all covering one source line.
    const nodeCount = MAX_CHUNKS_PER_FILE + 8;
    const content = 'export const sharedSource = "invoice";';
    const nodes = Array.from({ length: nodeCount }, (_, index) => createNode({
      id: `overlap-${index + 1}`,
      name: `overlap${index + 1}`,
      startLine: 1,
      endLine: 1,
    }));

    // When: source chunks reach the per-file cap.
    const chunks = buildSourceChunksForFile({
      file: createFile(content, nodes.length),
      nodes,
      content,
      updatedAt: 2_000,
    });

    // Then: the terminal diagnostic reports every remaining node without timing-based assertions.
    const diagnostics = chunks.at(-1)?.diagnostics ?? [];
    expect(chunks).toHaveLength(MAX_CHUNKS_PER_FILE);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_chunk.file_chunk_limit",
        metadata: expect.objectContaining({
          omittedNodeCount: nodeCount - MAX_CHUNKS_PER_FILE,
        }),
      }),
    ]));
  });
});
