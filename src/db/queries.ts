/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Hyperedge,
  HyperedgeKind,
  HyperedgeMember,
  HyperedgeProvenance,
  HyperedgeRelation,
  FrameworkRelationHintRef,
  Language,
  GraphStats,
  ScipDocumentRecord,
  ScipIndexRecord,
  ScipOccurrenceRecord,
  ScipRelationshipRecord,
  ScipStats,
  ScipSymbolRecord,
  SearchOptions,
  SearchRankingReason,
  SearchResult,
  RetrievalExtensionConfig,
  RetrievalExtensionDiagnostic,
  RetrievalExtensionStatus,
  SourceChunkDiagnostics,
  SourceChunkDiagnostic,
  SourceChunkRecord,
  SourceChunkSearchOptions,
  SourceChunkSearchResult,
} from '../types';
import type { CapabilityAnalysisRun, CapabilityAssertion } from '../capabilities';
import { safeJsonParse } from '../utils';
import { getScipGenerationStatus } from '../scip';
import { buildSourceChunkFtsQuery, isTestFile, kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { isGeneratedFile, isGeneratedFileQuery } from '../search/path-classifiers';
import { parseQuery, boundedEditDistance } from '../search/query-parser';
import { SOLIDKG_VERSION_METADATA_KEY } from '../version';

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  scip_symbol: string | null;
  scip_kind: string | null;
  scip_display_name: string | null;
  scip_signature: string | null;
  scip_documentation: string | null;
  scip_source_indexers: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface HyperedgeRow {
  id: string;
  kind: string;
  source_file: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
  confidence: number | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface HyperedgeMemberRow {
  hyperedge_id: string;
  node_id: string;
  role: string;
  ordinal: number;
  metadata: string | null;
}

type HyperedgeMemberWithNodeRow = HyperedgeMemberRow & NodeRow;

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
}

interface ScipDocumentRow {
  id: string;
  index_id: string;
  relative_path: string;
  repo_relative_path: string;
  language: string;
  position_encoding: string | null;
  text_sha256: string | null;
  metadata: string | null;
}

interface ScipSymbolRow {
  symbol: string;
  scheme: string | null;
  package_manager: string | null;
  package_name: string | null;
  package_version: string | null;
  display_name: string | null;
  kind: string | null;
  enclosing_symbol: string | null;
  documentation: string | null;
  signature_language: string | null;
  signature_text: string | null;
  source_index_ids: string | null;
  metadata: string | null;
}

interface ScipOccurrenceRow {
  id: string;
  document_id: string;
  symbol: string | null;
  start_line: number;
  start_character: number;
  end_line: number;
  end_character: number;
  symbol_roles: number | null;
  syntax_kind: string | null;
  enclosing_start_line: number | null;
  enclosing_start_character: number | null;
  enclosing_end_line: number | null;
  enclosing_end_character: number | null;
  override_documentation: string | null;
  diagnostics: string | null;
}

interface ScipRelationshipRow {
  id: string;
  source_symbol: string;
  target_symbol: string;
  is_reference: number;
  is_implementation: number;
  is_type_definition: number;
  is_definition: number;
  metadata: string | null;
}

interface CapabilityAssertionRow {
  id: string;
  subject_node_id: string;
  operation: string;
  resource_kind: string;
  resource_key: string;
  target_node_id: string | null;
  scope: string;
  file_path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  origin: string;
  certainty: string;
  producer_id: string;
  rule_id: string;
  producer_version: string;
  supporting_hyperedge_id: string | null;
  metadata: string | null;
  updated_at: number;
}

interface CapabilityAnalysisRunRow {
  file_path: string;
  producer_id: string;
  producer_version: string;
  source_hash: string;
  status: string;
  diagnostics: string | null;
  updated_at: number;
}

interface SourceChunkRow {
  id: string;
  node_id: string;
  file_path: string;
  language: string;
  symbol_kind: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  source_hash: string;
  chunk_ordinal: number;
  indexer_version: string;
  content: string;
  code_token_text: string;
  metadata: string | null;
  diagnostics: string | null;
  updated_at: number;
}

interface FusionCandidate {
  readonly node: Node;
  readonly score: number;
  readonly rankingReasons: readonly SearchRankingReason[];
}

interface FusionInputs {
  readonly query: string;
  readonly text: string;
  readonly kinds?: readonly NodeKind[];
  readonly languages?: readonly Language[];
  readonly pathFilters: readonly string[];
  readonly nameFilters: readonly string[];
  readonly limit: number;
}

export interface QueryBuilderOptions {
  readonly retrieval?: RetrievalExtensionConfig;
}

const DEFAULT_RETRIEVAL_BOUNDS = {
  maxCandidates: 50,
  timeoutMs: 75,
  maxPayloadBytes: 32_768,
} as const;

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeRetrievalExtensionStatus(config: RetrievalExtensionConfig | undefined): RetrievalExtensionStatus {
  const hybrid = config?.hybrid;
  const bounds = {
    maxCandidates: positiveIntegerOrDefault(hybrid?.maxCandidates, DEFAULT_RETRIEVAL_BOUNDS.maxCandidates),
    timeoutMs: positiveIntegerOrDefault(hybrid?.timeoutMs, DEFAULT_RETRIEVAL_BOUNDS.timeoutMs),
    maxPayloadBytes: positiveIntegerOrDefault(hybrid?.maxPayloadBytes, DEFAULT_RETRIEVAL_BOUNDS.maxPayloadBytes),
  };
  const skippedChannels = [...new Set((hybrid?.candidateChannels ?? []).map((channel) => channel.kind))];
  const diagnostics: RetrievalExtensionDiagnostic[] = [];
  if (hybrid?.mode === 'external') {
    diagnostics.push({
      severity: 'error',
      code: 'hybrid_retrieval.unsupported_mode',
      message: 'External dense/rerank retrieval is not enabled in this build; deterministic local fusion remains active.',
    });
  }
  if (skippedChannels.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'hybrid_retrieval.channels_disabled',
      message: 'Optional dense/rerank candidate channels were declared but not instantiated because hybrid retrieval is disabled.',
    });
  }
  return {
    mode: 'disabled',
    activeChannels: [],
    skippedChannels,
    bounds,
    diagnostics,
  };
}

export type StoredSnapshotNodeRecord = Omit<Node, 'updatedAt'>;
export type StoredSnapshotEdgeRecord = Pick<Edge, 'source' | 'target' | 'kind' | 'metadata' | 'line' | 'column' | 'provenance'>;
export type StoredSnapshotHyperedgeRecord = Pick<Hyperedge, 'id' | 'kind' | 'sourceFile' | 'line' | 'column' | 'provenance' | 'confidence' | 'metadata'>;
export type StoredSnapshotHyperedgeMemberRecord = Pick<HyperedgeMember, 'hyperedgeId' | 'nodeId' | 'role' | 'ordinal' | 'metadata'>;

export interface StoredSnapshotMetadata {
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  hyperedgeMemberCount: number;
}

export interface StoredSnapshotGraph {
  nodes: StoredSnapshotNodeRecord[];
  edges: StoredSnapshotEdgeRecord[];
  hyperedges: StoredSnapshotHyperedgeRecord[];
  hyperedgeMembers: StoredSnapshotHyperedgeMemberRecord[];
}

export interface StoredArchitecturePackage {
  name: string;
  root: string;
  provenance: 'manifest' | 'root';
  fileCount: number;
}

export interface StoredArchitectureLayer {
  name: string;
  provenance: 'config_layer' | 'unassigned';
  fileCount: number;
}

export interface StoredArchitectureFileAssignment {
  filePath: string;
  packageName: string;
  packageRoot: string;
  packageProvenance: 'manifest' | 'root' | 'unassigned';
  layerName: string;
  layerProvenance: 'config_layer' | 'unassigned';
}

export interface StoredArchitectureDependency {
  source: string;
  target: string;
  edgeKinds: string[];
}

export interface StoredCouplingMetric {
  name: string;
  Ca: number;
  Ce: number;
  instability: number;
}

export interface StoredArchitectureReport {
  packages: StoredArchitecturePackage[];
  layers: StoredArchitectureLayer[];
  fileAssignments: StoredArchitectureFileAssignment[];
  packageDependencies: StoredArchitectureDependency[];
  layerDependencies: StoredArchitectureDependency[];
  coupling: {
    packages: StoredCouplingMetric[];
    layers: StoredCouplingMetric[];
  };
}

interface SnapshotMetadataRow {
  label: string;
  description: string | null;
  metadata: string | null;
  created_at: number;
  node_count: number;
  edge_count: number;
  hyperedge_count: number;
  hyperedge_member_count: number;
}

interface JsonPayloadRow {
  payload: string;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    scipSymbol: row.scip_symbol ?? undefined,
    scipKind: row.scip_kind ?? undefined,
    scipDisplayName: row.scip_display_name ?? undefined,
    scipSignature: row.scip_signature ?? undefined,
    scipDocumentation: row.scip_documentation ?? undefined,
    scipSourceIndexers: row.scip_source_indexers ? safeJsonParse(row.scip_source_indexers, undefined) : undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

const RELATION_HINT_CANDIDATE_PREFIX = '__solidkg_relation_hint__:';

function encodeUnresolvedCandidates(ref: UnresolvedReference): string | null {
  const candidates = [...(ref.candidates ?? [])];
  if (ref.relationHint) {
    candidates.push(`${RELATION_HINT_CANDIDATE_PREFIX}${JSON.stringify(ref.relationHint)}`);
  }
  return candidates.length > 0 ? JSON.stringify(candidates) : null;
}

function decodeUnresolvedCandidates(value: string | null): Pick<UnresolvedReference, 'candidates' | 'relationHint'> {
  if (!value) return {};
  const parsed = safeJsonParse<unknown[]>(value, []);
  if (!Array.isArray(parsed)) return {};

  const candidates: string[] = [];
  let relationHint: FrameworkRelationHintRef | undefined;
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    if (entry.startsWith(RELATION_HINT_CANDIDATE_PREFIX)) {
      const decoded = safeJsonParse(entry.slice(RELATION_HINT_CANDIDATE_PREFIX.length), undefined) as FrameworkRelationHintRef | undefined;
      if (decoded?.id && decoded.kind && decoded.relationKind && decoded.role && typeof decoded.ordinal === 'number') {
        relationHint = decoded;
      }
      continue;
    }
    candidates.push(entry);
  }

  return {
    candidates: candidates.length > 0 ? candidates : undefined,
    relationHint,
  };
}

function rowToUnresolvedReference(row: UnresolvedRefRow): UnresolvedReference {
  const decoded = decodeUnresolvedCandidates(row.candidates);
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    ...decoded,
    filePath: row.file_path,
    language: row.language as Language,
  };
}

function rowToScipDocument(row: ScipDocumentRow): ScipDocumentRecord {
  return {
    id: row.id,
    indexId: row.index_id,
    relativePath: row.relative_path,
    repoRelativePath: row.repo_relative_path,
    language: row.language,
    positionEncoding: row.position_encoding ?? undefined,
    textSha256: row.text_sha256 ?? undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
  };
}

function rowToScipSymbol(row: ScipSymbolRow): ScipSymbolRecord {
  return {
    symbol: row.symbol,
    scheme: row.scheme ?? undefined,
    packageManager: row.package_manager ?? undefined,
    packageName: row.package_name ?? undefined,
    packageVersion: row.package_version ?? undefined,
    displayName: row.display_name ?? undefined,
    kind: row.kind ?? undefined,
    enclosingSymbol: row.enclosing_symbol ?? undefined,
    documentation: row.documentation ?? undefined,
    signatureLanguage: row.signature_language ?? undefined,
    signatureText: row.signature_text ?? undefined,
    sourceIndexIds: row.source_index_ids ? safeJsonParse(row.source_index_ids, undefined) : undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
  };
}

