/**
 * SolidKG
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from "path";
import { existsSync, readFileSync } from "fs";
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  SourceChunkDiagnostics,
  SourceChunkRecord,
  SourceChunkSearchOptions,
  SourceChunkSearchResult,
  RetrievalExtensionConfig,
  RetrievalExtensionStatus,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  Hyperedge,
  HyperedgeKind,
  HyperedgeMember,
  HyperedgeRelation,
  ScipDocumentRecord,
  ScipImportStats,
  ScipIndexerConfig,
  ScipMode,
  ScipOccurrenceRecord,
  ScipRelationshipRecord,
  ScipSymbolRecord,
  UnresolvedReference,
} from "./types";
import { DatabaseConnection, getDatabasePath } from "./db";
import { QueryBuilder } from "./db/queries";
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
  ensureOwnershipMarker,
  getSolidKGDir,
  SolidKGDirectoryOptions,
} from "./directory";
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexIssueSink,
  IndexResult,
  SyncResult,
  SourceRootInput,
  ExtractionOrchestratorOptions,
  buildSourceRoots,
  extractFromSource,
} from "./extraction";
import { ReferenceResolver, ResolutionResult } from "./resolution";
import { GraphTraverser, GraphQueryManager } from "./graph";
import type { GraphTraversalResult } from "./graph";
import type { RelatedNodeTraversalResult } from "./graph/traversal-results";
import { ContextBuilder, createContextBuilder } from "./context";
import {
  buildOverviewTree,
  formatOverviewTree,
  type OverviewTree,
  type OverviewTreeOptions,
} from "./overview";
import { Mutex, FileLock } from "./utils";
import { FileWatcher, WatchOptions, PendingFile } from "./sync";
import {
  generateScipIndexes,
  importScipIndexes as importScipIndexesIntoDb,
  linkScipSymbolsToNodes,
} from "./scip";
import {
  createIndexProfile,
  elapsedMs,
  nowMs,
  recordResourceStats,
  type MutableIndexProfile,
} from "./profiling";
import type {
  CapabilityAnalysisRun,
  CapabilityAssertion,
} from "./capabilities";
import {
  buildSourceChunksForFile,
  estimateSourceChunkProjectionFileBytes,
  shouldFlushSourceChunkProjectionBatch,
} from "./source-chunks";
import {
  buildArchitectureReport,
  type ArchitectureManifestPackage,
} from "./analysis/architecture-report";
import {
  canonicalJson,
  compareSnapshotHealthDrift,
  deriveArchitectureHealth,
  normalizeArchitectureHealthOptions,
  type ArchitectureHealthReport,
  type NormalizedArchitectureHealthOptions,
  type SnapshotArchitectureHealthBundle,
  type SnapshotDiffCounts,
  type SnapshotHealthDrift,
  type StoredSnapshotAnalysisRow,
} from "./analysis";
import { SOLIDKG_VERSION } from "./version";

// Re-export types for consumers
export * from "./types";
export { getDatabasePath } from "./db";
export {
  getSolidKGDir,
  isInitialized,
  findNearestSolidKGRoot,
  SOLIDKG_DIR,
} from "./directory";
export {
  IndexProgress,
  IndexIssue,
  IndexIssueSink,
  IndexResult,
  IndexSkippedFile,
  IndexSkipReason,
  SyncResult,
} from "./extraction";
export {
  detectLanguage,
  isLanguageSupported,
  isGrammarLoaded,
  getSupportedLanguages,
  initGrammars,
  loadGrammarsForLanguages,
  loadAllGrammars,
} from "./extraction";
export { ResolutionResult } from "./resolution";
export {
  SolidKGError,
  FileError,
  ParseError,
  DatabaseError,
  SchemaUpgradeRequiredError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from "./errors";
export {
  Mutex,
  FileLock,
  processInBatches,
  debounce,
  throttle,
  MemoryMonitor,
} from "./utils";
export { FileWatcher, WatchOptions, PendingFile } from "./sync";
export { MCPServer } from "./mcp";
export * from "./scip";
export * from "./profiling";
export * from "./capabilities";
export * from "./overview";
export {
  ARCHITECTURE_HEALTH_ANALYSIS_KIND,
  ARCHITECTURE_HEALTH_ANALYSIS_VERSION,
} from "./analysis";
export type {
  ArchitectureHealthCoverage,
  ArchitectureHealthCoverageStatus,
  ArchitectureHealthEvidenceAnchor,
  ArchitectureHealthFinding,
  ArchitectureHealthFindingFactKey,
  ArchitectureHealthMetric,
  ArchitectureHealthMetricDelta,
  ArchitectureHealthObservedGraphFacts,
  ArchitectureHealthProducerIdentity,
  ArchitectureHealthReport,
  ArchitectureHealthScalarMetricKey,
  ArchitectureHealthSignal,
  ArchitectureHealthSignalCoverageRecord,
  ArchitectureHealthSignalReasonCode,
  ArchitectureHealthSignalKind,
  NormalizedArchitectureHealthOptions,
  SnapshotArchitectureHealthBundle,
  SnapshotDiffCounts,
  SnapshotHealthComparisonStatus,
  SnapshotHealthDriftReasonCode,
  SnapshotHealthDrift,
} from "./analysis";

/**
 * Options for initializing a new SolidKG project
 */
export interface InitOptions {
  dataDir?: string;

  /** Additional source roots to index alongside the project root */
  extraRoots?: Array<string | SourceRootInput>;

  /** Index nested Git repositories/submodules. Defaults to false. */
  includeSubmodules?: boolean;

  includePatterns?: string[];

  excludePatterns?: string[];

  includeVendored?: boolean;

  maxFileSizeBytes?: number;

  /** Whether to run initial indexing after init */
  index?: boolean;

  /** SCIP generation mode for initial indexing. Defaults to off. */
  scip?: ScipMode;

  /** Test/config injection for SCIP indexers during initial indexing */
  scipIndexers?: Record<string, ScipIndexerConfig>;

  /** Directory for generated SCIP files during initial indexing */
  scipOutputDir?: string;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;

  onIssue?: IndexIssueSink;

  retrieval?: RetrievalExtensionConfig;
}

/**
 * Options for opening an existing SolidKG project
 */
export interface OpenOptions {
  dataDir?: string;

  /** Additional source roots to index alongside the project root */
  extraRoots?: Array<string | SourceRootInput>;

  /** Index nested Git repositories/submodules. Defaults to false. */
  includeSubmodules?: boolean;

  includePatterns?: string[];

  excludePatterns?: string[];

  includeVendored?: boolean;

  maxFileSizeBytes?: number;

  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;

  retrieval?: RetrievalExtensionConfig;
}

export interface SnapshotMetadataInput {
  description?: string;
  metadata?: Record<string, unknown>;
  architecture?: AnalyzeArchitectureOptions;
}

export interface SnapshotMetadata {
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  hyperedgeMemberCount: number;
}

export type SnapshotNodeRecord = Omit<Node, "updatedAt">;
export type SnapshotEdgeRecord = Pick<
  Edge,
  "source" | "target" | "kind" | "metadata" | "line" | "column" | "provenance"
