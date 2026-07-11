/**
 * SolidKG Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

import type { ContextBudget } from "./context/budget";

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph.
 *
 * Defined as a runtime-iterable `as const` array so the same source
 * of truth backs both the TS type and any runtime validation
 * (e.g. the search query parser).
 */
export const NODE_KINDS = [
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "function",
  "method",
  "property",
  "field",
  "variable",
  "constant",
  "enum",
  "enum_member",
  "type_alias",
  "namespace",
  "parameter",
  "import",
  "export",
  "route",
  "component",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Semantic hyperedge relation kinds. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const HYPEREDGE_KINDS = [
  "route_binding",
  "event_channel",
  "ui_render",
  "dynamic_dispatch",
  "native_bridge",
  "type_contract",
] as const;

export type HyperedgeKind = (typeof HYPEREDGE_KINDS)[number];

/**
 * How a semantic hyperedge was created.
 */
export type HyperedgeProvenance =
  | "tree-sitter"
  | "scip"
  | "heuristic"
  | "manual";

export type SemanticRelationProvenance =
  | "scip"
  | "ast_static"
  | "semantic_synthesis"
  | "heuristic_resolver";

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | "contains" // Parent contains child (file→class, class→method)
  | "calls" // Function/method calls another
  | "imports" // File imports from another
  | "exports" // File exports a symbol
  | "extends" // Class/interface extends another
  | "implements" // Class implements interface
  | "references" // Generic reference to another symbol
  | "type_of" // Variable/parameter has type
  | "returns" // Function returns type
  | "instantiates" // Creates instance of class
  | "overrides" // Method overrides parent method
  | "decorates"; // Decorator applied to symbol

/**
 * Supported programming languages. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "dart",
  "svelte",
  "vue",
  "liquid",
  "astro",
  "jinja",
  "razor",
  "pascal",
  "scala",
  "lua",
  "luau",
  "objc",
  "systemverilog",
  "julia",
  "fortran",
  "r",
  "groovy",
  "vbnet",
  "sql",
  "hcl",
  "nix",
  "arkts",
  "scl",
  "solidity",
  "bash",
  "powershell",
  "yaml",
  "twig",
  "unknown",
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  scipSymbol?: string;
  scipKind?: string;
  scipDisplayName?: string;
  scipSignature?: string;
  scipDocumentation?: string;
  scipSourceIndexers?: string[];

  /** Visibility modifier */
  visibility?: "public" | "private" | "protected" | "internal";

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /** How this edge was created */
  provenance?: "tree-sitter" | "scip" | "heuristic";
}

/**
 * A semantic relation connecting two or more graph nodes.
 */
export interface Hyperedge {
  /** Stable semantic relation identifier */
  id: string;

  /** Type of semantic relation */
  kind: HyperedgeKind;

  /** Source file where the relation was registered or inferred */
  sourceFile?: string;

  /** Line number where relation occurs or was registered */
  line?: number;

  /** Column number where relation occurs or was registered */
  column?: number;

  /** How this hyperedge was created */
  provenance?: HyperedgeProvenance;

  /** Confidence score for heuristic relations (0-1) */
  confidence?: number;

  /** Additional context about the relation */
  metadata?: Record<string, unknown>;

  /** When the hyperedge was created */
  createdAt: number;

  /** When the hyperedge was last updated */
  updatedAt: number;
}

/**
 * Membership of a node in a semantic hyperedge.
 */
export interface HyperedgeMember {
  /** Parent hyperedge ID */
  hyperedgeId: string;

  /** Member node ID */
  nodeId: string;

  /** Role this node plays in the relation */
  role: string;

  /** Ordered position within the role/relation */
  ordinal: number;

  /** Additional context about the membership */
  metadata?: Record<string, unknown>;
}

/**
 * A semantic hyperedge with ordered member node payloads.
 */
export interface HyperedgeRelation {
  /** Hyperedge header */
  hyperedge: Hyperedge;

  /** Ordered relation members with resolved nodes */
  members: Array<HyperedgeMember & { node: Node }>;
}

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Framework-provided semantic relation hints for post-resolution synthesis */
  relationHints?: FrameworkRelationHint[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: "error" | "warning";

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  id?: number;

  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];

  /** Semantic relation member metadata to carry through reference resolution */
  relationHint?: FrameworkRelationHintRef;
}