function rowToScipOccurrence(row: ScipOccurrenceRow): ScipOccurrenceRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    symbol: row.symbol ?? undefined,
    startLine: row.start_line,
    startCharacter: row.start_character,
    endLine: row.end_line,
    endCharacter: row.end_character,
    symbolRoles: row.symbol_roles ?? undefined,
    syntaxKind: row.syntax_kind ?? undefined,
    enclosingStartLine: row.enclosing_start_line ?? undefined,
    enclosingStartCharacter: row.enclosing_start_character ?? undefined,
    enclosingEndLine: row.enclosing_end_line ?? undefined,
    enclosingEndCharacter: row.enclosing_end_character ?? undefined,
    overrideDocumentation: row.override_documentation ? safeJsonParse(row.override_documentation, undefined) : undefined,
    diagnostics: row.diagnostics ? safeJsonParse(row.diagnostics, undefined) : undefined,
  };
}

function rowToSnapshotMetadata(row: SnapshotMetadataRow): StoredSnapshotMetadata {
  return {
    label: row.label,
    description: row.description ?? undefined,
    metadata: row.metadata ? safeJsonParse<Record<string, unknown> | undefined>(row.metadata, undefined) : undefined,
    createdAt: row.created_at,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    hyperedgeCount: row.hyperedge_count,
    hyperedgeMemberCount: row.hyperedge_member_count,
  };
}

function parsePayloadRows<T>(rows: JsonPayloadRow[]): T[] {
  const records: T[] = [];
  for (const row of rows) {
    const parsed = safeJsonParse<T | null>(row.payload, null);
    if (parsed !== null) records.push(parsed);
  }
  return records;
}

function storedEdgeKey(edge: StoredSnapshotEdgeRecord): string {
  return [edge.source, edge.target, edge.kind, edge.line ?? '', edge.column ?? '', edge.provenance ?? ''].join('\0');
}

function storedMemberKey(member: StoredSnapshotHyperedgeMemberRecord): string {
  return [member.hyperedgeId, member.nodeId, member.role, member.ordinal].join('\0');
}

function rowToScipRelationship(row: ScipRelationshipRow): ScipRelationshipRecord {
  return {
    id: row.id,
    sourceSymbol: row.source_symbol,
    targetSymbol: row.target_symbol,
    isReference: row.is_reference === 1,
    isImplementation: row.is_implementation === 1,
    isTypeDefinition: row.is_type_definition === 1,
    isDefinition: row.is_definition === 1,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
  };
}

function escapeSqlLike(value: string): string {
  return value.replace(/[!%_]/g, (match) => `!${match}`);
}

function scipRelationshipSourceIndexIds(metadata: Record<string, unknown> | undefined): string[] {
  const ids = metadata?.sourceIndexIds;
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  const legacyId = metadata?.sourceIndexId;
  return typeof legacyId === 'string' ? [legacyId] : [];
}