>;
export type SnapshotHyperedgeRecord = Pick<
  Hyperedge,
  | "id"
  | "kind"
  | "sourceFile"
  | "line"
  | "column"
  | "provenance"
  | "confidence"
  | "metadata"
>;
export type SnapshotHyperedgeMemberRecord = Pick<
  HyperedgeMember,
  "hyperedgeId" | "nodeId" | "role" | "ordinal" | "metadata"
>;

export interface SnapshotDiff {
  addedNodes: SnapshotNodeRecord[];
  removedNodes: SnapshotNodeRecord[];
  changedNodes: SnapshotNodeRecord[];
  addedEdges: SnapshotEdgeRecord[];
  removedEdges: SnapshotEdgeRecord[];
  changedEdges: SnapshotEdgeRecord[];
  addedHyperedges: SnapshotHyperedgeRecord[];
  removedHyperedges: SnapshotHyperedgeRecord[];
  changedHyperedges: SnapshotHyperedgeRecord[];
  addedHyperedgeMembers: SnapshotHyperedgeMemberRecord[];
  removedHyperedgeMembers: SnapshotHyperedgeMemberRecord[];
  changedHyperedgeMembers: SnapshotHyperedgeMemberRecord[];
}

export interface ArchitectureLayerRule {
  name: string;
  paths: string[];
}

export interface AnalyzeArchitectureOptions {
  layers?: ArchitectureLayerRule[];
}

export interface ArchitecturePackage {
  name: string;
  root: string;
  provenance: "manifest" | "root";
  fileCount: number;
}

export interface ArchitecturePackageLookup {
  query: string;
  kind: "package" | "path";
  resolvedBy: "name" | "root" | "owning_package" | "not_found";
  package: ArchitecturePackage | null;
  matchedPath?: string;
  matchedFileCount?: number;
}

export interface ArchitectureLayer {
  name: string;
  provenance: "config_layer" | "unassigned";
  fileCount: number;
}

export interface ArchitectureFileAssignment {
  filePath: string;
  packageName: string;
  packageRoot: string;
  packageProvenance: "manifest" | "root" | "unassigned";
  layerName: string;
  layerProvenance: "config_layer" | "unassigned";
}

export interface ArchitectureDependency {
  source: string;
  target: string;
  edgeKinds: string[];
}

export interface CouplingMetric {
  name: string;
  Ca: number;
  Ce: number;
  instability: number;
}

export interface ArchitectureReport {
  packages: ArchitecturePackage[];
  layers: ArchitectureLayer[];
  fileAssignments: ArchitectureFileAssignment[];
  packageDependencies: ArchitectureDependency[];
  layerDependencies: ArchitectureDependency[];
  coupling: {
    packages: CouplingMetric[];
    layers: CouplingMetric[];
  };
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  onIssue?: IndexIssueSink;

  /** Additional source roots to index alongside the project root */
  extraRoots?: Array<string | SourceRootInput>;

  /** Index nested Git repositories/submodules. Defaults to false. */
  includeSubmodules?: boolean;

  includePatterns?: string[];

  excludePatterns?: string[];

  includeVendored?: boolean;

  maxFileSizeBytes?: number;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;

  /** SCIP generation mode for full indexing */
  scip?: ScipMode;

  /** Test/config injection for SCIP indexers */
  scipIndexers?: Record<string, ScipIndexerConfig>;

  /** Directory for generated SCIP files */
  scipOutputDir?: string;

  profile?: boolean;
}

interface SnapshotGraph {
  nodes: SnapshotNodeRecord[];
  edges: SnapshotEdgeRecord[];
  hyperedges: SnapshotHyperedgeRecord[];
  hyperedgeMembers: SnapshotHyperedgeMemberRecord[];
}

function snapshotNode(node: Node): SnapshotNodeRecord {
  const { updatedAt: _updatedAt, ...record } = node;
  return record;
}

function snapshotEdge(edge: Edge): SnapshotEdgeRecord {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    metadata: edge.metadata,
    line: edge.line,
    column: edge.column,
    provenance: edge.provenance,
  };
}

function snapshotHyperedge(hyperedge: Hyperedge): SnapshotHyperedgeRecord {
  return {
    id: hyperedge.id,
    kind: hyperedge.kind,
    sourceFile: hyperedge.sourceFile,
    line: hyperedge.line,
    column: hyperedge.column,
    provenance: hyperedge.provenance,
    confidence: hyperedge.confidence,
    metadata: hyperedge.metadata,
  };
}