export type FrameworkRelationHintMemberRole =
  | "route"
  | "middleware"
  | "validator"
  | "handler"
  | "template";

export interface FrameworkRelationHintMember {
  role: FrameworkRelationHintMemberRole;
  ordinal: number;
  nodeId?: string;
  referenceName?: string;
  referenceKind?: EdgeKind;
}

export interface FrameworkRelationHint {
  id: string;
  kind: "route_chain";
  relationKind: "route_binding";
  sourceFile: string;
  line: number;
  column: number;
  members: FrameworkRelationHintMember[];
}

export interface FrameworkRelationHintRef {
  id: string;
  kind: FrameworkRelationHint["kind"];
  relationKind: FrameworkRelationHint["relationKind"];
  role: FrameworkRelationHintMemberRole;
  ordinal: number;
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /** Semantic hyperedges included in this subgraph */
  hyperedges?: HyperedgeRelation[];

  /** Ranking evidence from the search channels that seeded this subgraph */
  searchRankingReasons?: readonly SearchRankingReason[];

  /** Root/entry node IDs that entered or were boosted by source chunk body evidence */
  chunkEvidenceNodeIds?: readonly string[];
}

interface PairwiseTraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: "outgoing" | "incoming" | "both";

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

interface HyperedgeTraversalOptions extends PairwiseTraversalOptions {
  /** Whether to include opt-in semantic hyperedge traversal */
  includeHyperedges?: boolean;

  /** Hyperedge types to follow when hyperedge traversal is enabled */
  hyperedgeKinds?: HyperedgeKind[];

  /** How matching hyperedges expand traversal */
  hyperedgeExpansion?: "members" | "ordered-flow";

  /** Maximum hyperedges to include during traversal */
  maxHyperedges?: number;
}

/**
 * Options for graph traversal
 */
export type TraversalOptions =
  | PairwiseTraversalOptions
  | HyperedgeTraversalOptions;

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;
}

export type SearchRankingReasonKind =
  | "node_metadata"
  | "source_body_chunk"
  | "exact_symbol"
  | "exact_path"
  | "graph_signal"
  | "fusion"
  | "generated_or_test_dampening";

export interface SearchRankingReason {
  readonly kind: SearchRankingReasonKind;
  readonly label: string;
  readonly weight: number;
  readonly evidence?: string;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];

  /** Machine-checkable evidence explaining how this result was ranked */
  rankingReasons?: readonly SearchRankingReason[];
}

export interface SourceChunkRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly filePath: string;
  readonly language: Language;
  readonly symbolKind: NodeKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly sourceHash: string;
  readonly chunkOrdinal: number;
  readonly indexerVersion: string;
  readonly content: string;
  readonly codeTokenText: string;
  readonly metadata?: Record<string, unknown>;
  readonly diagnostics?: readonly SourceChunkDiagnostic[];
  readonly updatedAt: number;
}