function withScipRelationshipSourceIndexIds(
  metadata: Record<string, unknown> | undefined,
  sourceIndexIds: string[]
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) };
  delete next.sourceIndexId;
  if (sourceIndexIds.length === 0) {
    delete next.sourceIndexIds;
  } else {
    next.sourceIndexIds = sourceIndexIds;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function finitePositiveLimit(limit: number | undefined): number | undefined {
  return Number.isFinite(limit) && limit !== undefined && limit > 0 ? Math.floor(limit) : undefined;
}

type PreservedScipNodeFields = Pick<Node,
  'scipSymbol' | 'scipKind' | 'scipDisplayName' | 'scipSignature' | 'scipDocumentation' | 'scipSourceIndexers'
>;

function rowToHyperedge(row: HyperedgeRow): Hyperedge {
  return {
    id: row.id,
    kind: row.kind as HyperedgeKind,
    sourceFile: row.source_file ?? undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance ? row.provenance as HyperedgeProvenance : undefined,
    confidence: row.confidence ?? undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHyperedgeMember(row: HyperedgeMemberRow): HyperedgeMember {
  return {
    hyperedgeId: row.hyperedge_id,
    nodeId: row.node_id,
    role: row.role,
    ordinal: row.ordinal,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}

function rowToCapabilityAssertion(row: CapabilityAssertionRow): CapabilityAssertion {
  return {
    id: row.id,
    subjectNodeId: row.subject_node_id,
    operation: row.operation as CapabilityAssertion['operation'],
    resourceKind: row.resource_kind as CapabilityAssertion['resourceKind'],
    resourceKey: row.resource_key,
    targetNodeId: row.target_node_id ?? undefined,
    scope: row.scope as CapabilityAssertion['scope'],
    filePath: row.file_path,
    startLine: row.start_line,
    startColumn: row.start_column,
    endLine: row.end_line,
    endColumn: row.end_column,
    origin: row.origin as CapabilityAssertion['origin'],
    certainty: row.certainty as CapabilityAssertion['certainty'],
    producerId: row.producer_id,
    ruleId: row.rule_id,
    producerVersion: row.producer_version,
    supportingHyperedgeId: row.supporting_hyperedge_id ?? undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
  };
}

function rowToCapabilityAnalysisRun(row: CapabilityAnalysisRunRow): CapabilityAnalysisRun {
  return {
    filePath: row.file_path,
    producerId: row.producer_id,
    producerVersion: row.producer_version,
    sourceHash: row.source_hash,
    status: row.status as CapabilityAnalysisRun['status'],
    diagnostics: row.diagnostics ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToSourceChunk(row: SourceChunkRow): SourceChunkRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    filePath: row.file_path,
    language: row.language as Language,
    symbolKind: row.symbol_kind as NodeKind,
    startLine: row.start_line,
    endLine: row.end_line,
    contentHash: row.content_hash,
    sourceHash: row.source_hash,
    chunkOrdinal: row.chunk_ordinal,
    indexerVersion: row.indexer_version,
    content: row.content,
    codeTokenText: row.code_token_text,
    metadata: row.metadata ? safeJsonParse<Record<string, unknown> | undefined>(row.metadata, undefined) : undefined,
    diagnostics: row.diagnostics ? safeJsonParse<SourceChunkDiagnostic[] | undefined>(row.diagnostics, undefined) : undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;
  private statementCounts: Map<string, number> | null = null;
  private readonly retrievalExtensionStatus: RetrievalExtensionStatus;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;
  private readonly preservedScipFieldsByNodeId = new Map<string, PreservedScipNodeFields>();

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    insertHyperedge?: SqliteStatement;
    deleteHyperedgeMembers?: SqliteStatement;
    insertHyperedgeMember?: SqliteStatement;
    getHyperedgeById?: SqliteStatement;
    getHyperedgeMembersById?: SqliteStatement;
    getHyperedgeIdsByNode?: SqliteStatement;
    deleteHyperedgesByKind?: SqliteStatement;
    deleteHyperedgesByProvenance?: SqliteStatement;
    deleteOrphanHyperedges?: SqliteStatement;
    getEdgesByProvenance?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getFileLanguageCounts?: SqliteStatement;
    getFilePathsByLanguage?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
    hasNodeName?: SqliteStatement;
    hasRootQualifiedFilePath?: SqliteStatement;
    insertCapabilityAssertion?: SqliteStatement;
    upsertCapabilityAnalysisRun?: SqliteStatement;
    deleteCapabilityAssertionsByFile?: SqliteStatement;
    deleteCapabilityRunsByFile?: SqliteStatement;
    getCapabilityRunsByFile?: SqliteStatement;
    upsertSourceChunk?: SqliteStatement;
    deleteSourceChunksByFile?: SqliteStatement;
    getSourceChunksByFile?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase, options: QueryBuilderOptions = {}) {
    this.db = db;
    this.retrievalExtensionStatus = normalizeRetrievalExtensionStatus(options.retrieval);
  }

  getRetrievalExtensionStatus(): RetrievalExtensionStatus {
    return {
      ...this.retrievalExtensionStatus,
      activeChannels: [...this.retrievalExtensionStatus.activeChannels],
      skippedChannels: [...this.retrievalExtensionStatus.skippedChannels],
      bounds: { ...this.retrievalExtensionStatus.bounds },
      diagnostics: [...this.retrievalExtensionStatus.diagnostics],
    };
  }

  enableStatementCounting(): void {
    this.statementCounts = new Map();
  }

  disableStatementCounting(): void {
    this.statementCounts = null;
  }

  getStatementCounts(): Record<string, number> {
    return Object.fromEntries(this.statementCounts ?? []);
  }

  private countStatement(group: string, count = 1): void {
    if (!this.statementCounts) return;
    this.statementCounts.set(group, (this.statementCounts.get(group) ?? 0) + count);
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, scip_symbol, scip_kind, scip_display_name,
          scip_signature, scip_documentation, scip_source_indexers, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @scipSymbol, @scipKind, @scipDisplayName,
          @scipSignature, @scipDocumentation, @scipSourceIndexers, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @updatedAt
        )
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[SolidKG] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    const existing = this.getNodeById(node.id);
    const preservedScip = existing ?? this.preservedScipFieldsByNodeId.get(node.id);

    // INSERT OR REPLACE may overwrite a node we have cached. Drop the
    // stale entry so the next getNodeById sees the new row, not the old
    // one (matches the cache-invalidation pattern used by updateNode and
    // deleteNode below).
    this.nodeCache.delete(node.id);

    this.stmts.insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      scipSymbol: node.scipSymbol ?? preservedScip?.scipSymbol ?? null,
      scipKind: node.scipKind ?? preservedScip?.scipKind ?? null,
      scipDisplayName: node.scipDisplayName ?? preservedScip?.scipDisplayName ?? null,
      scipSignature: node.scipSignature ?? preservedScip?.scipSignature ?? null,
      scipDocumentation: node.scipDocumentation ?? preservedScip?.scipDocumentation ?? null,
      scipSourceIndexers: (node.scipSourceIndexers ?? preservedScip?.scipSourceIndexers) ? JSON.stringify(node.scipSourceIndexers ?? preservedScip?.scipSourceIndexers) : null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
    this.countStatement('nodes.write');
    this.preservedScipFieldsByNodeId.delete(node.id);
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          scip_symbol = @scipSymbol,
          scip_kind = @scipKind,
          scip_display_name = @scipDisplayName,
          scip_signature = @scipSignature,
          scip_documentation = @scipDocumentation,
          scip_source_indexers = @scipSourceIndexers,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    const existing = this.getNodeById(node.id);

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[SolidKG] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      scipSymbol: node.scipSymbol ?? existing?.scipSymbol ?? null,
      scipKind: node.scipKind ?? existing?.scipKind ?? null,
      scipDisplayName: node.scipDisplayName ?? existing?.scipDisplayName ?? null,
      scipSignature: node.scipSignature ?? existing?.scipSignature ?? null,
      scipDocumentation: node.scipDocumentation ?? existing?.scipDocumentation ?? null,
      scipSourceIndexers: (node.scipSourceIndexers ?? existing?.scipSourceIndexers) ? JSON.stringify(node.scipSourceIndexers ?? existing?.scipSourceIndexers) : null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
    this.countStatement('nodes.write');
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
    this.countStatement('nodes.delete');
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string, options: { preserveScipFields?: boolean } = {}): void {
    const preserveScipFields = options.preserveScipFields ?? true;
    if (preserveScipFields) {
      const rows = this.db.prepare(`
        SELECT * FROM nodes
        WHERE file_path = ? AND scip_symbol IS NOT NULL
      `).all(filePath) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        this.preservedScipFieldsByNodeId.set(node.id, {
          scipSymbol: node.scipSymbol,
          scipKind: node.scipKind,
          scipDisplayName: node.scipDisplayName,
          scipSignature: node.scipSignature,
          scipDocumentation: node.scipDocumentation,
          scipSourceIndexers: node.scipSourceIndexers,
        });
      }
    }
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
    this.countStatement('nodes.delete');
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    this.countStatement('nodes.read');
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // Serve cache hits first; build the miss list for SQL.
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        // LRU touch
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    // Chunk under SQLite's parameter limit (default 999, raised to 32766
    // in better-sqlite3 builds — chunk at 500 for safety across both
    // backends and to keep the query plan simple).
    const CHUNK = 500;
    for (let i = 0; i < misses.length; i += CHUNK) {
      const chunk = misses.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  hasNodeName(name: string): boolean {
    if (!this.stmts.hasNodeName) {
      this.stmts.hasNodeName = this.db.prepare('SELECT 1 FROM nodes WHERE name = ? LIMIT 1');
    }
    return this.stmts.hasNodeName.get(name) !== undefined;
  }

  getNodeByScipSymbol(symbol: string): Node | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE scip_symbol = ? LIMIT 1').get(symbol) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodesByScipSymbols(symbols: readonly string[]): Node[] {
    if (symbols.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE scip_symbol IN (SELECT value FROM json_each(?))
      ORDER BY file_path, start_line, start_column, id
    `).all(JSON.stringify(Array.from(new Set(symbols)))) as NodeRow[];
    return rows.map(rowToNode);
  }

  getUnlinkedNodesByFileAndNames(filePath: string, names: readonly string[]): Node[] {
    return this.getUnlinkedNodesByFilesAndNames([filePath], names);
  }

  getUnlinkedNodesByFilesAndNames(filePaths: readonly string[], names: readonly string[]): Node[] {
    if (filePaths.length === 0 || names.length === 0) return [];
    const normalizedFilePaths = Array.from(new Set(filePaths.map((filePath) => filePath.replace(/\\/g, '/'))));
    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE scip_symbol IS NULL
        AND replace(file_path, '\\', '/') IN (SELECT value FROM json_each(?))
        AND name IN (SELECT value FROM json_each(?))
      ORDER BY file_path, start_line, start_column, id
    `).all(JSON.stringify(normalizedFilePaths), JSON.stringify(Array.from(new Set(names)))) as NodeRow[];
    return rows.map(rowToNode);
  }

  getUnlinkedNodesByNames(names: readonly string[]): Node[] {
    if (names.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE scip_symbol IS NULL
        AND name IN (SELECT value FROM json_each(?))
      ORDER BY file_path, start_line, start_column, id
    `).all(JSON.stringify(names)) as NodeRow[];
    return rows.map(rowToNode);
  }

  private appendRankingReason(
    reasons: readonly SearchRankingReason[] | undefined,
    reason: SearchRankingReason
  ): readonly SearchRankingReason[] {
    const existing = reasons?.find((entry) => entry.kind === reason.kind && entry.evidence === reason.evidence);
    if (existing) return reasons ?? [];
    return [...(reasons ?? []), reason].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
  }

  private exactSymbolReason(node: Node, query: string, nameFilters: readonly string[]): SearchRankingReason | null {
    const nodeName = node.name.toLowerCase();
    const tokens = query
      .replace(/::/g, ' ')
      .split(/[\s_.\-\/]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 0);
    if (!tokens.includes(nodeName) && !nameFilters.some((filter) => filter.toLowerCase() === nodeName)) return null;
    return { kind: 'exact_symbol', label: `exact symbol ${node.name}`, weight: 120, evidence: node.name };
  }

  private exactPathReason(node: Node, pathFilters: readonly string[]): SearchRankingReason | null {
    if (pathFilters.length === 0) return null;
    const pathLower = node.filePath.toLowerCase();
    const matched = pathFilters.find((filter) => pathLower.includes(filter.toLowerCase()));
    return matched ? { kind: 'exact_path', label: `path filter matched ${matched}`, weight: 100, evidence: matched } : null;
  }

  private graphSignalReason(node: Node): SearchRankingReason | null {
    const weight = kindBonus(node.kind);
    return weight > 0
      ? { kind: 'graph_signal', label: `node kind ${node.kind} boosted`, weight, evidence: node.kind }
      : null;
  }

  private rankedMetadataResult(result: SearchResult, inputs: FusionInputs): SearchResult {
    const metadataReason: SearchRankingReason = {
      kind: 'node_metadata',
      label: 'node metadata FTS/name/path signal matched',
      weight: Math.max(1, result.score),
      evidence: result.node.id,
    };
    let reasons = this.appendRankingReason(result.rankingReasons, metadataReason);
    const exactSymbol = this.exactSymbolReason(result.node, inputs.query, inputs.nameFilters);
    if (exactSymbol) reasons = this.appendRankingReason(reasons, exactSymbol);
    const exactPath = this.exactPathReason(result.node, inputs.pathFilters);
    if (exactPath) reasons = this.appendRankingReason(reasons, exactPath);
    const graphSignal = this.graphSignalReason(result.node);
    if (graphSignal) reasons = this.appendRankingReason(reasons, graphSignal);
    return { ...result, rankingReasons: reasons };
  }

  private sourceBodyChunkScore(rank: number, rawScore: number): number {
    return 25 + Math.max(0, 20 - rank) + Math.min(rawScore * 4, 20);
  }

  private preciseIdentifierQuery(text: string): string | null {
    const trimmed = text.trim();
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  private sourceChunkHasIdentifier(chunk: SourceChunkRecord, identifier: string): boolean {
    return chunk.codeTokenText
      .split(/\s+/)
      .some((token) => token.toLowerCase() === identifier);
  }

  private buildChunkFusionCandidates(inputs: FusionInputs): FusionCandidate[] {
    if (!inputs.text) return [];
    const preciseIdentifier = this.preciseIdentifierQuery(inputs.text);
    const chunkHits = this.searchSourceChunks(inputs.text, {
      languages: inputs.languages,
      limit: Math.max(inputs.limit * 10, 50),
    });
    if (chunkHits.length === 0) return [];

    const nodesById = this.getNodesByIds(chunkHits.map((hit) => hit.chunk.nodeId));
    const bestByNodeId = new Map<string, FusionCandidate>();
    chunkHits.forEach((hit, index) => {
      if (preciseIdentifier && !this.sourceChunkHasIdentifier(hit.chunk, preciseIdentifier)) return;
      const node = nodesById.get(hit.chunk.nodeId);
      if (!node) return;
      if (inputs.kinds && inputs.kinds.length > 0 && !inputs.kinds.includes(node.kind)) return;
      if (inputs.languages && inputs.languages.length > 0 && !inputs.languages.includes(node.language)) return;
      const score = this.sourceBodyChunkScore(index, hit.score) + kindBonus(node.kind);
      const graphSignal = this.graphSignalReason(node);
      const candidate: FusionCandidate = {
        node,
        score,
        rankingReasons: graphSignal ? [graphSignal, {
          kind: 'source_body_chunk',
          label: `source chunk ${hit.chunk.id} matched body/code-token text`,
          weight: score,
          evidence: hit.chunk.id,
        }] : [{
          kind: 'source_body_chunk',
          label: `source chunk ${hit.chunk.id} matched body/code-token text`,
          weight: score,
          evidence: hit.chunk.id,
        }],
      };
      const existing = bestByNodeId.get(node.id);
      if (!existing || candidate.score > existing.score) bestByNodeId.set(node.id, candidate);
    });
    return [...bestByNodeId.values()].sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath));
  }

  private buildOptionalChannelFusionCandidates(): FusionCandidate[] {
    return [];
  }

  private fuseSearchResults(metadataResults: readonly SearchResult[], inputs: FusionInputs): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of metadataResults) {
      byId.set(result.node.id, this.rankedMetadataResult(result, inputs));
    }

    for (const candidate of this.buildChunkFusionCandidates(inputs)) {
      const existing = byId.get(candidate.node.id);
      if (existing) {
        let reasons = existing.rankingReasons ?? [];
        for (const reason of candidate.rankingReasons) reasons = this.appendRankingReason(reasons, reason);
        reasons = this.appendRankingReason(reasons, {
          kind: 'fusion',
          label: 'metadata and source chunk evidence both contributed',
          weight: existing.score + candidate.score,
          evidence: candidate.node.id,
        });
        byId.set(candidate.node.id, { ...existing, score: existing.score + Math.min(candidate.score, 35), rankingReasons: reasons });
      } else {
        byId.set(candidate.node.id, {
          node: candidate.node,
          score: candidate.score,
          rankingReasons: this.appendRankingReason(candidate.rankingReasons, {
            kind: 'fusion',
            label: 'source chunk evidence entered fused node ranking',
            weight: candidate.score,
            evidence: candidate.node.id,
          }),
        });
      }
    }

    for (const candidate of this.buildOptionalChannelFusionCandidates()) {
      const existing = byId.get(candidate.node.id);
      if (existing) {
        let reasons = existing.rankingReasons ?? [];
        for (const reason of candidate.rankingReasons) reasons = this.appendRankingReason(reasons, reason);
        byId.set(candidate.node.id, { ...existing, score: existing.score + candidate.score, rankingReasons: reasons });
      } else {
        byId.set(candidate.node.id, {
          node: candidate.node,
          score: candidate.score,
          rankingReasons: candidate.rankingReasons,
        });
      }
    }

    const isTestQuery = /\b(test|spec)\b/i.test(inputs.query);
    const generatedQuery = isGeneratedFileQuery(inputs.query);
    return [...byId.values()].map((result) => {
      let score = result.score;
      let reasons = result.rankingReasons ?? [];
      if (!isTestQuery && isTestFile(result.node.filePath)) {
        score *= 0.3;
        reasons = this.appendRankingReason(reasons, {
          kind: 'generated_or_test_dampening',
          label: 'test or fixture path demoted for non-test query',
          weight: -70,
          evidence: result.node.filePath,
        });
      }
      if (!generatedQuery && isGeneratedFile(result.node.filePath)) {
        score *= 0.2;
        reasons = this.appendRankingReason(reasons, {
          kind: 'generated_or_test_dampening',
          label: 'generated path demoted for non-generated query',
          weight: -80,
          evidence: result.node.filePath,
        });
      }
      return { ...result, score, rankingReasons: reasons };
    }).sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath) || a.node.name.localeCompare(b.node.name));
  }

  updateNodeScipSymbol(nodeId: string, symbol: ScipSymbolRecord): void {
    this.nodeCache.delete(nodeId);
    this.db.prepare(`
      UPDATE nodes SET
        scip_symbol = @symbol,
        scip_kind = @kind,
        scip_display_name = @displayName,
        scip_signature = @signatureText,
        scip_documentation = @documentation,
        scip_source_indexers = @sourceIndexIds
      WHERE id = @nodeId
    `).run({
      nodeId,
      symbol: symbol.symbol,
      kind: symbol.kind ?? null,
      displayName: symbol.displayName ?? null,
      signatureText: symbol.signatureText ?? null,
      documentation: symbol.documentation ?? null,
      sourceIndexIds: symbol.sourceIndexIds ? JSON.stringify(symbol.sourceIndexIds) : null,
    });
  }

  updateNodeScipSymbols(updates: Array<{ nodeId: string; symbol: ScipSymbolRecord }>): void {
    if (updates.length === 0) return;
    this.db.transaction(() => {
      for (const update of updates) {
        this.updateNodeScipSymbol(update.nodeId, update.symbol);
      }
    })();
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100, offset = 0 } = options;

    // Parse field-qualified bits out of the raw query (kind:, lang:,
    // path:, name:). Anything not recognised stays in `text` and goes
    // to FTS unchanged. Filters compose with the SearchOptions arg —
    // both are applied (intersection-style).
    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    // The text portion drives FTS/LIKE; if all the user typed was
    // filters (`kind:function`), we still need *some* candidate set,
    // so synthesise an empty-text path that returns everything matching
    // the filters.
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    // First try FTS5 with prefix matching
    let results = text
      ? this.searchNodesFTS(text, { kinds, languages, limit, offset })
      // Over-fetch by 5× when running filter-only (no text). The
      // post-scoring path: + name: filters can be very selective, so
      // a smaller multiplier risks returning fewer than `limit`
      // results despite the DB having plenty of matches.
      : this.searchAllByFilters({ kinds, languages, limit: limit * 5 });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && text.length >= 2) {
      results = this.searchNodesLike(text, { kinds, languages, limit, offset });
    }

    // Final fuzzy fallback: scan all known names and keep those within
    // a tight Levenshtein distance. Only fires when both FTS and LIKE
    // returned nothing AND there's a text portion long enough to be
    // worth fuzzing (1-char queries would match too much).
    if (results.length === 0 && text.length >= 3) {
      results = this.searchNodesFuzzy(text, { kinds, languages, limit });
    }

    // Supplement exact names before scoring. BM25 can bury exact names under
    // compound names, and zero-result exact queries still need a candidate.
    if (query) {
      const hadSearchResults = results.length > 0;
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = results.length > 0 ? Math.max(...results.map(r => r.score)) : 1;
      const terms = (text || query).split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
        const params: (string | number)[] = [term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }

      if (!hadSearchResults && terms.length === 1 && terms[0] && terms[0].length >= 4) {
        const term = terms[0];
        const substringResults = this.findNodesByNameSubstring(term, {
          kinds,
          languages,
          limit: Math.min(Math.max(limit, 10), 30),
        });
        for (const result of substringResults) {
          if (existingIds.has(result.node.id)) continue;
          results.push({ node: result.node, score: maxFtsScore * 0.9 });
          existingIds.add(result.node.id);
        }
      }
    }

    // Apply multi-signal scoring
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((a, b) => b.score - a.score);
      // Trim to requested limit after rescoring
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    results = this.fuseSearchResults(results, {
      query,
      text,
      kinds,
      languages,
      pathFilters,
      nameFilters,
      limit,
    });

    // Apply path: + name: filters AFTER scoring. Scoring already uses
    // path/name as a soft signal; the explicit filters here are a hard
    // gate. Done last so the FTS limit fetched plenty of candidates to
    // narrow from.
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n) => nm.includes(n));
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Match-everything path used when the user supplied only field
   * filters (`kind:function lang:typescript`) with no text. Returns
   * candidates ordered by name; the caller's filter pass narrows to
   * what was asked for.
   */
  private searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
  }): SearchResult[] {
    const { kinds, languages, limit } = options;
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: (string | number)[] = [];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' ORDER BY name LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  /**
   * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
   * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
   * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
   * Bounded edit distance keeps each comparison cheap; the per-query
   * scan is O(distinct-name-count) which is far smaller than total
   * node count on any real codebase.
   */
  private searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }
  ): SearchResult[] {
    const { kinds, languages, limit } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    // Pull the distinct name list once. The set is cached on QueryBuilder
    // by getAllNodeNames(); even on a 200k-node project the distinct
    // name set is typically O(10k) because most names repeat. The
    // candidate-cap below bounds memory regardless.
    const allNames = this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    // Cap the per-name follow-up queries. Each survivor triggers a
    // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
    // a project with many similar names (`getUser1`, `getUser2`...)
    // could fan out far beyond `limit` queries before the inner-loop
    // limit kicks in.
    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT * FROM nodes WHERE name = ?';
      const params: (string | number)[] = [c.name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      sql += ' LIMIT 5';
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        // Lower the score for each edit step away from the query so
        // exact-match fallbacks (dist 0) outrank dist-2 typos.
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
    // Escape special FTS5 characters and add prefix wildcard.
    //
    // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
    // so treat it as whitespace before the strip step. Otherwise queries
    // like `stage_apply::run` collapse to `stage_applyrun` (the colons
    // are stripped without splitting) and find nothing. See #173.
    const ftsQuery = query
      .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
      .replace(/['"*():^]/g, '') // Remove FTS5 special chars
      .split(/\s+/)
      .filter(term => term.length > 0)
      // Strip FTS5 boolean operators to prevent query manipulation
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`) // Prefix match each term
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
    // Heavy name weight ensures exact/prefix name matches rank above incidental
    // mentions in long docstrings or qualified names of nested symbols.
    // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
    // nameMatchBonus) can promote results that BM25 alone undervalues.
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? ESCAPE '!' THEN 0.9
          WHEN name LIKE ? ESCAPE '!' THEN 0.8
          WHEN qualified_name LIKE ? ESCAPE '!' THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? ESCAPE '!' OR
        qualified_name LIKE ? ESCAPE '!' OR
        name LIKE ? ESCAPE '!'
      )
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const escapedQuery = escapeSqlLike(query);
    const startsWith = `${escapedQuery}%`;
    const contains = `%${escapedQuery}%`;

    const params: (string | number)[] = [
      exactMatch,     // Exact match score
      startsWith,     // Starts with score
      contains,       // Contains score
      contains,       // Qualified name score
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
    // Pass 1: Find which files contain distinctive (rare) symbols from the query.
    // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

    // Pass 1: Find files containing each queried name, identify distinctive names
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // Pass 2: Query each name with per-name limit, scoring by co-location
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // Sort by score (co-located first), take per-name limit
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // Sort all results by score so co-located results bubble up
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // Source Chunk Projection Operations
  // ===========================================================================

  upsertSourceChunks(chunks: readonly SourceChunkRecord[]): void {
    if (chunks.length === 0) return;
    if (!this.stmts.upsertSourceChunk) {
      this.stmts.upsertSourceChunk = this.db.prepare(`
        INSERT INTO source_chunks (
          id, node_id, file_path, language, symbol_kind, start_line, end_line,
          content_hash, source_hash, chunk_ordinal, indexer_version, content,
          code_token_text, metadata, diagnostics, updated_at
        ) VALUES (
          @id, @nodeId, @filePath, @language, @symbolKind, @startLine, @endLine,
          @contentHash, @sourceHash, @chunkOrdinal, @indexerVersion, @content,
          @codeTokenText, @metadata, @diagnostics, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          node_id = excluded.node_id,
          file_path = excluded.file_path,
          language = excluded.language,
          symbol_kind = excluded.symbol_kind,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          content_hash = excluded.content_hash,
          source_hash = excluded.source_hash,
          chunk_ordinal = excluded.chunk_ordinal,
          indexer_version = excluded.indexer_version,
          content = excluded.content,
          code_token_text = excluded.code_token_text,
          metadata = excluded.metadata,
          diagnostics = excluded.diagnostics,
          updated_at = excluded.updated_at
      `);
    }
    const stmt = this.stmts.upsertSourceChunk;
    this.db.transaction(() => {
      for (const chunk of chunks) {
        stmt.run({
          id: chunk.id,
          nodeId: chunk.nodeId,
          filePath: chunk.filePath,
          language: chunk.language,
          symbolKind: chunk.symbolKind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentHash: chunk.contentHash,
          sourceHash: chunk.sourceHash,
          chunkOrdinal: chunk.chunkOrdinal,
          indexerVersion: chunk.indexerVersion,
          content: chunk.content,
          codeTokenText: chunk.codeTokenText,
          metadata: chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          diagnostics: chunk.diagnostics ? JSON.stringify(chunk.diagnostics) : null,
          updatedAt: chunk.updatedAt,
        });
      }
    })();
    this.countStatement('source_chunks.write', chunks.length);
  }

  deleteSourceChunksByFile(filePath: string): number {
    if (!this.stmts.deleteSourceChunksByFile) {
      this.stmts.deleteSourceChunksByFile = this.db.prepare('DELETE FROM source_chunks WHERE file_path = ?');
    }
    const result = this.stmts.deleteSourceChunksByFile.run(filePath);
    this.countStatement('source_chunks.delete');
    return result.changes;
  }

  getSourceChunksByFile(filePath: string): SourceChunkRecord[] {
    if (!this.stmts.getSourceChunksByFile) {
      this.stmts.getSourceChunksByFile = this.db.prepare(`
        SELECT * FROM source_chunks
        WHERE file_path = ?
        ORDER BY start_line, chunk_ordinal, id
      `);
    }
    const rows = this.stmts.getSourceChunksByFile.all(filePath) as SourceChunkRow[];
    this.countStatement('source_chunks.read');
    return rows.map(rowToSourceChunk);
  }

  searchSourceChunks(query: string, options: SourceChunkSearchOptions = {}): SourceChunkSearchResult[] {
    const ftsQuery = buildSourceChunkFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.floor(options.limit ?? 50));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    let sql = `
      SELECT source_chunks.*, bm25(source_chunks_fts, 0, 0, 1, 1, 2, 8, 12) AS score
      FROM source_chunks_fts
      JOIN source_chunks ON source_chunks_fts.rowid = source_chunks.rowid
      WHERE source_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];
    if (options.languages && options.languages.length > 0) {
      sql += ` AND source_chunks.language IN (${options.languages.map(() => '?').join(',')})`;
      params.push(...options.languages);
    }
    if (options.filePaths && options.filePaths.length > 0) {
      sql += ` AND source_chunks.file_path IN (${options.filePaths.map(() => '?').join(',')})`;
      params.push(...options.filePaths);
    }
    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as Array<SourceChunkRow & { score: number }>;
    this.countStatement('source_chunks.search');
    return rows.map((row) => ({
      chunk: rowToSourceChunk(row),
      score: Math.abs(row.score),
    }));
  }

  getSourceChunkDiagnostics(): SourceChunkDiagnostics {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM source_chunks) AS chunk_count,
        (SELECT COUNT(*) FROM source_chunks_fts) AS fts_row_count,
        (SELECT COUNT(*) FROM source_chunks_fts
          WHERE rowid NOT IN (SELECT rowid FROM source_chunks)) AS orphan_fts_row_count
    `).get() as { chunk_count: number; fts_row_count: number; orphan_fts_row_count: number };
    return {
      chunkCount: row.chunk_count,
      ftsRowCount: row.fts_row_count,
      orphanFtsRowCount: row.orphan_fts_row_count,
    };
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
    this.countStatement('edges.write');
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    this.countStatement('edges.read');
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    this.countStatement('edges.read');
    return rows.map(rowToEdge);
  }

  getEdgesByProvenance(provenance: NonNullable<Edge['provenance']>): Edge[] {
    if (!this.stmts.getEdgesByProvenance) {
      this.stmts.getEdgesByProvenance = this.db.prepare('SELECT * FROM edges WHERE provenance = ?');
    }
    const rows = this.stmts.getEdgesByProvenance.all(provenance) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getAllEdges(): Edge[] {
    const rows = this.db.prepare(`
      SELECT * FROM edges
      ORDER BY source, target, kind, ifnull(line,-1), ifnull(col,-1), ifnull(provenance,''), ifnull(metadata,'')
    `).all() as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getGraphRevision(): {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly maxNodeUpdatedAt: number;
    readonly maxEdgeId: number;
  } {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT IFNULL(MAX(updated_at), 0) FROM nodes) AS max_node_updated_at,
        (SELECT IFNULL(MAX(id), 0) FROM edges) AS max_edge_id
    `).get() as {
      node_count: number;
      edge_count: number;
      max_node_updated_at: number;
      max_edge_id: number;
    };
    return {
      nodeCount: row.node_count,
      edgeCount: row.edge_count,
      maxNodeUpdatedAt: row.max_node_updated_at,
      maxEdgeId: row.max_edge_id,
    };
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  insertHyperedge(hyperedge: Hyperedge, members: HyperedgeMember[]): void {
    this.db.transaction(() => {
      this.insertHyperedgeRows(hyperedge, members);
    })();
  }

  insertHyperedgeRelations(relations: HyperedgeRelation[]): void {
    if (relations.length === 0) return;

    this.db.transaction(() => {
      for (const relation of relations) {
        this.insertHyperedgeRows(relation.hyperedge, relation.members);
      }
    })();
  }

  getHyperedgeById(id: string): HyperedgeRelation | null {
    if (!this.stmts.getHyperedgeById) {
      this.stmts.getHyperedgeById = this.db.prepare('SELECT * FROM hyperedges WHERE id = ?');
    }
    const row = this.stmts.getHyperedgeById.get(id) as HyperedgeRow | undefined;
    if (!row) return null;
    return this.buildHyperedgeRelation(row);
  }

  getHyperedgesByNode(nodeId: string): HyperedgeRelation[] {
    if (!this.stmts.getHyperedgeIdsByNode) {
      this.stmts.getHyperedgeIdsByNode = this.db.prepare(
        'SELECT hyperedge_id AS id FROM hyperedge_members WHERE node_id = ? ORDER BY hyperedge_id'
      );
    }
    const rows = this.stmts.getHyperedgeIdsByNode.all(nodeId) as Array<{ id: string }>;
    return this.getHyperedgeRelationsByIds(rows.map((row) => row.id));
  }

  getAllHyperedgeRelations(): HyperedgeRelation[] {
    const rows = this.db.prepare('SELECT * FROM hyperedges ORDER BY id').all() as HyperedgeRow[];
    return rows.map((row) => this.buildHyperedgeRelation(row));
  }

  getHyperedgesByNodes(nodeIds: string[], kinds?: HyperedgeKind[]): HyperedgeRelation[] {
    if (nodeIds.length < 2) return [];

    const uniqueNodeIds = Array.from(new Set(nodeIds));
    const nodePlaceholders = uniqueNodeIds.map(() => '?').join(',');
    const params: string[] = [...uniqueNodeIds];
    let sql = `
      SELECT h.id
      FROM hyperedges h
      JOIN hyperedge_members m ON m.hyperedge_id = h.id
      WHERE m.node_id IN (${nodePlaceholders})
    `;

    if (kinds && kinds.length > 0) {
      sql += ` AND h.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    sql += ' GROUP BY h.id HAVING COUNT(DISTINCT m.node_id) >= 2 ORDER BY h.id';
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>;
    return this.getHyperedgeRelationsByIds(rows.map((row) => row.id));
  }

  findHyperedgesBetweenNodes(nodeIds: string[], kinds?: HyperedgeKind[]): HyperedgeRelation[] {
    return this.getHyperedgesByNodes(nodeIds, kinds);
  }

  deleteHyperedgesForFile(filePath: string): number {
    const rows = this.db.prepare(`
      SELECT DISTINCT h.id
      FROM hyperedges h
      LEFT JOIN hyperedge_members m ON m.hyperedge_id = h.id
      LEFT JOIN nodes n ON n.id = m.node_id
      WHERE h.source_file = ? OR n.file_path = ?
      ORDER BY h.id
    `).all(filePath, filePath) as Array<{ id: string }>;
    return this.deleteHyperedgesByIds(rows.map((row) => row.id));
  }

  deleteHyperedgesByKind(kind: HyperedgeKind): number {
    if (!this.stmts.deleteHyperedgesByKind) {
      this.stmts.deleteHyperedgesByKind = this.db.prepare('SELECT id FROM hyperedges WHERE kind = ? ORDER BY id');
    }
    const rows = this.stmts.deleteHyperedgesByKind.all(kind) as Array<{ id: string }>;
    return this.deleteHyperedgesByIds(rows.map((row) => row.id));
  }

  deleteHyperedgesByProvenance(provenance: HyperedgeProvenance): number {
    if (!this.stmts.deleteHyperedgesByProvenance) {
      this.stmts.deleteHyperedgesByProvenance = this.db.prepare(
        'SELECT id FROM hyperedges WHERE provenance = ? ORDER BY id'
      );
    }
    const rows = this.stmts.deleteHyperedgesByProvenance.all(provenance) as Array<{ id: string }>;
    return this.deleteHyperedgesByIds(rows.map((row) => row.id));
  }

  deleteOrphanHyperedges(): number {
    if (!this.stmts.deleteOrphanHyperedges) {
      this.stmts.deleteOrphanHyperedges = this.db.prepare(`
        SELECT h.id
        FROM hyperedges h
        WHERE NOT EXISTS (
          SELECT 1 FROM hyperedge_members m WHERE m.hyperedge_id = h.id
        )
        ORDER BY h.id
      `);
    }
    const rows = this.stmts.deleteOrphanHyperedges.all() as Array<{ id: string }>;
    return this.deleteHyperedgesByIds(rows.map((row) => row.id));
  }

  replaceCapabilityAnalysisForFile(
    filePath: string,
    run: CapabilityAnalysisRun,
    assertions: readonly CapabilityAssertion[]
  ): void {
    this.db.transaction(() => {
      this.deleteCapabilityAnalysisForFile(filePath, run.producerId);
      this.upsertCapabilityAnalysisRun(run);
      for (const assertion of assertions) {
        this.insertCapabilityAssertion(assertion);
      }
    })();
  }

  deleteCapabilityAnalysisForFile(filePath: string, producerId?: string): void {
    if (!this.tableExists('capability_assertions')) return;
    if (producerId) {
      this.db.prepare('DELETE FROM capability_assertions WHERE file_path = ? AND producer_id = ?').run(filePath, producerId);
      this.db.prepare('DELETE FROM capability_analysis_runs WHERE file_path = ? AND producer_id = ?').run(filePath, producerId);
      return;
    }
    if (!this.stmts.deleteCapabilityAssertionsByFile) {
      this.stmts.deleteCapabilityAssertionsByFile = this.db.prepare('DELETE FROM capability_assertions WHERE file_path = ?');
    }
    if (!this.stmts.deleteCapabilityRunsByFile) {
      this.stmts.deleteCapabilityRunsByFile = this.db.prepare('DELETE FROM capability_analysis_runs WHERE file_path = ?');
    }
    this.stmts.deleteCapabilityAssertionsByFile.run(filePath);
    this.stmts.deleteCapabilityRunsByFile.run(filePath);
  }

  capabilityAnalysisRunIsCurrent(
    filePath: string,
    producerId: string,
    producerVersion: string,
    sourceHash: string
  ): boolean {
    const run = this.getCapabilityAnalysisRuns([filePath]).find((entry) => entry.producerId === producerId);
    return run?.producerVersion === producerVersion && run.sourceHash === sourceHash && run.status !== 'failed';
  }

  getCapabilityAssertionsByNodeIds(nodeIds: readonly string[]): CapabilityAssertion[] {
    if (nodeIds.length === 0 || !this.tableExists('capability_assertions')) return [];
    const idsJson = JSON.stringify(Array.from(new Set(nodeIds)));
    const rows = this.db.prepare(`
      SELECT * FROM capability_assertions
      WHERE subject_node_id IN (SELECT value FROM json_each(?))
      ORDER BY subject_node_id, resource_kind, resource_key, operation, start_line, start_column, id
    `).all(idsJson) as CapabilityAssertionRow[];
    return rows.map(rowToCapabilityAssertion);
  }

  getCapabilityAssertionsByFile(filePath: string): CapabilityAssertion[] {
    if (!this.tableExists('capability_assertions')) return [];
    const rows = this.db.prepare(`
      SELECT * FROM capability_assertions
      WHERE file_path = ?
      ORDER BY subject_node_id, resource_kind, resource_key, operation, start_line, start_column, id
    `).all(filePath) as CapabilityAssertionRow[];
    return rows.map(rowToCapabilityAssertion);
  }

  getCapabilityAnalysisRuns(filePaths?: readonly string[]): CapabilityAnalysisRun[] {
    if (!this.tableExists('capability_analysis_runs')) return [];
    if (filePaths && filePaths.length === 0) return [];
    if (filePaths) {
      const pathsJson = JSON.stringify(Array.from(new Set(filePaths)));
      const rows = this.db.prepare(`
        SELECT * FROM capability_analysis_runs
        WHERE file_path IN (SELECT value FROM json_each(?))
        ORDER BY file_path, producer_id
      `).all(pathsJson) as CapabilityAnalysisRunRow[];
      return rows.map(rowToCapabilityAnalysisRun);
    }
    const rows = this.db.prepare('SELECT * FROM capability_analysis_runs ORDER BY file_path, producer_id').all() as CapabilityAnalysisRunRow[];
    return rows.map(rowToCapabilityAnalysisRun);
  }

  getCapabilityStats(): { assertionCount: number; runCount: number } {
    if (!this.tableExists('capability_assertions')) return { assertionCount: 0, runCount: 0 };
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM capability_assertions) AS assertion_count,
        (SELECT COUNT(*) FROM capability_analysis_runs) AS run_count
    `).get() as { assertion_count: number; run_count: number };
    return { assertionCount: row.assertion_count, runCount: row.run_count };
  }

  private insertCapabilityAssertion(assertion: CapabilityAssertion): void {
    if (!this.stmts.insertCapabilityAssertion) {
      this.stmts.insertCapabilityAssertion = this.db.prepare(`
        INSERT OR REPLACE INTO capability_assertions (
          id, subject_node_id, operation, resource_kind, resource_key, target_node_id,
          scope, file_path, start_line, start_column, end_line, end_column,
          origin, certainty, producer_id, rule_id, producer_version,
          supporting_hyperedge_id, metadata, updated_at
        ) VALUES (
          @id, @subjectNodeId, @operation, @resourceKind, @resourceKey, @targetNodeId,
          @scope, @filePath, @startLine, @startColumn, @endLine, @endColumn,
          @origin, @certainty, @producerId, @ruleId, @producerVersion,
          @supportingHyperedgeId, @metadata, @updatedAt
        )
      `);
    }
    this.stmts.insertCapabilityAssertion.run({
      id: assertion.id,
      subjectNodeId: assertion.subjectNodeId,
      operation: assertion.operation,
      resourceKind: assertion.resourceKind,
      resourceKey: assertion.resourceKey,
      targetNodeId: assertion.targetNodeId ?? null,
      scope: assertion.scope,
      filePath: assertion.filePath,
      startLine: assertion.startLine,
      startColumn: assertion.startColumn,
      endLine: assertion.endLine,
      endColumn: assertion.endColumn,
      origin: assertion.origin,
      certainty: assertion.certainty,
      producerId: assertion.producerId,
      ruleId: assertion.ruleId,
      producerVersion: assertion.producerVersion,
      supportingHyperedgeId: assertion.supportingHyperedgeId ?? null,
      metadata: assertion.metadata ? JSON.stringify(assertion.metadata) : null,
      updatedAt: Date.now(),
    });
  }

  private upsertCapabilityAnalysisRun(run: CapabilityAnalysisRun): void {
    if (!this.stmts.upsertCapabilityAnalysisRun) {
      this.stmts.upsertCapabilityAnalysisRun = this.db.prepare(`
        INSERT INTO capability_analysis_runs (
          file_path, producer_id, producer_version, source_hash, status, diagnostics, updated_at
        ) VALUES (
          @filePath, @producerId, @producerVersion, @sourceHash, @status, @diagnostics, @updatedAt
        )
        ON CONFLICT(file_path, producer_id) DO UPDATE SET
          producer_version = excluded.producer_version,
          source_hash = excluded.source_hash,
          status = excluded.status,
          diagnostics = excluded.diagnostics,
          updated_at = excluded.updated_at
      `);
    }
    this.stmts.upsertCapabilityAnalysisRun.run({
      filePath: run.filePath,
      producerId: run.producerId,
      producerVersion: run.producerVersion,
      sourceHash: run.sourceHash,
      status: run.status,
      diagnostics: run.diagnostics ?? null,
      updatedAt: run.updatedAt,
    });
  }

  private insertHyperedgeRows(hyperedge: Hyperedge, members: readonly HyperedgeMember[]): void {
    if (!this.stmts.insertHyperedge) {
      this.stmts.insertHyperedge = this.db.prepare(`
        INSERT INTO hyperedges (
          id, kind, source_file, line, col, provenance, confidence, metadata, created_at, updated_at
        ) VALUES (
          @id, @kind, @sourceFile, @line, @col, @provenance, @confidence, @metadata, @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          source_file = excluded.source_file,
          line = excluded.line,
          col = excluded.col,
          provenance = excluded.provenance,
          confidence = excluded.confidence,
          metadata = excluded.metadata,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
    }
    if (!this.stmts.deleteHyperedgeMembers) {
      this.stmts.deleteHyperedgeMembers = this.db.prepare(
        'DELETE FROM hyperedge_members WHERE hyperedge_id = ?'
      );
    }
    if (!this.stmts.insertHyperedgeMember) {
      this.stmts.insertHyperedgeMember = this.db.prepare(`
        INSERT INTO hyperedge_members (hyperedge_id, node_id, role, ordinal, metadata)
        VALUES (@hyperedgeId, @nodeId, @role, @ordinal, @metadata)
      `);
    }

    this.stmts.insertHyperedge.run({
      id: hyperedge.id,
      kind: hyperedge.kind,
      sourceFile: hyperedge.sourceFile ?? null,
      line: hyperedge.line ?? null,
      col: hyperedge.column ?? null,
      provenance: hyperedge.provenance ?? null,
      confidence: hyperedge.confidence ?? null,
      metadata: hyperedge.metadata ? JSON.stringify(hyperedge.metadata) : null,
      createdAt: hyperedge.createdAt,
      updatedAt: hyperedge.updatedAt,
    });
    this.stmts.deleteHyperedgeMembers.run(hyperedge.id);
    for (const member of members) {
      this.stmts.insertHyperedgeMember.run({
        hyperedgeId: hyperedge.id,
        nodeId: member.nodeId,
        role: member.role,
        ordinal: member.ordinal,
        metadata: member.metadata ? JSON.stringify(member.metadata) : null,
      });
    }
  }

  private buildHyperedgeRelation(row: HyperedgeRow): HyperedgeRelation {
    if (!this.stmts.getHyperedgeMembersById) {
      this.stmts.getHyperedgeMembersById = this.db.prepare(`
        SELECT m.hyperedge_id, m.node_id, m.role, m.ordinal, m.metadata,
          n.*
        FROM hyperedge_members m
        JOIN nodes n ON n.id = m.node_id
        WHERE m.hyperedge_id = ?
        ORDER BY m.ordinal, m.role, m.node_id
      `);
    }
    const memberRows = this.stmts.getHyperedgeMembersById.all(row.id) as HyperedgeMemberWithNodeRow[];
    return {
      hyperedge: rowToHyperedge(row),
      members: memberRows.map((memberRow) => ({
        ...rowToHyperedgeMember(memberRow),
        node: rowToNode(memberRow),
      })),
    };
  }

  private getHyperedgeRelationsByIds(ids: readonly string[]): HyperedgeRelation[] {
    const relations: HyperedgeRelation[] = [];
    for (const id of ids) {
      const relation = this.getHyperedgeById(id);
      if (relation) relations.push(relation);
    }
    return relations;
  }

  private deleteHyperedgesByIds(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM hyperedge_members WHERE hyperedge_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM hyperedges WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
    this.countStatement('files.write');
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string, options: { deleteScipFacts?: boolean } = {}): void {
    this.db.transaction(() => {
      this.deleteCapabilityAnalysisForFile(filePath);
      this.deleteHyperedgesForFile(filePath);
      this.deleteSourceChunksByFile(filePath);
      if (options.deleteScipFacts) {
        this.deleteScipFactsForFile(filePath);
      }
      this.deleteNodesByFile(filePath, { preserveScipFields: !options.deleteScipFacts });
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
      this.countStatement('files.delete');
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    this.countStatement('files.read');
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: encodeUnresolvedCandidates(ref),
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
    this.countStatement('unresolved.write');
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insertUnresolvedRef(ref);
      }
    });
    insert();
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map(rowToUnresolvedReference);
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    this.countStatement('unresolved.read');
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs ORDER BY id LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    this.countStatement('unresolved.read');
    return rows.map(rowToUnresolvedReference);
  }

  getUnresolvedReferencesAfterId(afterId: number, limit: number): UnresolvedReference[] {
    const rows = this.db.prepare(
      'SELECT * FROM unresolved_refs WHERE id > ? ORDER BY id LIMIT ?'
    ).all(afterId, limit) as UnresolvedRefRow[];
    this.countStatement('unresolved.read');
    return rows.map(rowToUnresolvedReference);
  }

  deleteUnresolvedReferencesByIds(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const idsJson = JSON.stringify(ids);
    this.db.prepare(`
      DELETE FROM unresolved_refs
      WHERE id IN (SELECT value FROM json_each(?))
    `).run(idsJson);
    this.countStatement('unresolved.delete');
  }

  hasRootQualifiedFilePath(): boolean {
    if (!this.stmts.hasRootQualifiedFilePath) {
      this.stmts.hasRootQualifiedFilePath = this.db.prepare(
        "SELECT 1 FROM files WHERE path LIKE '@%/%' ESCAPE '\\' LIMIT 1"
      );
    }
    return this.stmts.hasRootQualifiedFilePath.get() !== undefined;
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  getFileLanguageCounts(): Array<{ language: Language; count: number }> {
    if (!this.stmts.getFileLanguageCounts) {
      this.stmts.getFileLanguageCounts = this.db.prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language');
    }
    return this.stmts.getFileLanguageCounts.all() as Array<{ language: Language; count: number }>;
  }

  getFilePathsByLanguage(language: Language): string[] {
    if (!this.stmts.getFilePathsByLanguage) {
      this.stmts.getFilePathsByLanguage = this.db.prepare('SELECT path FROM files WHERE language = ? ORDER BY path');
    }
    const rows = this.stmts.getFilePathsByLanguage.all(language) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    const placeholders = filePaths.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`)
      .all(...filePaths) as UnresolvedRefRow[];

    return rows.map(rowToUnresolvedReference);
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  insertScipIndex(record: ScipIndexRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scip_indexes (
        id, project_root, tool_name, tool_version, arguments, text_document_encoding, created_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.projectRoot,
      record.toolName ?? null,
      record.toolVersion ?? null,
      record.arguments ? JSON.stringify(record.arguments) : null,
      record.textDocumentEncoding ?? null,
      record.createdAt,
      record.metadata ? JSON.stringify(record.metadata) : null
    );
  }

  deleteScipIndexesBySource(sourceKey: string, inTransaction = false): void {
    const rows = this.db.prepare(`
      SELECT id FROM scip_indexes
      WHERE json_extract(metadata, '$.sourceKey') = ?
    `).all(sourceKey) as Array<{ id: string }>;
    for (const row of rows) {
      this.deleteScipIndex(row.id, inTransaction);
    }
  }

  deleteScipIndex(indexId: string, inTransaction = false): void {
    const symbolRows = (this.db.prepare(
      `SELECT symbol, source_index_ids FROM scip_symbols
       WHERE EXISTS (
         SELECT 1 FROM json_each(coalesce(source_index_ids, '[]')) WHERE value = ?
       )`
    ).all(indexId) as Array<{ symbol: string; source_index_ids: string | null }>);
    const symbolsToDelete = new Set<string>();
    const symbolsToUpdate: Array<{ symbol: string; sourceIndexIds: string[] }> = [];
    for (const row of symbolRows) {
      const sourceIndexIds = safeJsonParse<string[]>(row.source_index_ids ?? '', []).filter((id) => id !== indexId);
      if (sourceIndexIds.length > 0) {
        symbolsToUpdate.push({ symbol: row.symbol, sourceIndexIds });
      } else {
        symbolsToDelete.add(row.symbol);
      }
    }
    const symbolsToDeleteJson = JSON.stringify(Array.from(symbolsToDelete));
    const relationshipRows = this.db.prepare(`
      SELECT * FROM scip_relationships
      WHERE source_symbol IN (SELECT value FROM json_each(?))
        OR target_symbol IN (SELECT value FROM json_each(?))
        OR EXISTS (
          SELECT 1 FROM json_each(coalesce(json_extract(scip_relationships.metadata, '$.sourceIndexIds'), '[]')) WHERE value = ?
        )
        OR json_extract(metadata, '$.sourceIndexId') = ?
    `).all(symbolsToDeleteJson, symbolsToDeleteJson, indexId, indexId) as ScipRelationshipRow[];
    const relationshipsToDelete: string[] = [];
    const relationshipsToUpdate: Array<{ id: string; metadata: Record<string, unknown> | undefined }> = [];
    for (const row of relationshipRows) {
      if (symbolsToDelete.has(row.source_symbol) || symbolsToDelete.has(row.target_symbol)) {
        relationshipsToDelete.push(row.id);
        continue;
      }
      const metadata = row.metadata ? safeJsonParse<Record<string, unknown> | undefined>(row.metadata, undefined) : undefined;
      const sourceIndexIds = scipRelationshipSourceIndexIds(metadata);
      if (!sourceIndexIds.includes(indexId)) continue;
      const remainingSourceIndexIds = sourceIndexIds.filter((id) => id !== indexId);
      if (remainingSourceIndexIds.length > 0) {
        relationshipsToUpdate.push({ id: row.id, metadata: withScipRelationshipSourceIndexIds(metadata, remainingSourceIndexIds) });
      } else {
        relationshipsToDelete.push(row.id);
      }
    }

    const deleteRows = () => {
      const deletedRelationshipsJson = JSON.stringify(relationshipsToDelete);
      this.db.prepare(`
        DELETE FROM edges
        WHERE provenance = 'scip'
          AND json_extract(metadata, '$.scipRelationship') IN (SELECT value FROM json_each(?))
      `).run(deletedRelationshipsJson);
      if (relationshipsToDelete.length > 0) {
        this.db.prepare(`
          DELETE FROM scip_relationships WHERE id IN (SELECT value FROM json_each(?))
        `).run(deletedRelationshipsJson);
      }
      for (const relationship of relationshipsToUpdate) {
        this.db.prepare('UPDATE scip_relationships SET metadata = ? WHERE id = ?').run(
          relationship.metadata ? JSON.stringify(relationship.metadata) : null,
          relationship.id
        );
      }
      const symbolsToDeleteJson = JSON.stringify(Array.from(symbolsToDelete));
      if (symbolsToDelete.size > 0) {
        this.db.prepare(`
          DELETE FROM scip_symbols WHERE symbol IN (SELECT value FROM json_each(?))
        `).run(symbolsToDeleteJson);
        this.db.prepare(`
          UPDATE nodes SET
            scip_symbol = NULL,
            scip_kind = NULL,
            scip_display_name = NULL,
            scip_signature = NULL,
            scip_documentation = NULL,
            scip_source_indexers = NULL
          WHERE scip_symbol IN (SELECT value FROM json_each(?))
        `).run(symbolsToDeleteJson);
      }
      for (const symbol of symbolsToUpdate) {
        this.db.prepare('UPDATE scip_symbols SET source_index_ids = ? WHERE symbol = ?').run(JSON.stringify(symbol.sourceIndexIds), symbol.symbol);
        this.db.prepare('UPDATE nodes SET scip_source_indexers = ? WHERE scip_symbol = ?').run(JSON.stringify(symbol.sourceIndexIds), symbol.symbol);
      }

      this.db.prepare(`
        DELETE FROM scip_occurrences
        WHERE document_id IN (SELECT id FROM scip_documents WHERE index_id = ?)
      `).run(indexId);
      this.db.prepare('DELETE FROM scip_documents WHERE index_id = ?').run(indexId);
      this.db.prepare('DELETE FROM scip_indexes WHERE id = ?').run(indexId);
    };
    if (inTransaction) {
      deleteRows();
    } else {
      this.db.transaction(deleteRows)();
    }
    this.nodeCache.clear();
    this.preservedScipFieldsByNodeId.clear();
  }

  insertScipDocument(record: ScipDocumentRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scip_documents (
        id, index_id, relative_path, repo_relative_path, language, position_encoding, text_sha256, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.indexId,
      record.relativePath,
      record.repoRelativePath,
      record.language,
      record.positionEncoding ?? null,
      record.textSha256 ?? null,
      record.metadata ? JSON.stringify(record.metadata) : null
    );
  }

  upsertScipSymbol(record: ScipSymbolRecord): void {
    const existing = this.getScipSymbol(record.symbol);
    const sourceIndexIds = Array.from(new Set([
      ...(existing?.sourceIndexIds ?? []),
      ...(record.sourceIndexIds ?? []),
    ]));
    this.db.prepare(`
      INSERT INTO scip_symbols (
        symbol, scheme, package_manager, package_name, package_version, display_name, kind,
        enclosing_symbol, documentation, signature_language, signature_text, source_index_ids, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        scheme = coalesce(excluded.scheme, scip_symbols.scheme),
        package_manager = coalesce(excluded.package_manager, scip_symbols.package_manager),
        package_name = coalesce(excluded.package_name, scip_symbols.package_name),
        package_version = coalesce(excluded.package_version, scip_symbols.package_version),
        display_name = coalesce(excluded.display_name, scip_symbols.display_name),
        kind = coalesce(excluded.kind, scip_symbols.kind),
        enclosing_symbol = coalesce(excluded.enclosing_symbol, scip_symbols.enclosing_symbol),
        documentation = coalesce(excluded.documentation, scip_symbols.documentation),
        signature_language = coalesce(excluded.signature_language, scip_symbols.signature_language),
        signature_text = coalesce(excluded.signature_text, scip_symbols.signature_text),
        source_index_ids = excluded.source_index_ids,
        metadata = coalesce(excluded.metadata, scip_symbols.metadata)
    `).run(
      record.symbol,
      record.scheme ?? null,
      record.packageManager ?? null,
      record.packageName ?? null,
      record.packageVersion ?? null,
      record.displayName ?? null,
      record.kind ?? null,
      record.enclosingSymbol ?? null,
      record.documentation ?? null,
      record.signatureLanguage ?? null,
      record.signatureText ?? null,
      sourceIndexIds.length > 0 ? JSON.stringify(sourceIndexIds) : null,
      record.metadata ? JSON.stringify(record.metadata) : null
    );
  }

  insertScipOccurrence(record: ScipOccurrenceRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scip_occurrences (
        id, document_id, symbol, start_line, start_character, end_line, end_character, symbol_roles,
        syntax_kind, enclosing_start_line, enclosing_start_character, enclosing_end_line,
        enclosing_end_character, override_documentation, diagnostics
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.documentId,
      record.symbol ?? null,
      record.startLine,
      record.startCharacter,
      record.endLine,
      record.endCharacter,
      record.symbolRoles ?? null,
      record.syntaxKind ?? null,
      record.enclosingStartLine ?? null,
      record.enclosingStartCharacter ?? null,
      record.enclosingEndLine ?? null,
      record.enclosingEndCharacter ?? null,
      record.overrideDocumentation ? JSON.stringify(record.overrideDocumentation) : null,
      record.diagnostics ? JSON.stringify(record.diagnostics) : null
    );
  }

  insertScipRelationship(record: ScipRelationshipRecord): void {
    const existing = this.db.prepare('SELECT * FROM scip_relationships WHERE id = ?').get(record.id) as ScipRelationshipRow | undefined;
    const existingMetadata = existing?.metadata
      ? safeJsonParse<Record<string, unknown> | undefined>(existing.metadata, undefined)
      : undefined;
    const mergedMetadata = { ...(existingMetadata ?? {}), ...(record.metadata ?? {}) };
    const sourceIndexIds = Array.from(new Set([
      ...scipRelationshipSourceIndexIds(existingMetadata),
      ...scipRelationshipSourceIndexIds(record.metadata),
    ]));
    const metadata = withScipRelationshipSourceIndexIds(
      Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      sourceIndexIds
    );
    this.db.prepare(`
      INSERT OR REPLACE INTO scip_relationships (
        id, source_symbol, target_symbol, is_reference, is_implementation, is_type_definition, is_definition, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sourceSymbol,
      record.targetSymbol,
      record.isReference ? 1 : 0,
      record.isImplementation ? 1 : 0,
      record.isTypeDefinition ? 1 : 0,
      record.isDefinition ? 1 : 0,
      metadata ? JSON.stringify(metadata) : null
    );
  }

  getScipSymbol(symbol: string): ScipSymbolRecord | undefined {
    const row = this.db.prepare('SELECT * FROM scip_symbols WHERE symbol = ?').get(symbol) as ScipSymbolRow | undefined;
    return row ? rowToScipSymbol(row) : undefined;
  }

  getScipSymbols(symbols: readonly string[]): ScipSymbolRecord[] {
    if (symbols.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM scip_symbols
      WHERE symbol IN (SELECT value FROM json_each(?))
      ORDER BY symbol
    `).all(JSON.stringify(Array.from(new Set(symbols)))) as ScipSymbolRow[];
    return rows.map(rowToScipSymbol);
  }

  getScipSymbolForNode(nodeId: string): ScipSymbolRecord | undefined {
    const node = this.getNodeById(nodeId);
    return node?.scipSymbol ? this.getScipSymbol(node.scipSymbol) : undefined;
  }

  searchScipSymbols(query: string, limit?: number): ScipSymbolRecord[] {
    const boundedLimit = finitePositiveLimit(limit);
    const sql = `
      SELECT * FROM scip_symbols
      WHERE symbol LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
      ORDER BY display_name, symbol
      ${boundedLimit ? 'LIMIT ?' : ''}
    `;
    const pattern = `%${escapeSqlLike(query)}%`;
    const params = boundedLimit ? [pattern, pattern, boundedLimit] : [pattern, pattern];
    const rows = this.db.prepare(sql).all(...params) as ScipSymbolRow[];
    return rows.map(rowToScipSymbol);
  }

  getScipOccurrences(symbol: string): ScipOccurrenceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scip_occurrences WHERE symbol = ? ORDER BY document_id, start_line, start_character
    `).all(symbol) as ScipOccurrenceRow[];
    return rows.map(rowToScipOccurrence);
  }

  getScipOccurrencesForNode(nodeId: string): Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }> {
    const symbol = this.getNodeById(nodeId)?.scipSymbol;
    if (!symbol) return [];
    return this.getScipOccurrencesWithDocuments(symbol);
  }

  getScipOccurrencesWithDocuments(
    symbol: string,
    limit?: number,
    role?: 'definition' | 'reference'
  ): Array<ScipOccurrenceRecord & { document: ScipDocumentRecord }> {
    const boundedLimit = finitePositiveLimit(limit);
    const roleWhere = role === 'definition'
      ? 'AND ((coalesce(o.symbol_roles, 0) & 1) = 1)'
      : role === 'reference'
        ? 'AND ((coalesce(o.symbol_roles, 0) & 1) != 1)'
        : '';
    const rows = this.db.prepare(`
      SELECT o.*, d.id AS d_id, d.index_id, d.relative_path, d.repo_relative_path, d.language,
        d.position_encoding, d.text_sha256, d.metadata AS d_metadata
      FROM scip_occurrences o
      JOIN scip_documents d ON d.id = o.document_id
      WHERE o.symbol = ?
      ${roleWhere}
      ORDER BY d.repo_relative_path, o.start_line, o.start_character
      ${boundedLimit ? 'LIMIT ?' : ''}
    `).all(...(boundedLimit ? [symbol, boundedLimit] : [symbol])) as Array<ScipOccurrenceRow & {
      d_id: string;
      index_id: string;
      relative_path: string;
      repo_relative_path: string;
      language: string;
      position_encoding: string | null;
      text_sha256: string | null;
      d_metadata: string | null;
    }>;
    return rows.map((row) => ({
      ...rowToScipOccurrence(row),
      document: rowToScipDocument({
        id: row.d_id,
        index_id: row.index_id,
        relative_path: row.relative_path,
        repo_relative_path: row.repo_relative_path,
        language: row.language,
        position_encoding: row.position_encoding,
        text_sha256: row.text_sha256,
        metadata: row.d_metadata,
      }),
    }));
  }

  deleteScipFactsForFile(filePath: string): void {
    const documents = this.db.prepare(`
      SELECT id FROM scip_documents WHERE repo_relative_path = ?
    `).all(filePath) as Array<{ id: string }>;
    if (documents.length === 0) return;

    const documentIds = documents.map((document) => document.id);
    const documentPlaceholders = documentIds.map(() => '?').join(',');
    const symbolRows = this.db.prepare(`
      SELECT DISTINCT symbol FROM scip_occurrences
      WHERE document_id IN (${documentPlaceholders}) AND symbol IS NOT NULL
    `).all(...documentIds) as Array<{ symbol: string }>;
    const touchedSymbols = symbolRows.map((row) => row.symbol);

    this.db.prepare(`
      DELETE FROM scip_occurrences WHERE document_id IN (${documentPlaceholders})
    `).run(...documentIds);
    this.db.prepare(`
      DELETE FROM scip_documents WHERE id IN (${documentPlaceholders})
    `).run(...documentIds);

    const symbolsToDelete: string[] = [];
    for (const symbol of touchedSymbols) {
      const remaining = this.db.prepare(`
        SELECT 1 FROM scip_occurrences WHERE symbol = ? LIMIT 1
      `).get(symbol);
      if (!remaining) symbolsToDelete.push(symbol);
    }

    if (symbolsToDelete.length > 0) {
      const symbolPlaceholders = symbolsToDelete.map(() => '?').join(',');
      const relationshipRows = this.db.prepare(`
        SELECT id FROM scip_relationships
        WHERE source_symbol IN (${symbolPlaceholders}) OR target_symbol IN (${symbolPlaceholders})
      `).all(...symbolsToDelete, ...symbolsToDelete) as Array<{ id: string }>;
      const relationshipIds = relationshipRows.map((row) => row.id);
      if (relationshipIds.length > 0) {
        const deletedRelationshipsJson = JSON.stringify(relationshipIds);
        this.db.prepare(`
          DELETE FROM edges
          WHERE provenance = 'scip'
            AND json_extract(metadata, '$.scipRelationship') IN (SELECT value FROM json_each(?))
        `).run(deletedRelationshipsJson);
      }
      this.db.prepare(`
        DELETE FROM scip_relationships
        WHERE source_symbol IN (${symbolPlaceholders}) OR target_symbol IN (${symbolPlaceholders})
      `).run(...symbolsToDelete, ...symbolsToDelete);
      this.db.prepare(`DELETE FROM scip_symbols WHERE symbol IN (${symbolPlaceholders})`).run(...symbolsToDelete);
      this.db.prepare(`
        UPDATE nodes SET
          scip_symbol = NULL,
          scip_kind = NULL,
          scip_display_name = NULL,
          scip_signature = NULL,
          scip_documentation = NULL,
          scip_source_indexers = NULL
        WHERE scip_symbol IN (${symbolPlaceholders})
      `).run(...symbolsToDelete);
    }

    this.nodeCache.clear();
    this.preservedScipFieldsByNodeId.clear();
  }

  getScipDefinitionOccurrencesWithDocuments(limit?: number): Array<{
    symbol: ScipSymbolRecord;
    occurrence: ScipOccurrenceRecord;
    document: ScipDocumentRecord;
  }> {
    const boundedLimit = finitePositiveLimit(limit);
    const rows = this.db.prepare(`
      SELECT s.*, o.id AS o_id, o.document_id, o.symbol AS o_symbol, o.start_line, o.start_character,
        o.end_line, o.end_character, o.symbol_roles, o.syntax_kind, o.enclosing_start_line,
        o.enclosing_start_character, o.enclosing_end_line, o.enclosing_end_character,
        o.override_documentation, o.diagnostics,
        d.id AS d_id, d.index_id, d.relative_path, d.repo_relative_path, d.language,
        d.position_encoding, d.text_sha256, d.metadata AS d_metadata
      FROM scip_occurrences o
      JOIN scip_documents d ON d.id = o.document_id
      JOIN scip_symbols s ON s.symbol = o.symbol
      WHERE ((coalesce(o.symbol_roles, 0) & 1) = 1)
      ORDER BY d.repo_relative_path, o.start_line, o.start_character, s.symbol
      ${boundedLimit ? 'LIMIT ?' : ''}
    `).all(...(boundedLimit ? [boundedLimit] : [])) as Array<ScipSymbolRow & ScipOccurrenceRow & {
      o_id: string;
      o_symbol: string | null;
      d_id: string;
      index_id: string;
      relative_path: string;
      repo_relative_path: string;
      language: string;
      position_encoding: string | null;
      text_sha256: string | null;
      d_metadata: string | null;
    }>;
    return rows.map((row) => ({
      symbol: rowToScipSymbol(row),
      occurrence: rowToScipOccurrence({
        id: row.o_id,
        document_id: row.document_id,
        symbol: row.o_symbol,
        start_line: row.start_line,
        start_character: row.start_character,
        end_line: row.end_line,
        end_character: row.end_character,
        symbol_roles: row.symbol_roles,
        syntax_kind: row.syntax_kind,
        enclosing_start_line: row.enclosing_start_line,
        enclosing_start_character: row.enclosing_start_character,
        enclosing_end_line: row.enclosing_end_line,
        enclosing_end_character: row.enclosing_end_character,
        override_documentation: row.override_documentation,
        diagnostics: row.diagnostics,
      }),
      document: rowToScipDocument({
        id: row.d_id,
        index_id: row.index_id,
        relative_path: row.relative_path,
        repo_relative_path: row.repo_relative_path,
        language: row.language,
        position_encoding: row.position_encoding,
        text_sha256: row.text_sha256,
        metadata: row.d_metadata,
      }),
    }));
  }

  getScipDocuments(): ScipDocumentRecord[] {
    const rows = this.db.prepare('SELECT * FROM scip_documents ORDER BY repo_relative_path').all() as ScipDocumentRow[];
    return rows.map(rowToScipDocument);
  }

  getScipRelationships(): ScipRelationshipRecord[] {
    const rows = this.db.prepare('SELECT * FROM scip_relationships ORDER BY source_symbol, target_symbol').all() as ScipRelationshipRow[];
    return rows.map(rowToScipRelationship);
  }

  getScipRelationshipsForSymbol(
    symbol: string,
    limit?: number,
    kind?: 'implementation' | 'typeDefinition'
  ): ScipRelationshipRecord[] {
    const boundedLimit = finitePositiveLimit(limit);
    const kindWhere = kind === 'implementation'
      ? 'AND is_implementation = 1'
      : kind === 'typeDefinition'
        ? 'AND is_type_definition = 1'
        : '';
    const rows = this.db.prepare(`
      SELECT * FROM scip_relationships
      WHERE (source_symbol = ? OR target_symbol = ?)
      ${kindWhere}
      ORDER BY source_symbol, target_symbol
      ${boundedLimit ? 'LIMIT ?' : ''}
    `).all(...(boundedLimit ? [symbol, symbol, boundedLimit] : [symbol, symbol])) as ScipRelationshipRow[];
    return rows.map(rowToScipRelationship);
  }

  getScipImplementationRelationships(): ScipRelationshipRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scip_relationships WHERE is_implementation = 1 ORDER BY source_symbol, target_symbol
    `).all() as ScipRelationshipRow[];
    return rows.map(rowToScipRelationship);
  }

  getScipStats(): ScipStats {
    if (!this.tableExists('scip_indexes')) {
      return { indexes: 0, documents: 0, symbols: 0, occurrences: 0, relationships: 0, linkedNodes: 0, generation: getScipGenerationStatus(this) };
    }
    const stats = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM scip_indexes) AS indexes,
        (SELECT COUNT(*) FROM scip_documents) AS documents,
        (SELECT COUNT(*) FROM scip_symbols) AS symbols,
        (SELECT COUNT(*) FROM scip_occurrences) AS occurrences,
        (SELECT COUNT(*) FROM scip_relationships) AS relationships,
        (SELECT COUNT(*) FROM nodes WHERE scip_symbol IS NOT NULL) AS linkedNodes
    `).get() as ScipStats;
    stats.generation = getScipGenerationStatus(this);
    return stats;
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
    deleteMany(refs);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { present: number } | undefined;
    return row !== undefined;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    // Single query for all three aggregate counts
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };
    this.countStatement('stats.read');

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    const hyperedgeStats: Pick<GraphStats, 'hyperedgeCount' | 'hyperedgesByKind'> = {};
    if (this.tableExists('hyperedges')) {
      const hyperedgeCountRow = this.db
        .prepare('SELECT COUNT(*) as count FROM hyperedges')
        .get() as { count: number };
      const hyperedgesByKind = {} as Record<HyperedgeKind, number>;
      const hyperedgeKindRows = this.db
        .prepare('SELECT kind, COUNT(*) as count FROM hyperedges GROUP BY kind')
        .all() as Array<{ kind: string; count: number }>;
      for (const row of hyperedgeKindRows) {
        hyperedgesByKind[row.kind as HyperedgeKind] = row.count;
      }
      hyperedgeStats.hyperedgeCount = hyperedgeCountRow.count;
      hyperedgeStats.hyperedgesByKind = hyperedgesByKind;
    }

    const capabilityStats = this.getCapabilityStats();

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      ...hyperedgeStats,
      capabilityAssertionCount: capabilityStats.assertionCount,
      capabilityAnalysisRunCount: capabilityStats.runCount,
      scip: this.getScipStats(),
      solidkgVersion: this.tableExists('project_metadata') ? this.getMetadata(SOLIDKG_VERSION_METADATA_KEY) : null,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  saveSnapshot(metadata: StoredSnapshotMetadata, graph: StoredSnapshotGraph): void {
    this.db.transaction(() => {
      this.deleteSnapshotRows(metadata.label);
      this.db.prepare(`
        INSERT INTO graph_snapshots (
          label, description, metadata, created_at, node_count, edge_count, hyperedge_count, hyperedge_member_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        metadata.label,
        metadata.description ?? null,
        metadata.metadata ? JSON.stringify(metadata.metadata) : null,
        metadata.createdAt,
        metadata.nodeCount,
        metadata.edgeCount,
        metadata.hyperedgeCount,
        metadata.hyperedgeMemberCount
      );

      const insertNode = this.db.prepare('INSERT INTO graph_snapshot_nodes (snapshot_label, node_id, payload) VALUES (?, ?, ?)');
      for (const node of graph.nodes) {
        insertNode.run(metadata.label, node.id, JSON.stringify(node));
      }

      const insertEdge = this.db.prepare('INSERT INTO graph_snapshot_edges (snapshot_label, edge_key, payload) VALUES (?, ?, ?)');
      for (const edge of graph.edges) {
        insertEdge.run(metadata.label, storedEdgeKey(edge), JSON.stringify(edge));
      }

      const insertHyperedge = this.db.prepare('INSERT INTO graph_snapshot_hyperedges (snapshot_label, hyperedge_id, payload) VALUES (?, ?, ?)');
      for (const hyperedge of graph.hyperedges) {
        insertHyperedge.run(metadata.label, hyperedge.id, JSON.stringify(hyperedge));
      }

      const insertMember = this.db.prepare('INSERT INTO graph_snapshot_hyperedge_members (snapshot_label, member_key, payload) VALUES (?, ?, ?)');
      for (const member of graph.hyperedgeMembers) {
        insertMember.run(metadata.label, storedMemberKey(member), JSON.stringify(member));
      }
    })();
  }

  listSnapshots(): StoredSnapshotMetadata[] {
    const rows = this.db.prepare('SELECT * FROM graph_snapshots ORDER BY created_at, label').all() as SnapshotMetadataRow[];
    return rows.map(rowToSnapshotMetadata);
  }

  getSnapshot(label: string): { metadata: StoredSnapshotMetadata; graph: StoredSnapshotGraph } | null {
    const metadataRow = this.db.prepare('SELECT * FROM graph_snapshots WHERE label = ?').get(label) as SnapshotMetadataRow | undefined;
    if (!metadataRow) return null;
    const nodes = this.db.prepare('SELECT payload FROM graph_snapshot_nodes WHERE snapshot_label = ? ORDER BY node_id').all(label) as JsonPayloadRow[];
    const edges = this.db.prepare('SELECT payload FROM graph_snapshot_edges WHERE snapshot_label = ? ORDER BY edge_key').all(label) as JsonPayloadRow[];
    const hyperedges = this.db.prepare('SELECT payload FROM graph_snapshot_hyperedges WHERE snapshot_label = ? ORDER BY hyperedge_id').all(label) as JsonPayloadRow[];
    const members = this.db.prepare('SELECT payload FROM graph_snapshot_hyperedge_members WHERE snapshot_label = ? ORDER BY member_key').all(label) as JsonPayloadRow[];
    return {
      metadata: rowToSnapshotMetadata(metadataRow),
      graph: {
        nodes: parsePayloadRows<StoredSnapshotNodeRecord>(nodes),
        edges: parsePayloadRows<StoredSnapshotEdgeRecord>(edges),
        hyperedges: parsePayloadRows<StoredSnapshotHyperedgeRecord>(hyperedges),
        hyperedgeMembers: parsePayloadRows<StoredSnapshotHyperedgeMemberRecord>(members),
      },
    };
  }

  deleteSnapshot(label: string): boolean {
    const result = this.db.prepare('DELETE FROM graph_snapshots WHERE label = ?').run(label);
    return result.changes > 0;
  }

  saveArchitectureReport(report: StoredArchitectureReport): void {
    this.db.transaction(() => {
      this.clearArchitectureRows();
      this.db.prepare('INSERT INTO architecture_reports (id, payload, updated_at) VALUES (?, ?, ?)').run(
        'current',
        JSON.stringify(report),
        Date.now()
      );

      const insertPackage = this.db.prepare('INSERT INTO arch_packages (name, root, provenance, file_count) VALUES (?, ?, ?, ?)');
      for (const pkg of report.packages) {
        insertPackage.run(pkg.name, pkg.root, pkg.provenance, pkg.fileCount);
      }

      const insertLayer = this.db.prepare('INSERT INTO arch_layers (name, provenance, file_count) VALUES (?, ?, ?)');
      for (const layer of report.layers) {
        insertLayer.run(layer.name, layer.provenance, layer.fileCount);
      }

      const insertFilePackage = this.db.prepare('INSERT INTO arch_file_packages (file_path, package_name, package_root, provenance) VALUES (?, ?, ?, ?)');
      const insertFileLayer = this.db.prepare('INSERT INTO arch_file_layers (file_path, layer_name, provenance) VALUES (?, ?, ?)');
      for (const assignment of report.fileAssignments) {
        insertFilePackage.run(assignment.filePath, assignment.packageName, assignment.packageRoot, assignment.packageProvenance);
        insertFileLayer.run(assignment.filePath, assignment.layerName, assignment.layerProvenance);
      }

      const insertPackageDep = this.db.prepare('INSERT INTO arch_package_deps (source, target, edge_kinds) VALUES (?, ?, ?)');
      for (const dep of report.packageDependencies) {
        insertPackageDep.run(dep.source, dep.target, JSON.stringify(dep.edgeKinds));
      }

      const insertLayerDep = this.db.prepare('INSERT INTO arch_layer_deps (source, target, edge_kinds) VALUES (?, ?, ?)');
      for (const dep of report.layerDependencies) {
        insertLayerDep.run(dep.source, dep.target, JSON.stringify(dep.edgeKinds));
      }

      const insertCoupling = this.db.prepare('INSERT INTO arch_coupling (scope, name, ca, ce, instability) VALUES (?, ?, ?, ?, ?)');
      for (const metric of report.coupling.packages) {
        insertCoupling.run('package', metric.name, metric.Ca, metric.Ce, metric.instability);
      }
      for (const metric of report.coupling.layers) {
        insertCoupling.run('layer', metric.name, metric.Ca, metric.Ce, metric.instability);
      }
    })();
  }

  getArchitectureReport(): StoredArchitectureReport | null {
    const row = this.db.prepare('SELECT payload FROM architecture_reports WHERE id = ?').get('current') as JsonPayloadRow | undefined;
    if (!row) return null;
    return safeJsonParse<StoredArchitectureReport | null>(row.payload, null);
  }

  private deleteSnapshotRows(label: string): void {
    this.db.prepare('DELETE FROM graph_snapshot_hyperedge_members WHERE snapshot_label = ?').run(label);
    this.db.prepare('DELETE FROM graph_snapshot_hyperedges WHERE snapshot_label = ?').run(label);
    this.db.prepare('DELETE FROM graph_snapshot_edges WHERE snapshot_label = ?').run(label);
    this.db.prepare('DELETE FROM graph_snapshot_nodes WHERE snapshot_label = ?').run(label);
    this.db.prepare('DELETE FROM graph_snapshots WHERE label = ?').run(label);
  }

  private clearArchitectureRows(): void {
    this.db.exec('DELETE FROM arch_coupling');
    this.db.exec('DELETE FROM arch_layer_deps');
    this.db.exec('DELETE FROM arch_package_deps');
    this.db.exec('DELETE FROM arch_file_layers');
    this.db.exec('DELETE FROM arch_file_packages');
    this.db.exec('DELETE FROM arch_layers');
    this.db.exec('DELETE FROM arch_packages');
    this.db.exec('DELETE FROM architecture_reports');
  }

  private clearScipRows(): void {
    if (!this.tableExists('scip_indexes')) return;
    this.db.exec('DELETE FROM scip_relationships');
    this.db.exec('DELETE FROM scip_occurrences');
    this.db.exec('DELETE FROM scip_documents');
    this.db.exec('DELETE FROM scip_indexes');
    this.db.exec('DELETE FROM scip_symbols');
    if (this.tableExists('project_metadata')) {
      this.db.prepare('DELETE FROM project_metadata WHERE key = ?').run('scip:generation');
    }
    this.preservedScipFieldsByNodeId.clear();
  }

  /**
   * Clear all data from the database
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      if (this.tableExists('architecture_reports')) {
        this.clearArchitectureRows();
      }
      if (this.tableExists('capability_assertions')) {
        this.db.exec('DELETE FROM capability_assertions');
      }
      if (this.tableExists('capability_analysis_runs')) {
        this.db.exec('DELETE FROM capability_analysis_runs');
      }
      this.clearScipRows();
      this.db.exec('DELETE FROM unresolved_refs');
      if (this.tableExists('hyperedge_members')) {
        this.db.exec('DELETE FROM hyperedge_members');
      }
      if (this.tableExists('hyperedges')) {
        this.db.exec('DELETE FROM hyperedges');
      }
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
    })();
  }
}