function snapshotHyperedgeMember(
  member: HyperedgeMember,
): SnapshotHyperedgeMemberRecord {
  return {
    hyperedgeId: member.hyperedgeId,
    nodeId: member.nodeId,
    role: member.role,
    ordinal: member.ordinal,
    metadata: member.metadata,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = stableValue(entry);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sourceOptionsFrom(
  options: Pick<
    InitOptions | OpenOptions | IndexOptions,
    | "extraRoots"
    | "includeSubmodules"
    | "includePatterns"
    | "excludePatterns"
    | "includeVendored"
    | "maxFileSizeBytes"
  >,
): ExtractionOrchestratorOptions {
  return {
    extraRoots: options.extraRoots,
    includeSubmodules: options.includeSubmodules,
    includePatterns: options.includePatterns,
    excludePatterns: options.excludePatterns,
    includeVendored: options.includeVendored,
    maxFileSizeBytes: options.maxFileSizeBytes,
  };
}

const SOURCE_OPTIONS_METADATA_KEY = "source_options";

function readSourceOptionsMetadata(
  queries: QueryBuilder,
): ExtractionOrchestratorOptions {
  const raw = queries.getMetadata(SOURCE_OPTIONS_METADATA_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ExtractionOrchestratorOptions;
    return {
      extraRoots: parsed.extraRoots,
      includeSubmodules: parsed.includeSubmodules,
      includePatterns: parsed.includePatterns,
      excludePatterns: parsed.excludePatterns,
      includeVendored: parsed.includeVendored,
      maxFileSizeBytes: parsed.maxFileSizeBytes,
    };
  } catch {
    return {};
  }
}

function mergeSourceOptions(
  current: ExtractionOrchestratorOptions,
  overrides: ExtractionOrchestratorOptions,
): ExtractionOrchestratorOptions {
  return {
    extraRoots: overrides.extraRoots ?? current.extraRoots,
    includeSubmodules: overrides.includeSubmodules ?? current.includeSubmodules,
    includePatterns: overrides.includePatterns ?? current.includePatterns,
    excludePatterns: overrides.excludePatterns ?? current.excludePatterns,
    includeVendored: overrides.includeVendored ?? current.includeVendored,
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? current.maxFileSizeBytes,
  };
}

function hasSourceOptionOverride(
  options: ExtractionOrchestratorOptions,
): boolean {
  return (
    options.extraRoots !== undefined ||
    options.includeSubmodules !== undefined ||
    options.includePatterns !== undefined ||
    options.excludePatterns !== undefined ||
    options.includeVendored !== undefined ||
    options.maxFileSizeBytes !== undefined
  );
}

function edgeKey(edge: SnapshotEdgeRecord): string {
  return [
    edge.source,
    edge.target,
    edge.kind,
    edge.line ?? "",
    edge.column ?? "",
    edge.provenance ?? "",
  ].join("\0");
}

function memberKey(member: SnapshotHyperedgeMemberRecord): string {
  return [member.hyperedgeId, member.nodeId, member.role, member.ordinal].join(
    "\0",
  );
}

function diffRecords<T>(
  snapshot: T[],
  current: T[],
  keyOf: (record: T) => string,
): { added: T[]; removed: T[]; changed: T[] } {
  const before = new Map(
    snapshot.map((record) => [
      keyOf(record),
      { record, serialized: stableStringify(record) },
    ]),
  );
  const after = new Map(
    current.map((record) => [
      keyOf(record),
      { record, serialized: stableStringify(record) },
    ]),
  );
  const added: T[] = [];
  const removed: T[] = [];
  const changed: T[] = [];

  for (const [key, value] of after) {
    const old = before.get(key);
    if (!old) added.push(value.record);
    else if (old.serialized !== value.serialized) changed.push(value.record);
  }
  for (const [key, value] of before) {
    if (!after.has(key)) removed.push(value.record);
  }

  return { added, removed, changed };
}

function snapshotDiffCounts(diff: SnapshotDiff): SnapshotDiffCounts {
  return {
    addedNodes: diff.addedNodes.length,
    removedNodes: diff.removedNodes.length,
    changedNodes: diff.changedNodes.length,
    addedEdges: diff.addedEdges.length,
    removedEdges: diff.removedEdges.length,
    changedEdges: diff.changedEdges.length,
    addedHyperedges: diff.addedHyperedges.length,
    removedHyperedges: diff.removedHyperedges.length,
    changedHyperedges: diff.changedHyperedges.length,
    addedHyperedgeMembers: diff.addedHyperedgeMembers.length,
    removedHyperedgeMembers: diff.removedHyperedgeMembers.length,
    changedHyperedgeMembers: diff.changedHyperedgeMembers.length,
  };
}

function normalizePath(value: string): string {
  return (
    value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || "."
  );
}

function pathMatchesPrefix(filePath: string, prefix: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedPrefix = normalizePath(prefix);
  if (normalizedPrefix === ".") return true;
  if (
    normalizedFile === normalizedPrefix ||
    normalizedFile.startsWith(`${normalizedPrefix}/`)
  )
    return true;
  if (normalizedPrefix.startsWith("@")) return false;
  const rootlessFile = normalizedFile.replace(/^@[^/]+\//, "");
  return (
    rootlessFile === normalizedPrefix ||
    rootlessFile.startsWith(`${normalizedPrefix}/`)
  );
}

function directoryOf(filePath: string): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index) || ".";
}

function parentDir(dir: string): string | null {
  if (dir === ".") return null;
  const index = dir.lastIndexOf("/");
  return index === -1 ? "." : dir.slice(0, index) || ".";
}

/**
 * Main SolidKG class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class SolidKG {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private resolverInitialized = false;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string,
    private dataDir: string,
    private explicitDataDir: boolean,
    private sourceOptions: ExtractionOrchestratorOptions = {},
    private readOnly = false,
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(path.join(dataDir, "solidkg.lock"));
    this.orchestrator = new ExtractionOrchestrator(
      projectRoot,
      queries,
      sourceOptions,
    );
    this.resolver = new ReferenceResolver(projectRoot, queries, sourceOptions);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser,
      sourceOptions,
    );
    if (!this.readOnly) this.persistSourceOptions();
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new Error(
        `Cannot ${operation}: SolidKG was opened in read-only mode`,
      );
    }
  }

  private persistSourceOptions(): void {
    this.queries.setMetadata(
      SOURCE_OPTIONS_METADATA_KEY,
      JSON.stringify(this.sourceOptions),
    );
  }

  private initializeResolver(): void {
    if (this.resolverInitialized) return;
    this.resolver.initialize();
    this.resolverInitialized = true;
  }

  private rebuildResolver(): void {
    this.resolver = new ReferenceResolver(
      this.projectRoot,
      this.queries,
      this.sourceOptions,
    );
    this.resolverInitialized = false;
  }

  private resolveIndexedFilePath(filePath: string): string | null {
    for (const root of this.getSourceRoots()) {
      if (!filePath.startsWith(root.prefix)) continue;
      const relativePath = filePath.slice(root.prefix.length);
      const fullPath = path.resolve(root.rootDir, relativePath);
      if (
        fullPath === root.rootDir ||
        fullPath.startsWith(`${root.rootDir}${path.sep}`)
      )
        return fullPath;
    }
    return null;
  }

  private buildSourceChunksForFile(
    file: FileRecord,
    updatedAt: number,
  ): SourceChunkRecord[] {
    const fullPath = this.resolveIndexedFilePath(file.path);
    if (!fullPath || !existsSync(fullPath)) return [];
    const content = readFileSync(fullPath, "utf-8");
    const nodes = this.queries.getNodesByFile(file.path);
    return buildSourceChunksForFile({
      file,
      nodes,
      content,
      updatedAt,
    });
  }

  private refreshSourceChunksForFiles(
    filePaths: readonly string[] | undefined,
    onProgress?: (progress: IndexProgress) => void,
  ): void {
    const updatedAt = Date.now();
    const files = filePaths
      ? filePaths.flatMap((filePath) => {
          const file = this.queries.getFileByPath(filePath);
          return file ? [file] : [];
        })
      : this.queries.getAllFiles();

    onProgress?.({
      phase: "storing",
      detail: "source_chunks",
      current: 0,
      total: files.length,
    });

    let batch: FileRecord[] = [];
    let chunks: SourceChunkRecord[] = [];
    let batchByteLength = 0;
    let completedFileCount = 0;
    const flushBatch = (): void => {
      if (batch.length === 0) return;
      this.queries.transaction(() => {
        for (const file of batch) {
          this.queries.deleteSourceChunksByFile(file.path);
        }
        this.queries.upsertSourceChunks(chunks);
      });

      completedFileCount += batch.length;
      onProgress?.({
        phase: "storing",
        detail: "source_chunks",
        current: completedFileCount,
        total: files.length,
      });
      batch = [];
      chunks = [];
      batchByteLength = 0;
    };

    for (const file of files) {
      const fileChunks = this.buildSourceChunksForFile(file, updatedAt);
      const fileByteLength = estimateSourceChunkProjectionFileBytes(fileChunks);
      if (shouldFlushSourceChunkProjectionBatch({
        currentFileCount: batch.length,
        currentByteLength: batchByteLength,
        nextFileByteLength: fileByteLength,
      })) {
        flushBatch();
      }
      batch.push(file);
      chunks.push(...fileChunks);
      batchByteLength += fileByteLength;
    }
    flushBatch();
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new SolidKG project
   *
   * Creates the project-local index directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new SolidKG instance
   */
  static async init(
    projectRoot: string,
    options: InitOptions = {},
  ): Promise<SolidKG> {
    const resolvedRoot = path.resolve(projectRoot);
    const directoryOptions: SolidKGDirectoryOptions = {
      dataDir: options.dataDir,
    };
    const dataDir = getSolidKGDir(resolvedRoot, directoryOptions);

    // Check if already initialized
    if (isInitialized(resolvedRoot, directoryOptions)) {
      throw new Error(
        `SolidKG already initialized in ${resolvedRoot} using data directory ${dataDir}`,
      );
    }

    // Create directory structure
    createDirectory(resolvedRoot, directoryOptions);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot, directoryOptions);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb(), {
      retrieval: options.retrieval,
    });
    const sourceOptions = mergeSourceOptions(
      readSourceOptionsMetadata(queries),
      sourceOptionsFrom(options),
    );
    const instance = new SolidKG(
      db,
      queries,
      resolvedRoot,
      dataDir,
      options.dataDir !== undefined,
      sourceOptions,
    );

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({
        onProgress: options.onProgress,
        onIssue: options.onIssue,
        scip: options.scip,
        scipIndexers: options.scipIndexers,
        scipOutputDir: options.scipOutputDir,
      });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string, options: InitOptions = {}): SolidKG {
    const resolvedRoot = path.resolve(projectRoot);
    const directoryOptions: SolidKGDirectoryOptions = {
      dataDir: options.dataDir,
    };
    const dataDir = getSolidKGDir(resolvedRoot, directoryOptions);

    // Check if already initialized
    if (isInitialized(resolvedRoot, directoryOptions)) {
      throw new Error(
        `SolidKG already initialized in ${resolvedRoot} using data directory ${dataDir}`,
      );
    }

    // Create directory structure
    createDirectory(resolvedRoot, directoryOptions);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot, directoryOptions);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb(), {
      retrieval: options.retrieval,
    });
    return new SolidKG(
      db,
      queries,
      resolvedRoot,
      dataDir,
      options.dataDir !== undefined,
      mergeSourceOptions(
        readSourceOptionsMetadata(queries),
        sourceOptionsFrom(options),
      ),
    );
  }

  /**
   * Open an existing SolidKG project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A SolidKG instance
   */
  static async open(
    projectRoot: string,
    options: OpenOptions = {},
  ): Promise<SolidKG> {
    const resolvedRoot = path.resolve(projectRoot);
    const directoryOptions: SolidKGDirectoryOptions = {
      dataDir: options.dataDir,
    };
    const dataDir = getSolidKGDir(resolvedRoot, directoryOptions);

    // Check if initialized
    if (!isInitialized(resolvedRoot, directoryOptions)) {
      throw new Error(
        `SolidKG not initialized in ${resolvedRoot} using data directory ${dataDir}. Run init() first or pass the correct dataDir.`,
      );
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot, directoryOptions, {
      repair: options.readOnly !== true,
    });
    if (!validation.valid) {
      throw new Error(
        `Invalid SolidKG directory: ${validation.errors.join(", ")}`,
      );
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot, directoryOptions);
    const db = DatabaseConnection.open(dbPath, { readOnly: options.readOnly });
    const queries = new QueryBuilder(db.getDb(), {
      retrieval: options.retrieval,
    });
    if (options.dataDir !== undefined && options.readOnly !== true)
      ensureOwnershipMarker(resolvedRoot, directoryOptions);
    const sourceOptions = mergeSourceOptions(
      readSourceOptionsMetadata(queries),
      sourceOptionsFrom(options),
    );
    const instance = new SolidKG(
      db,
      queries,
      resolvedRoot,
      dataDir,
      options.dataDir !== undefined,
      sourceOptions,
      options.readOnly === true,
    );

    // Sync if requested
    if (options.sync) {
      instance.assertWritable("sync");
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string, options: OpenOptions = {}): SolidKG {
    const resolvedRoot = path.resolve(projectRoot);
    const directoryOptions: SolidKGDirectoryOptions = {
      dataDir: options.dataDir,
    };
    const dataDir = getSolidKGDir(resolvedRoot, directoryOptions);

    // Check if initialized
    if (!isInitialized(resolvedRoot, directoryOptions)) {
      throw new Error(
        `SolidKG not initialized in ${resolvedRoot} using data directory ${dataDir}. Run init() first or pass the correct dataDir.`,
      );
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot, directoryOptions, {
      repair: options.readOnly !== true,
    });
    if (!validation.valid) {
      throw new Error(
        `Invalid SolidKG directory: ${validation.errors.join(", ")}`,
      );
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot, directoryOptions);
    const db = DatabaseConnection.open(dbPath, { readOnly: options.readOnly });
    const queries = new QueryBuilder(db.getDb(), {
      retrieval: options.retrieval,
    });
    if (options.dataDir !== undefined && options.readOnly !== true)
      ensureOwnershipMarker(resolvedRoot, directoryOptions);

    return new SolidKG(
      db,
      queries,
      resolvedRoot,
      dataDir,
      options.dataDir !== undefined,
      mergeSourceOptions(
        readSourceOptionsMetadata(queries),
        sourceOptionsFrom(options),
      ),
      options.readOnly === true,
    );
  }

  /**
   * Check if a directory has been initialized as a SolidKG project
   */
  static isInitialized(
    projectRoot: string,
    options: SolidKGDirectoryOptions = {},
  ): boolean {
    return isInitialized(path.resolve(projectRoot), options);
  }

  /**
   * Close the SolidKG instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  async closeAsync(): Promise<void> {
    await this.unwatchAsync();
    this.fileLock.release();
    this.db.close();
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getSourceRoots(): ReturnType<typeof buildSourceRoots> {
    return buildSourceRoots(
      this.projectRoot,
      this.sourceOptions.extraRoots ?? [],
    );
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    this.assertWritable("indexAll");
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return {
          success: false,
          filesIndexed: 0,
          filesSkipped: 0,
          filesErrored: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          errors: [
            {
              message:
                "Could not acquire file lock - another process may be indexing",
              severity: "error" as const,
            },
          ],
          durationMs: 0,
        };
      }
      try {
        const profile = options.profile ? createIndexProfile() : undefined;
        if (profile) this.queries.enableStatementCounting();
        const requestedSourceOptions = sourceOptionsFrom(options);
        if (hasSourceOptionOverride(requestedSourceOptions)) {
          this.sourceOptions = mergeSourceOptions(
            this.sourceOptions,
            requestedSourceOptions,
          );
          this.orchestrator = new ExtractionOrchestrator(
            this.projectRoot,
            this.queries,
            this.sourceOptions,
          );
          this.rebuildResolver();
          this.contextBuilder = createContextBuilder(
            this.projectRoot,
            this.queries,
            this.traverser,
            this.sourceOptions,
          );
          this.persistSourceOptions();
        }
        const extractionStart = profile ? nowMs() : 0;
        const result = await this.orchestrator.indexAll(
          options.onProgress,
          options.signal,
          options.verbose,
          options.onIssue,
        );
        if (profile) profile.timingsMs.extraction = elapsedMs(extractionStart);
        const astSucceeded = result.success;
        const scipMode = options.scip ?? "off";
        const scipErrors: Array<{ message: string; severity: "error" }> = [];

        // Re-detect frameworks now that the index is populated. Framework
        // resolvers whose detect() consults indexed files need the populated
        // project before resolution runs.
        if (astSucceeded && result.filesIndexed > 0) {
          this.refreshSourceChunksForFiles(undefined, options.onProgress);

          this.rebuildResolver();
          this.initializeResolver();
        }

        if (astSucceeded) {
          options.onProgress?.({
            phase: "scip",
            current: 0,
            total: 0,
          });
          const scipStart = profile ? nowMs() : 0;
          const scip = await generateScipIndexes(this.queries, {
            projectRoot: this.projectRoot,
            mode: scipMode,
            indexers: options.scipIndexers,
            outputDir: options.scipOutputDir ?? path.join(this.dataDir, "scip"),
            storageRoot: this.dataDir,
          });
          if (profile) profile.timingsMs.scip += elapsedMs(scipStart);
          if (scip.generatedFiles.length > 0) {
            try {
              const scipImportStart = profile ? nowMs() : 0;
              await importScipIndexesIntoDb(this.queries, {
                projectRoot: this.projectRoot,
                indexFiles: scip.generatedFiles,
              });
              linkScipSymbolsToNodes(this.queries);
              if (profile) profile.timingsMs.scip += elapsedMs(scipImportStart);
            } catch (err) {
              const message = `SCIP import failed: ${err instanceof Error ? err.message : String(err)}`;
              if (scipMode === "required")
                scipErrors.push({ message, severity: "error" });
            }
          }
          if (scipMode === "required" && !scip.success) {
            for (const error of scip.errors) {
              scipErrors.push({
                message: `SCIP ${error.language}: ${error.message}`,
                severity: "error",
              });
            }
          }
        }

        // Resolve references to create call/import/extends edges
        if (astSucceeded && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: "resolving",
            current: 0,
            total: unresolvedCount,
          });

          const resolutionStart = profile ? nowMs() : 0;
          await this.resolveReferencesBatched(
            (current, total) => {
              options.onProgress?.({
                phase: "resolving",
                current,
                total,
              });
            },
            (current, total) => {
              options.onProgress?.({
                phase: "synthesis",
                current,
                total,
              });
            },
          );
          if (profile)
            profile.timingsMs.resolution += elapsedMs(resolutionStart);
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        // Cheap and non-blocking; never load-bearing for correctness.
        if (astSucceeded && result.filesIndexed > 0) {
          const maintenanceStart = profile ? nowMs() : 0;
          this.db.runMaintenance();
          if (profile)
            profile.timingsMs.maintenance += elapsedMs(maintenanceStart);
        }

        if (scipErrors.length > 0) {
          return this.attachIndexProfile(
            {
              ...result,
              success: false,
              errors: [...result.errors, ...scipErrors],
            },
            profile,
          );
        }

        return this.attachIndexProfile(result, profile);
      } finally {
        this.queries.disableStatementCounting();
        this.fileLock.release();
      }
    });
  }

  private attachIndexProfile(
    result: IndexResult,
    profile: MutableIndexProfile | undefined,
  ): IndexResult {
    if (!profile) return result;
    const stats = this.getStats();
    const finishedAtMs = Date.now();
    profile.finishedAtMs = finishedAtMs;
    profile.durationMs = Math.max(0, finishedAtMs - profile.startedAtMs);
    profile.timingsMs.total = elapsedMs(profile.markStartedAt);
    profile.counts = {
      filesScanned:
        result.filesIndexed + result.filesSkipped + result.filesErrored,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      unresolvedReferencesRemaining:
        this.queries.getUnresolvedReferencesCount(),
      semanticRelations: stats.hyperedgeCount ?? 0,
    };
    profile.dbStatements.byGroup = this.queries.getStatementCounts();
    recordResourceStats(profile, this.dataDir);
    return { ...result, profile };
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    this.assertWritable("indexFiles");
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return {
          success: false,
          filesIndexed: 0,
          filesSkipped: 0,
          filesErrored: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          errors: [
            {
              message:
                "Could not acquire file lock - another process may be indexing",
              severity: "error" as const,
            },
          ],
          durationMs: 0,
        };
      }
      try {
        const result = await this.orchestrator.indexFiles(filePaths);
        if (result.filesIndexed > 0) {
          this.refreshSourceChunksForFiles(filePaths);
          this.rebuildResolver();
          this.initializeResolver();
          const unresolvedRefsByKey = new Map<string, UnresolvedReference>();
          for (const ref of this.queries.getUnresolvedReferencesByFiles(
            filePaths,
          )) {
            unresolvedRefsByKey.set(
              `${ref.id ?? ""}:${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}:${ref.column}`,
              ref,
            );
          }
          const indexedNames = new Set<string>();
          for (const filePath of filePaths) {
            for (const node of this.queries.getNodesByFile(filePath)) {
              indexedNames.add(node.name);
            }
          }
          for (const name of indexedNames) {
            for (const ref of this.queries.getUnresolvedByName(name)) {
              unresolvedRefsByKey.set(
                `${ref.id ?? ""}:${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}:${ref.column}`,
                ref,
              );
            }
          }
          const unresolvedRefs = Array.from(unresolvedRefsByKey.values());
          if (unresolvedRefs.length > 0) {
            this.resolver.resolveAndPersist(
              unresolvedRefs,
              undefined,
              filePaths,
            );
          }
          this.db.runMaintenance();
        }
        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    this.assertWritable("sync");
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(
          `Could not acquire file lock - another process may be indexing${detail}`,
        );
      }
      try {
        const requestedSourceOptions = sourceOptionsFrom(options);
        if (hasSourceOptionOverride(requestedSourceOptions)) {
          this.sourceOptions = mergeSourceOptions(
            this.sourceOptions,
            requestedSourceOptions,
          );
          this.orchestrator = new ExtractionOrchestrator(
            this.projectRoot,
            this.queries,
            this.sourceOptions,
          );
          this.rebuildResolver();
          this.contextBuilder = createContextBuilder(
            this.projectRoot,
            this.queries,
            this.traverser,
            this.sourceOptions,
          );
          this.persistSourceOptions();
        }
        const result = await this.orchestrator.sync(options.onProgress);

        if (
          (result.filesAdded > 0 || result.filesModified > 0) &&
          result.changedFilePaths
        ) {
          this.refreshSourceChunksForFiles(result.changedFilePaths);
        }

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.rebuildResolver();
          this.initializeResolver();
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefsByKey = new Map<string, UnresolvedReference>();
            for (const ref of this.queries.getUnresolvedReferencesByFiles(
              result.changedFilePaths,
            )) {
              unresolvedRefsByKey.set(
                `${ref.id ?? ""}:${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}:${ref.column}`,
                ref,
              );
            }
            const changedNames = new Set<string>();
            for (const filePath of result.changedFilePaths) {
              for (const node of this.queries.getNodesByFile(filePath)) {
                changedNames.add(node.name);
              }
            }
            for (const name of changedNames) {
              for (const ref of this.queries.getUnresolvedByName(name)) {
                unresolvedRefsByKey.set(
                  `${ref.id ?? ""}:${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}:${ref.line}:${ref.column}`,
                  ref,
                );
              }
            }
            const unresolvedRefs = Array.from(unresolvedRefsByKey.values());

            options.onProgress?.({
              phase: "resolving",
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(
              unresolvedRefs,
              (current, total) => {
                options.onProgress?.({
                  phase: "resolving",
                  current,
                  total,
                });
              },
              result.changedFilePaths,
              (current, total) => {
                options.onProgress?.({
                  phase: "synthesis",
                  current,
                  total,
                });
              },
            );
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: "resolving",
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched(
              (current, total) => {
                options.onProgress?.({
                  phase: "resolving",
                  current,
                  total,
                });
              },
              (current, total) => {
                options.onProgress?.({
                  phase: "synthesis",
                  current,
                  total,
                });
              },
            );
          }
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        if (
          result.filesAdded > 0 ||
          result.filesModified > 0 ||
          result.filesRemoved > 0
        ) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    this.assertWritable("watch");
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async () => {
        const result = await this.sync();
        const filesChanged =
          result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options,
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  async unwatchAsync(): Promise<void> {
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.stopAsync();
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Files seen by the file watcher since the last successful sync —
   * the per-file "stale" signal MCP tools attach to responses so an agent
   * can fall back to {@link Read} for just the affected file without
   * waiting for a debounced sync to complete (issue #403).
   *
   * Returns an empty list when the watcher isn't active, or no events have
   * arrived. Each entry includes `firstSeenMs` and `lastSeenMs` (wall-clock
   * `Date.now()` values) so callers can render "edited Nms ago", plus an
   * `indexing` flag indicating whether the in-flight sync (if any) will
   * absorb that file.
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * Resolves once the file watcher has finished its initial chokidar scan.
   * Useful for tests that need a deterministic boundary before asserting on
   * `getPendingFiles()`. Resolves immediately when no watcher is active.
   */
  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher
      ? this.watcher.waitUntilReady(timeoutMs)
      : Promise.resolve();
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): {
    added: string[];
    modified: string[];
    removed: string[];
  } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(
    onProgress?: (current: number, total: number) => void,
  ): ResolutionResult {
    this.assertWritable("resolveReferences");
    this.initializeResolver();
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(
    onProgress?: (current: number, total: number) => void,
    onSynthesisProgress?: (current: number, total: number) => void,
  ): Promise<ResolutionResult> {
    this.assertWritable("resolveReferencesBatched");
    this.initializeResolver();
    return this.resolver.resolveAndPersistBatched(
      onProgress,
      undefined,
      onSynthesisProgress,
    );
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    this.initializeResolver();
    return this.resolver.getDetectedFrameworks();
  }

  async importScipIndexes(indexFiles: string[]): Promise<ScipImportStats> {
    this.assertWritable("importScipIndexes");
    await importScipIndexesIntoDb(this.queries, {
      projectRoot: this.projectRoot,
      indexFiles,
    });
    linkScipSymbolsToNodes(this.queries);
    return this.queries.getScipStats();
  }

  async generateScipIndexes(
    options: {
      mode?: ScipMode;
      indexers?: Record<string, ScipIndexerConfig>;
      languages?: string[];
      outputDir?: string;
    } = {},
  ) {
    this.assertWritable("generateScipIndexes");
    return generateScipIndexes(this.queries, {
      projectRoot: this.projectRoot,
      mode: options.mode,
      indexers: options.indexers,
      languages: options.languages,
      outputDir: options.outputDir ?? path.join(this.dataDir, "scip"),
      storageRoot: this.dataDir,
    });
  }

  getPreciseRefs(
    nodeId: string,
    limit?: number,
  ): Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }> {
    const symbol = this.queries.getNodeById(nodeId)?.scipSymbol;
    if (!symbol) return [];
    return this.queries.getScipOccurrencesWithDocuments(symbol, limit);
  }

  getPreciseRefsForSymbol(
    symbol: string,
    limit?: number,
  ): Array<{
    symbol: ScipSymbolRecord;
    node?: Node;
    occurrences: Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }>;
    relationships: ScipRelationshipRecord[];
  }> {
    const symbols = new Map<string, ScipSymbolRecord>();
    const exact = this.queries.getScipSymbol(symbol);
    if (exact) symbols.set(exact.symbol, exact);
    for (const result of this.searchNodes(symbol, { limit: 10 })) {
      if (!result.node.scipSymbol) continue;
      const linked = this.queries.getScipSymbol(result.node.scipSymbol);
      if (linked) symbols.set(linked.symbol, linked);
    }
    for (const match of this.queries.searchScipSymbols(symbol, 10)) {
      symbols.set(match.symbol, match);
    }

    return [...symbols.values()].map((scipSymbol) => {
      const node =
        this.queries.getNodeByScipSymbol(scipSymbol.symbol) ?? undefined;
      return {
        symbol: scipSymbol,
        node,
        occurrences: this.queries.getScipOccurrencesWithDocuments(
          scipSymbol.symbol,
          limit,
        ),
        relationships: this.queries.getScipRelationshipsForSymbol(
          scipSymbol.symbol,
          limit,
        ),
      };
    });
  }

  findPreciseSymbols(
    symbol: string,
    limit = 10,
  ): Array<{ symbol: ScipSymbolRecord; node?: Node }> {
    const symbols = new Map<string, ScipSymbolRecord>();
    const exact = this.queries.getScipSymbol(symbol);
    if (exact) symbols.set(exact.symbol, exact);
    for (const result of this.searchNodes(symbol, { limit })) {
      if (!result.node.scipSymbol) continue;
      const linked = this.queries.getScipSymbol(result.node.scipSymbol);
      if (linked) symbols.set(linked.symbol, linked);
    }
    for (const match of this.queries.searchScipSymbols(symbol, limit)) {
      symbols.set(match.symbol, match);
    }
    return [...symbols.values()].slice(0, limit).map((scipSymbol) => ({
      symbol: scipSymbol,
      node: this.queries.getNodeByScipSymbol(scipSymbol.symbol) ?? undefined,
    }));
  }

  getPreciseOccurrencesForSymbol(
    symbol: string,
    role: "definition" | "reference",
    limit?: number,
  ): Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }> {
    return this.queries.getScipOccurrencesWithDocuments(symbol, limit, role);
  }

  getPreciseRelationshipsForSymbol(
    symbol: string,
    limit?: number,
    kind?: "implementation" | "typeDefinition",
  ): ScipRelationshipRecord[] {
    return this.queries.getScipRelationshipsForSymbol(symbol, limit, kind);
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.assertWritable("reinitializeResolver");
    this.initializeResolver();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  getCapabilityAssertionsByNodeIds(
    nodeIds: readonly string[],
  ): CapabilityAssertion[] {
    return this.queries.getCapabilityAssertionsByNodeIds(nodeIds);
  }

  getCapabilityAnalysisRuns(
    filePaths?: readonly string[],
  ): CapabilityAnalysisRun[] {
    return this.queries.getCapabilityAnalysisRuns(filePaths);
  }

  /**
   * Active SQLite backend for this project's connection (`node-sqlite` — Node's
   * built-in real-SQLite module). Surfaced via `solidkg status` and the
   * `solidkg_status` MCP tool alongside the effective journal mode.
   */
  getBackend(): import("./db").SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `solidkg status` and the `solidkg_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node["kind"]): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  searchSourceChunks(
    query: string,
    options?: SourceChunkSearchOptions,
  ): SourceChunkSearchResult[] {
    return this.queries.searchSourceChunks(query, options);
  }

  getSourceChunksByFile(filePath: string): SourceChunkRecord[] {
    return this.queries.getSourceChunksByFile(filePath);
  }

  getSourceChunkDiagnostics(): SourceChunkDiagnostics {
    return this.queries.getSourceChunkDiagnostics();
  }

  getRetrievalExtensionStatus(): RetrievalExtensionStatus {
    return this.queries.getRetrievalExtensionStatus();
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  getHyperedgesByNode(nodeId: string): HyperedgeRelation[] {
    return this.queries.getHyperedgesByNode(nodeId);
  }

  findHyperedgesBetweenNodes(
    nodeIds: string[],
    kinds?: HyperedgeKind[],
  ): HyperedgeRelation[] {
    return this.queries.findHyperedgesBetweenNodes(nodeIds, kinds);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  getOverviewTree(options: OverviewTreeOptions = {}): OverviewTree {
    const architecture =
      options.includeMetadata === false
        ? undefined
        : (this.queries.getArchitectureReport() ?? undefined);
    return buildOverviewTree(
      {
        files: this.queries.getAllFiles(),
        nodes: this.queries.getAllNodes(),
        architectureAssignments: architecture?.fileAssignments,
      },
      options,
    );
  }

  getOverviewText(options: OverviewTreeOptions = {}): string {
    return formatOverviewTree(this.getOverviewTree(options), options);
  }

  async createSnapshot(
    label: string,
    input: SnapshotMetadataInput = {},
  ): Promise<SnapshotMetadata> {
    this.assertWritable("createSnapshot");
    const graph = this.captureSnapshotGraph();
    const analysis = this.captureArchitectureHealth(input.architecture);
    const metadata: SnapshotMetadata = {
      label,
      description: input.description,
      metadata: input.metadata,
      createdAt: Date.now(),
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      hyperedgeCount: graph.hyperedges.length,
      hyperedgeMemberCount: graph.hyperedgeMembers.length,
    };
    this.queries.saveSnapshot(metadata, graph, [
      this.createSnapshotArchitectureHealthAnalysis(label, analysis),
    ]);
    return metadata;
  }

  async listSnapshots(): Promise<SnapshotMetadata[]> {
    return this.queries.listSnapshots();
  }

  async deleteSnapshot(label: string): Promise<boolean> {
    this.assertWritable("deleteSnapshot");
    return this.queries.deleteSnapshot(label);
  }

  async diffSnapshot(label: string): Promise<SnapshotDiff> {
    const snapshot = this.queries.getSnapshot(label);
    if (!snapshot) throw new Error(`Snapshot "${label}" not found`);
    return this.diffSnapshotGraph(snapshot.graph, this.captureSnapshotGraph());
  }

  async getSnapshotHealthDrift(label: string): Promise<SnapshotHealthDrift> {
    const snapshot = this.queries.getSnapshot(label);
    if (!snapshot) throw new Error(`Snapshot "${label}" not found`);
    const storedAnalysis = this.queries
      .getSnapshotAnalyses(label)
      .find((analysis) => analysis.analysisKind === "architecture_health");
    const baseline = storedAnalysis
      ? (JSON.parse(storedAnalysis.payloadJson) as SnapshotArchitectureHealthBundle)
          .health
      : null;
    const current = this.captureArchitectureHealth(baseline?.options).health;
    const graphDiff = this.diffSnapshotGraph(
      snapshot.graph,
      this.captureSnapshotGraph(),
    );
    return compareSnapshotHealthDrift({
      baselineLabel: label,
      baseline,
      current,
      graphDiffCounts: snapshotDiffCounts(graphDiff),
    });
  }

  getArchitectureHealth(
    options: AnalyzeArchitectureOptions = {},
  ): ArchitectureHealthReport {
    return this.captureArchitectureHealth(options).health;
  }

  private diffSnapshotGraph(
    snapshot: SnapshotGraph,
    current: SnapshotGraph,
  ): SnapshotDiff {
    const nodes = diffRecords(
      snapshot.nodes,
      current.nodes,
      (node) => node.id,
    );
    const edges = diffRecords(snapshot.edges, current.edges, edgeKey);
    const hyperedges = diffRecords(
      snapshot.hyperedges,
      current.hyperedges,
      (hyperedge) => hyperedge.id,
    );
    const members = diffRecords(
      snapshot.hyperedgeMembers,
      current.hyperedgeMembers,
      memberKey,
    );
    return {
      addedNodes: nodes.added,
      removedNodes: nodes.removed,
      changedNodes: nodes.changed,
      addedEdges: edges.added,
      removedEdges: edges.removed,
      changedEdges: edges.changed,
      addedHyperedges: hyperedges.added,
      removedHyperedges: hyperedges.removed,
      changedHyperedges: hyperedges.changed,
      addedHyperedgeMembers: members.added,
      removedHyperedgeMembers: members.removed,
      changedHyperedgeMembers: members.changed,
    };
  }

  analyzeArchitecture(
    options: AnalyzeArchitectureOptions = {},
  ): ArchitectureReport {
    this.assertWritable("analyzeArchitecture");
    const report = this.projectArchitecture(options);
    this.queries.saveArchitectureReport(report);
    return report;
  }

  private projectArchitecture(
    options: AnalyzeArchitectureOptions = {},
  ): ArchitectureReport {
    const files = this.queries.getAllFiles();
    const nodes = this.queries.getAllNodes();
    return this.projectArchitectureFromFacts(files, nodes, this.allEdges(nodes), options);
  }

  private projectArchitectureFromFacts(
    files: readonly FileRecord[],
    nodes: readonly Node[],
    edges: readonly Edge[],
    options: AnalyzeArchitectureOptions,
  ): ArchitectureReport {
    return buildArchitectureReport({
      rootPackageName: path.basename(this.projectRoot),
      files,
      nodes,
      edges,
      manifests: this.collectArchitectureManifestPackages(files),
      layerRules: options.layers ?? [],
    });
  }

  private captureArchitectureHealth(
    options: AnalyzeArchitectureOptions = {},
  ): {
    architecture: ArchitectureReport;
    health: ArchitectureHealthReport;
    options: NormalizedArchitectureHealthOptions;
  } {
    const normalizedOptions = normalizeArchitectureHealthOptions(options);
    const files = this.queries.getAllFiles();
    const nodes = this.queries.getAllNodes();
    const edges = this.allEdges(nodes);
    const architecture = this.projectArchitectureFromFacts(
      files,
      nodes,
      edges,
      normalizedOptions,
    );
    return {
      architecture,
      health: deriveArchitectureHealth({
        architecture,
        options: normalizedOptions,
        producer: {
          solidkgVersion: SOLIDKG_VERSION,
          schemaVersion: this.db.getSchemaVersion()?.version ?? 0,
          graphFactPolicy: "all_indexed_architecture_edges_v1",
        },
        files,
        nodes,
        edges,
        unresolvedReferences: this.queries.getUnresolvedReferences(),
        scip: this.queries.getScipStats(),
      }),
      options: normalizedOptions,
    };
  }

  private createSnapshotArchitectureHealthAnalysis(
    snapshotLabel: string,
    analysis: {
      architecture: ArchitectureReport;
      health: ArchitectureHealthReport;
      options: NormalizedArchitectureHealthOptions;
    },
  ): StoredSnapshotAnalysisRow {
    const payload: SnapshotArchitectureHealthBundle = {
      options: analysis.options,
      architecture: analysis.architecture,
      health: analysis.health,
    };
    return {
      snapshotLabel,
      analysisKind: "architecture_health",
      analysisVersion: 1,
      optionsJson: canonicalJson(analysis.options),
      payloadJson: canonicalJson(payload),
    };
  }

  getArchitecture(): ArchitectureReport {
    return this.queries.getArchitectureReport() ?? this.analyzeArchitecture();
  }

  getPackage(nameOrPath: string): ArchitecturePackage | null {
    return this.getPackageLookup(nameOrPath).package;
  }

  getPackageLookup(nameOrPath: string): ArchitecturePackageLookup {
    const report = this.getArchitecture();
    const normalized = normalizePath(nameOrPath);
    const exactName = report.packages.find((pkg) => pkg.name === nameOrPath);
    if (exactName)
      return {
        query: nameOrPath,
        kind: "package",
        resolvedBy: "name",
        package: exactName,
      };
    const exactRoot = report.packages.find((pkg) => pkg.root === normalized);
    if (exactRoot)
      return {
        query: nameOrPath,
        kind: "package",
        resolvedBy: "root",
        package: exactRoot,
      };
    const pathLike =
      normalized.includes("/") ||
      normalized.startsWith("@") ||
      /\.[^/]+$/.test(normalized);
    if (!pathLike)
      return {
        query: nameOrPath,
        kind: "package",
        resolvedBy: "not_found",
        package: null,
      };
    const matchingAssignments = report.fileAssignments.filter((assignment) =>
      pathMatchesPrefix(assignment.filePath, normalized),
    );
    if (matchingAssignments.length === 0) {
      return {
        query: nameOrPath,
        kind: "path",
        resolvedBy: "not_found",
        package: null,
        matchedPath: normalized,
        matchedFileCount: 0,
      };
    }
    const assignmentPackageKeys = new Set(
      matchingAssignments.map(
        (assignment) => `${assignment.packageName}\0${assignment.packageRoot}`,
      ),
    );
    const containing = report.packages
      .filter((pkg) => assignmentPackageKeys.has(`${pkg.name}\0${pkg.root}`))
      .sort(
        (a, b) =>
          (b.root === "." ? 0 : b.root.length) -
          (a.root === "." ? 0 : a.root.length),
      );
    return {
      query: nameOrPath,
      kind: "path",
      resolvedBy: containing[0] ? "owning_package" : "not_found",
      package: containing[0] ?? null,
      matchedPath: normalized,
      matchedFileCount: matchingAssignments.length,
    };
  }

  getCoupling(): ArchitectureReport["coupling"] {
    return this.getArchitecture().coupling;
  }

  private captureSnapshotGraph(): SnapshotGraph {
    const nodes = this.queries.getAllNodes();
    const hyperedgeRelations = this.queries.getAllHyperedgeRelations();
    return {
      nodes: nodes.map(snapshotNode).sort((a, b) => a.id.localeCompare(b.id)),
      edges: this.queries
        .getAllEdges()
        .map(snapshotEdge)
        .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
      hyperedges: hyperedgeRelations.map((relation) =>
        snapshotHyperedge(relation.hyperedge),
      ),
      hyperedgeMembers: hyperedgeRelations
        .flatMap((relation) => relation.members.map(snapshotHyperedgeMember))
        .sort((a, b) => memberKey(a).localeCompare(memberKey(b))),
    };
  }

  private allEdges(nodes: Node[]): Edge[] {
    const edges = new Map<string, Edge>();
    for (const node of nodes) {
      for (const edge of this.queries.getOutgoingEdges(node.id)) {
        const record = snapshotEdge(edge);
        edges.set(edgeKey(record), edge);
      }
    }
    return [...edges.values()];
  }

  private collectArchitectureManifestPackages(
    files: readonly { path: string }[],
  ): ArchitectureManifestPackage[] {
    const manifests = new Map<string, ArchitectureManifestPackage>();
    for (const file of files) {
      let directory: string | null = directoryOf(file.path);
      while (directory !== null) {
        if (!manifests.has(directory)) {
          const manifestPath = path.join(
            this.projectRoot,
            directory === "." ? "" : directory,
            "package.json",
          );
          if (existsSync(manifestPath)) {
            manifests.set(directory, {
              root: directory,
              name: this.packageNameFromManifest(manifestPath, directory),
            });
          }
        }
        directory = parentDir(directory);
      }
    }
    return [...manifests.values()];
  }

  private packageNameFromManifest(manifestPath: string, root: string): string {
    const fallback =
      root === "." ? path.basename(this.projectRoot) : path.basename(root);
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        name?: unknown;
      };
      if (typeof parsed.name === "string" && parsed.name.length > 0)
        return parsed.name;
    } catch {
      return fallback;
    }
    return fallback;
  }


  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(
    nodeId: string,
    maxDepth: number = 1,
  ): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  getCallersDetailed(
    nodeId: string,
    maxDepth: number = 1,
  ): RelatedNodeTraversalResult {
    return this.traverser.getCallersDetailed(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(
    nodeId: string,
    maxDepth: number = 1,
  ): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  getCalleesDetailed(
    nodeId: string,
    maxDepth: number = 1,
  ): RelatedNodeTraversalResult {
    return this.traverser.getCalleesDetailed(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  getImpactTraversal(
    nodeId: string,
    maxDepth: number = 3,
  ): GraphTraversalResult {
    return this.traverser.getImpactTraversal(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge["kind"][],
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node["kind"][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions,
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions,
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.assertWritable("optimize");
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.assertWritable("clear");
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove SolidKG from the project.
   * This closes the database and deletes the .SolidKG directory.
   *
   * WARNING: This permanently deletes all SolidKG data for the project.
   */
  uninitialize(): void {
    this.assertWritable("uninitialize");
    this.close();
    removeDirectory(this.projectRoot, {
      dataDir: this.explicitDataDir ? this.dataDir : undefined,
    });
  }
}

// Default export
export default SolidKG;