export interface SourceChunkDiagnostic {
  readonly message: string;
  readonly severity: "error" | "warning" | "info";
  readonly code?: string;
  readonly line?: number;
  readonly column?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface SourceChunkSearchOptions {
  readonly languages?: readonly Language[];
  readonly filePaths?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface SourceChunkSearchResult {
  readonly chunk: SourceChunkRecord;
  readonly score: number;
}

export interface SourceChunkDiagnostics {
  readonly chunkCount: number;
  readonly ftsRowCount: number;
  readonly orphanFtsRowCount: number;
}

export type RetrievalCandidateChannelKind = "dense" | "reranker";

export interface RetrievalCandidate {
  readonly nodeId: string;
  readonly score: number;
  readonly rankingReasons?: readonly SearchRankingReason[];
}

export interface RetrievalCandidateQuery {
  readonly query: string;
  readonly text: string;
  readonly kinds?: readonly NodeKind[];
  readonly languages?: readonly Language[];
  readonly limit: number;
  readonly maxPayloadBytes: number;
}

export interface RetrievalCandidateChannel {
  readonly kind: RetrievalCandidateChannelKind;
  readonly searchCandidates: (
    query: RetrievalCandidateQuery,
  ) => readonly RetrievalCandidate[];
}

export interface RetrievalCandidateChannelFactory {
  readonly kind: RetrievalCandidateChannelKind;
  readonly create: () => RetrievalCandidateChannel;
}

export interface RetrievalExtensionBounds {
  readonly maxCandidates: number;
  readonly timeoutMs: number;
  readonly maxPayloadBytes: number;
}

export interface HybridRetrievalConfig extends Partial<RetrievalExtensionBounds> {
  readonly mode?: "disabled" | "external";
  readonly candidateChannels?: readonly RetrievalCandidateChannelFactory[];
}

export interface RetrievalExtensionConfig {
  readonly hybrid?: HybridRetrievalConfig;
}

export interface RetrievalExtensionDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly channelKind?: RetrievalCandidateChannelKind;
}

export interface RetrievalExtensionStatus {
  readonly mode: "disabled";
  readonly activeChannels: readonly RetrievalCandidateChannelKind[];
  readonly skippedChannels: readonly RetrievalCandidateChannelKind[];
  readonly bounds: RetrievalExtensionBounds;
  readonly diagnostics: readonly RetrievalExtensionDiagnostic[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Returned-source coverage for context output.
 * This describes how much source was returned, not answer truth, path truth,
 * runtime reachability, or other confidence signals.
 */
export type SourceCompletenessStatus =
  | "complete"
  | "partial"
  | "truncated"
  | "omitted"
  | "unreadable"
  | "skipped";

/**
 * Summary metadata for returned source coverage in a context payload.
 * This is only about returned source coverage, not correctness.
 */
export interface SourceCompletenessMetadata {
  status: SourceCompletenessStatus;
  candidateBlocks: number;
  returnedBlocks: number;
  completeBlocks: number;
  truncatedBlocks: number;
  omittedBlocks: number;
  unreadableBlocks: number;
  maxBlocks: number;
  maxBlockSize: number;
  followUp: SourceCompletenessFollowUp;
}

export interface SourceCompletenessFollowUp {
  reason: SourceCompletenessStatus;
  guidance: string;
  solidkgFirst: string[];
}

export type AnswerSufficiencyStatus = "sufficient" | "partial" | "insufficient";

export type ReturnedEvidenceAction =
  | "explain_returned_evidence"
  | "localize_candidate"
  | "requires_focused_follow_up";

export type ReturnedEvidenceScope = "returned_evidence_only";

export type ReturnedEvidenceFreshness = "fresh" | "stale" | "unknown";

export type ReturnedEvidenceCapState = "uncapped" | "capped" | "unknown";

export type ReturnedEvidenceProvenance =
  | "precise"
  | "static"
  | "heuristic"
  | "unknown";

export interface ReturnedEvidenceNextAction {
  action: string;
  reason: string;
}

export interface ReturnedEvidenceActionability {
  eligibleActions: ReturnedEvidenceAction[];
  scope: ReturnedEvidenceScope;
  blockers: string[];
  evidenceProvenance: ReturnedEvidenceProvenance[];
  sourceCoverage: SourceCompletenessStatus | "unknown";
  freshness: ReturnedEvidenceFreshness;
  capState: ReturnedEvidenceCapState;
  nextAction: ReturnedEvidenceNextAction;
  mustValidateWith: string[];
  notACompletenessClaim: true;
}

export type UncertaintyLabel =
  | "ambiguous_symbol"
  | "bounded_no_results"
  | "bounded_no_static_path"
  | "missing_query_concept"
  | "source_partial"
  | "heuristic_edge";

export interface SourceAnchor {
  nodeId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface EvidencePacketEntry {
  evidenceId: string;
  kind: "symbol" | "source" | "relationship" | "failure";
  label: string;
  sourceAnchor: SourceAnchor;
}

export interface RankingReason {
  kind:
    | "entry_point"
    | "source_returned"
    | "source_body_chunk"
    | "graph_relationship"
    | "semantic_relation"
    | "failure_boundary";
  label: string;
  weight: number;
}

export interface AnswerPacket {
  schemaVersion: "solidkg.answer-packet.v1";
  packetId: string;
  query: string;
  tool: string;
  sufficiency: {
    status: AnswerSufficiencyStatus;
    canAnswerFromReturnedContext: boolean;
    reason: string;
  };
  uncertaintyLabels: UncertaintyLabel[];
  returnedEvidenceActionability?: ReturnedEvidenceActionability;
  evidence: EvidencePacketEntry[];
  rankingReasons: RankingReason[];
  suggestedNextTools: string[];
}

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;

  /** Returned-source coverage for this block when exposed in context output */
  sourceCompleteness?: Exclude<
    SourceCompletenessStatus,
    "partial" | "omitted" | "unreadable" | "skipped"
  >;

  /** Original source character count before truncation */
  sourceOriginalChars?: number;

  /** Returned source character count after truncation */
  sourceReturnedChars?: number;
}

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** Total number of semantic hyperedges */
  hyperedgeCount?: number;

  /** Hyperedge counts by kind */
  hyperedgesByKind?: Record<HyperedgeKind, number>;

  capabilityAssertionCount?: number;

  capabilityAnalysisRunCount?: number;

  scip?: ScipStats;

  solidkgVersion?: string | null;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

export type ScipMode = "auto" | "off" | "required";

export type ScipGenerationState =
  | "available"
  | "generated"
  | "failed"
  | "skipped"
  | "indexer-missing"
  | "unsupported";

export interface ScipGenerationLanguageStatus {
  language: string;
  state: ScipGenerationState;
  fileCount: number;
  command?: string;
  outputFile?: string;
  message?: string;
  durationMs?: number;
}

export interface ScipGenerationStatus {
  mode: ScipMode;
  updatedAt: number;
  languages: Record<string, ScipGenerationLanguageStatus>;
}

export interface ScipGenerationError {
  language: string;
  message: string;
}

export interface ScipGenerationResult {
  success: boolean;
  mode: ScipMode;
  generatedFiles: string[];
  status: ScipGenerationStatus;
  errors: ScipGenerationError[];
  durationMs: number;
}

export interface ScipStats {
  indexes: number;
  documents: number;
  symbols: number;
  occurrences: number;
  relationships: number;
  linkedNodes: number;
  generation?: ScipGenerationStatus;
}

export interface ScipImportStats extends ScipStats {}

export interface ScipLinkStats {
  nodesUpdated: number;
  edgesInserted: number;
}

export interface ScipIndexRecord {
  id: string;
  projectRoot: string;
  toolName?: string;
  toolVersion?: string;
  arguments?: string[];
  textDocumentEncoding?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface ScipDocumentRecord {
  id: string;
  indexId: string;
  relativePath: string;
  repoRelativePath: string;
  language: string;
  positionEncoding?: string;
  textSha256?: string;
  metadata?: Record<string, unknown>;
}

export interface ScipSymbolRecord {
  symbol: string;
  scheme?: string;
  packageManager?: string;
  packageName?: string;
  packageVersion?: string;
  displayName?: string;
  kind?: string;
  enclosingSymbol?: string;
  documentation?: string;
  signatureLanguage?: string;
  signatureText?: string;
  sourceIndexIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ScipOccurrenceRecord {
  id: string;
  documentId: string;
  symbol?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  symbolRoles?: number;
  syntaxKind?: string;
  enclosingStartLine?: number;
  enclosingStartCharacter?: number;
  enclosingEndLine?: number;
  enclosingEndCharacter?: number;
  overrideDocumentation?: string[];
  diagnostics?: unknown[];
}

export interface ScipRelationshipRecord {
  id: string;
  sourceSymbol: string;
  targetSymbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
  metadata?: Record<string, unknown>;
}

export interface ScipIndexerConfig {
  command: string;
  args?: string[];
  files: string[];
  timeoutMs?: number;
}

export interface ScipIndexerAvailability {
  available: boolean;
  reason?: string;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: "markdown" | "json";

  /** Detail preset for context output (default: 'standard') */
  detailLevel?: "standard" | "minimal";

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  redaction?:
    | false
    | {
        enabled?: boolean;
        redactEmails?: boolean;
        redactSecrets?: boolean;
      };
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** SolidKG package version that produced this context payload */
  solidkgVersion: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Returned-source coverage summary for this context payload */
  sourceCompleteness?: SourceCompletenessMetadata;

  answerPacket?: AnswerPacket;

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Compact repository overview for broad/minimal orientation */
  overview?: {
    readonly markdown: string;
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly symbolCount: number;
  };

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };

  contextBudget?: ContextBudget;
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];
}
