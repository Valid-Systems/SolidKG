/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  HyperedgeKind,
  HyperedgeRelation,
  Subgraph,
  CodeBlock,
  SourceCompletenessMetadata,
  SourceCompletenessStatus,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
  SearchRankingReason,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import {
  formatContextAsMarkdown,
  formatContextAsJson,
  formatContextAsMinimalMarkdown,
  formatContextAsMinimalJson,
} from './formatter';
import { buildContextBudget, type ContextBudget } from './budget';
import { buildOverviewTree, formatOverviewTree } from '../overview';
import { logDebug } from '../errors';
import { validatePathWithinRoot, normalizePath } from '../utils';
import { buildSourceRoots, type SourceRoot, type SourceRootOptions } from '../source-roots';
import {
  isTestFile,
  extractSearchTerms,
  selectRetrievalSearchTerms,
  scorePathRelevance,
  getStemVariants,
  kindBonus,
  nameMatchBonus,
} from '../search/query-utils';
import { isGeneratedFile, isGeneratedFileQuery } from '../search/path-classifiers';
import { buildContextAnswerPacket } from '../evidence/packets';
import { SOLIDKG_VERSION } from '../version';

const APPLY_CONTENT_RECOVERY_ENTRY_NAMES = [
  'content_blobs',
  'apply_intents',
  'apply_operations',
  'mutation_sessions',
  'complete_apply_mutation_with_review_and_audit',
] as const;

const APPLY_CONTENT_RECOVERY_TABLE_NAMES = [
  'content_blobs',
  'apply_intents',
  'apply_operations',
  'mutation_sessions',
] as const;

const CURATION_OPERATION_ALIAS_NAMES = [
  'CurationOperation',
  'CurationOpKind',
] as const;

const EXACT_CALLABLE_ANCHOR_KINDS = new Set<NodeKind>(['function', 'method', 'route', 'component']);

const OVERVIEW_QUERY_TERMS = [
  'codebase',
  'folder',
  'folders',
  'layout',
  'onboard',
  'onboarding',
  'overview',
  'project',
  'repo',
  'repository',
  'structure',
  'tree',
  'understand',
] as const;

function extractOverviewQueryTokens(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function isCurationOperationAliasQuery(queryLower: string): boolean {
  return queryLower.includes('review operation') || queryLower.includes('skill operation');
}

function isCompoundIdentifier(symbol: string): boolean {
  return /[a-z]/.test(symbol) && (/[A-Z]/.test(symbol) || symbol.includes('_'));
}

function exactSymbolIntentBonus(node: Node, symbols: string[]): number {
  let bonus = 0;
  for (const symbol of symbols) {
    if (!isCompoundIdentifier(symbol)) continue;
    if (node.name.toLowerCase() !== symbol.toLowerCase()) continue;
    bonus = Math.max(bonus, EXACT_CALLABLE_ANCHOR_KINDS.has(node.kind) ? 180 : 80);
  }
  return bonus;
}

/**
 * Extract likely symbol names from a natural language query
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers (no spaces, not common English words)
 *
 * @param query - Natural language query
 * @returns Array of potential symbol names
 */
function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();
  const queryLower = query.toLowerCase();

  // Extract CamelCase identifiers (2+ chars, starts with letter)
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // Extract snake_case identifiers
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      symbols.add(match[1]);
    }
  }

  // Extract SCREAMING_SNAKE_CASE
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract ALL_CAPS acronyms (2+ chars, e.g., REST, HTTP, LRU, API)
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract dot.notation and split into parts (e.g., "app.isPackaged" -> ["app", "isPackaged"])
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      // Add both the full path and individual parts
      symbols.add(match[1]);
      const parts = match[1].split('.');
      for (const part of parts) {
        if (part.length >= 2) {
          symbols.add(part);
        }
      }
    }
  }

  // Extract plain lowercase identifiers (3+ chars, not already matched)
  // Catches symbol names like "undo", "redo", "history", "render", "parse"
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Filter out common English words that aren't likely symbol names
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    // Common English nouns/verbs that match thousands of unrelated code symbols
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
    'path', 'paths', 'source', 'sources', 'snippet', 'snippets',
  ]);

  for (const alias of extractMcpToolHandlerAliases(query)) {
    symbols.add(alias);
  }

  if (isCurationOperationAliasQuery(queryLower)) {
    for (const alias of CURATION_OPERATION_ALIAS_NAMES) {
      symbols.add(alias);
    }
  }

  return Array.from(symbols).filter(s => !commonWords.has(s.toLowerCase()));
}

function extractMcpToolHandlerAliases(query: string): string[] {
  const aliases = new Set<string>();
  const toolPattern = /\bsolidkg_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/gi;
  let match;

  while ((match = toolPattern.exec(query)) !== null) {
    const shortName = match[1];
    if (!shortName) continue;
    const handlerName = `handle${shortName
      .split('_')
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('')}`;
    if (handlerName.length > 'handle'.length) {
      aliases.add(handlerName);
    }
  }

  return Array.from(aliases);
}

function extractQualifiedSymbolsFromQuery(query: string): string[] {
  const qualifiedSymbols = new Set<string>();
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  let match;

  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      qualifiedSymbols.add(match[1]);
    }
  }

  return Array.from(qualifiedSymbols);
}

function scoreQualifiedSymbolMatch(node: Node, qualifiedSymbol: string): number {
  const parts = qualifiedSymbol.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return 0;

  const leaf = parts[parts.length - 1];
  if (node.name.toLowerCase() !== leaf) return 0;

  const qualifierParts = parts.slice(0, -1);
  const normalizedQualifiedName = node.qualifiedName.toLowerCase().replace(/::/g, '.');
  const pathSegments = node.filePath.toLowerCase().split(/[\\/._-]+/).filter(Boolean);

  let score = 80;
  if (normalizedQualifiedName === parts.join('.')) {
    score += 80;
  }

  for (const qualifier of qualifierParts) {
    if (normalizedQualifiedName.split('.').includes(qualifier)) {
      score += 40;
    } else if (pathSegments.includes(qualifier)) {
      score += 25;
    } else {
      return 0;
    }
  }

  return score;
}

function normalizeSourceIntentToken(value: string): string {
  return value
    .trim()
    .replace(/^[`'"(<[{]+/, '')
    .replace(/[`'"\])>}.,;]+$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function basenameOfSourceIntent(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function extractExactFileIntentTokens(query: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const token = normalizeSourceIntentToken(raw);
    if (!token || token.endsWith('/')) continue;

    const basename = basenameOfSourceIntent(token);
    if (!/^[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(basename)) continue;

    tokens.add(token);
    tokens.add(basename.toLowerCase());
  }
  return tokens;
}

function matchesExactFileIntent(node: Node, exactFileTokens: Set<string>): boolean {
  if (exactFileTokens.size === 0) return false;

  const normalizedPath = normalizeSourceIntentToken(node.filePath);
  const basename = basenameOfSourceIntent(normalizedPath);
  return exactFileTokens.has(normalizedPath) || exactFileTokens.has(basename);
}

/**
 * Default options for context building
 *
 * Tuned for minimal context usage while still providing useful results:
 * - Fewer nodes and code blocks by default
 * - Smaller code block size limit
 * - Shallower traversal
 */
const DEFAULT_BUILD_OPTIONS: Required<Omit<BuildContextOptions, 'redaction'>> & Pick<BuildContextOptions, 'redaction'> = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
  detailLevel: 'standard',
};

/**
 * Node kinds that provide high information value in context results.
 * Imports/exports are excluded because they have near-zero information density -
 * they tell you something exists, not how it works.
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function', 'method', 'class', 'interface', 'type_alias', 'struct', 'trait',
  'component', 'route', 'variable', 'constant', 'enum', 'module', 'namespace',
];

const DEFAULT_SEMANTIC_KINDS: HyperedgeKind[] = [
  'route_binding',
  'event_channel',
  'ui_render',
  'dynamic_dispatch',
  'native_bridge',
];

const HIGH_VALUE_RELATION_MEMBER_ROLES = new Set([
  'route',
  'handler',
  'controller',
  'view',
  'callback',
  'listener',
  'render_method',
  'render_child',
  'implementation',
  'native_implementation',
]);


interface CodeBlockWithSourceCompleteness extends CodeBlock {
  sourceCompleteness: Exclude<SourceCompletenessStatus, 'partial' | 'omitted' | 'unreadable' | 'skipped'>;
  sourceOriginalChars: number;
  sourceReturnedChars: number;
}

interface CodeBlocksWithSourceCompleteness extends Array<CodeBlock> {
  sourceCompleteness?: SourceCompletenessMetadata;
}

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // Reduced from 5
  traversalDepth: 1,     // Reduced from 2
  maxNodes: 20,          // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // Filter out imports/exports by default
};

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;
  private sourceRoots: SourceRoot[];
  private indexedRootLabels: Set<string> | null = null;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser,
    sourceOptions: SourceRootOptions = {}
  ) {
    this.queries = queries;
    this.traverser = traverser;
    this.sourceRoots = buildSourceRoots(projectRoot, sourceOptions.extraRoots ?? []);
  }

  private getIndexedRootLabels(): Set<string> {
    if (this.indexedRootLabels) return this.indexedRootLabels;

    const labels = new Set<string>();
    for (const file of this.queries.getAllFilePaths()) {
      const match = normalizePath(file).match(/^@([^/]+)\//);
      if (match?.[1]) labels.add(match[1]);
    }
    this.indexedRootLabels = labels;
    return labels;
  }

  private resolveIndexedPath(filePath: string): string | null {
    const normalized = normalizePath(filePath);
    const rootQualified = normalized.match(/^@([^/]+)\/(.*)$/);
    if (rootQualified) {
      const [, label, relativePath] = rootQualified;
      for (const root of this.sourceRoots) {
        if (root.label === label) {
          return validatePathWithinRoot(root.rootDir, relativePath ?? '');
        }
      }
      return null;
    }

    if (this.sourceRoots.length === 1 && this.getIndexedRootLabels().size === 0) {
      return validatePathWithinRoot(this.sourceRoots[0]!.rootDir, normalized);
    }

    return null;
  }

  private extractQueryRootLabel(query: string): string | null {
    const match = query.match(/@([^/\s]+)\//);
    return match?.[1] ?? null;
  }

  private stripRootLabel(filePath: string): string {
    const normalized = normalizePath(filePath);
    return normalized.replace(/^@[^/]+\//, '');
  }

  private nodeRootLabel(filePath: string): string | null {
    const normalized = normalizePath(filePath);
    const match = normalized.match(/^@([^/]+)\//);
    return match?.[1] ?? null;
  }

  private applyRootScopedFailClosedFilter(query: string, results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;

    const queryRootLabel = this.extractQueryRootLabel(query);
    if (queryRootLabel) {
      return results.filter((result) => this.nodeRootLabel(result.node.filePath) === queryRootLabel);
    }

    if (!query.includes('/') || query.includes('@')) return results;

    const keyToRoots = new Map<string, Set<string>>();
    for (const result of results) {
      const key = `${this.stripRootLabel(result.node.filePath)}::${result.node.name}`;
      const roots = keyToRoots.get(key) ?? new Set<string>();
      roots.add(this.nodeRootLabel(result.node.filePath) ?? '__unlabeled__');
      keyToRoots.set(key, roots);
    }

    return results.filter((result) => {
      const key = `${this.stripRootLabel(result.node.filePath)}::${result.node.name}`;
      return (keyToRoots.get(key)?.size ?? 0) <= 1;
    });
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {}
  ): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // Get entry points (nodes from semantic search)
    const entryPoints = this.getEntryPoints(subgraph);

    const includeCode = opts.detailLevel === 'minimal'
      ? options.includeCode === true && Object.prototype.hasOwnProperty.call(options, 'maxCodeBlocks') && (options.maxCodeBlocks ?? 0) > 0
      : opts.includeCode;

    // Extract code blocks for key nodes
    const codeBlocks = includeCode
      ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize, query)
      : [];
    const sourceCompleteness = this.buildSourceCompleteness(
      subgraph,
      codeBlocks,
      includeCode,
      opts.maxCodeBlocks,
      opts.maxCodeBlockSize,
      query,
    );

    // Get related files
    const relatedFiles = this.getRelatedFiles(subgraph);

    // Generate summary
    const summary = this.generateSummary(query, subgraph, entryPoints);

    const overview = this.shouldAttachOverview(query, opts.detailLevel)
      ? this.buildOverviewContext()
      : undefined;

    // Calculate stats
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      solidkgVersion: SOLIDKG_VERSION,
      subgraph,
      entryPoints,
      codeBlocks,
      sourceCompleteness,
      answerPacket: buildContextAnswerPacket({
        query,
        entryPoints,
        subgraph,
        codeBlocks,
        sourceCompleteness,
        semanticRelationCount: subgraph.hyperedges?.length ?? 0,
        searchRankingReasons: subgraph.searchRankingReasons,
      }),
      relatedFiles,
      summary,
      ...(overview ? { overview } : {}),
      stats,
    };

    this.attachContextBudget(context, this.estimateFormattedContextChars(context, opts));

    // Return formatted output or raw context
    if (opts.format === 'markdown') {
      if (opts.detailLevel === 'minimal') {
        return formatContextAsMinimalMarkdown(context, opts.redaction);
      }
      return formatContextAsMarkdown(context, opts.redaction) + this.buildCallPathsSection(subgraph) + this.buildScipFactsSection(subgraph);
    } else if (opts.format === 'json') {
      if (opts.detailLevel === 'minimal') {
        return formatContextAsMinimalJson(context, opts.redaction);
      }
      return formatContextAsJson(context, opts.redaction);
    }

    return context;
  }

  private attachContextBudget(context: TaskContext, outputChars: number): void {
    try {
      context.contextBudget = this.buildCandidateFilesBudget(context.relatedFiles, outputChars);
    } catch {
      try {
        context.contextBudget = buildContextBudget({
          baselineKind: 'not_available',
          outputChars,
          notes: ['Context budget calculation failed; normal context output was preserved.'],
        });
      } catch {
      }
    }
  }

  private buildCandidateFilesBudget(relatedFiles: string[], outputChars: number): ContextBudget {
    const baselineChars = this.readCandidateFilesBaselineChars(relatedFiles);
    if (baselineChars === null) {
      return buildContextBudget({
        baselineKind: 'not_available',
        outputChars,
        notes: ['No readable candidate-file baseline was available for this context.'],
      });
    }

    return buildContextBudget({
      baselineKind: 'candidate_files',
      baselineChars,
      outputChars,
      notes: ['Estimated against the readable related files selected for this context, not the whole repository.'],
    });
  }

  private readCandidateFilesBaselineChars(relatedFiles: string[]): number | null {
    if (relatedFiles.length === 0) return null;

    let total = 0;
    for (const file of relatedFiles) {
      const absolutePath = this.resolveIndexedPath(file);
      if (!absolutePath) return null;
      try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) return null;
        total += fs.readFileSync(absolutePath, 'utf8').length;
      } catch {
        return null;
      }
    }
    return total;
  }

  private estimateFormattedContextChars(context: TaskContext, opts: BuildContextOptions): number {
    try {
      if ((opts.format ?? 'markdown') === 'markdown') {
        if (opts.detailLevel === 'minimal') {
          return formatContextAsMinimalMarkdown(context, opts.redaction).length;
        }
        return (formatContextAsMarkdown(context, opts.redaction) + this.buildCallPathsSection(context.subgraph) + this.buildScipFactsSection(context.subgraph)).length;
      }

      if (opts.detailLevel === 'minimal') {
        return formatContextAsMinimalJson(context, opts.redaction).length;
      }
      return formatContextAsJson(context, opts.redaction).length;
    } catch {
      return context.summary.length + context.stats.totalCodeSize;
    }
  }

  private buildScipFactsSection(subgraph: Subgraph): string {
    const SCIP_FACT_SAMPLE_LIMIT = 5;
    const nodes = [...subgraph.nodes.values()].filter((node) => node.scipSymbol).slice(0, 8);
    if (nodes.length === 0) return '';
    const names: string[] = [];
    for (const node of nodes) {
      if (!node.scipSymbol) continue;
      const definitions = this.queries.getScipOccurrencesWithDocuments(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'definition');
      const references = this.queries.getScipOccurrencesWithDocuments(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'reference');
      const implementations = this.queries.getScipRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'implementation');
      const typeDefinitions = this.queries.getScipRelationshipsForSymbol(node.scipSymbol, SCIP_FACT_SAMPLE_LIMIT, 'typeDefinition');
      if (definitions.length === 0 && references.length === 0 && implementations.length === 0 && typeDefinitions.length === 0) continue;
      names.push(node.name);
    }
    if (names.length === 0) return '';
    const lines = ['', '## SCIP', '', `Precise refs available for: ${names.join(', ')}.`, '', 'Use `solidkg_precise_refs` for exact locations.'];
    return '\n' + lines.join('\n') + '\n';
  }

  private shouldAttachOverview(query: string, detailLevel: BuildContextOptions['detailLevel']): boolean {
    if (detailLevel !== 'minimal') return false;
    const queryTokens = extractOverviewQueryTokens(query);
    return OVERVIEW_QUERY_TERMS.some((term) => queryTokens.has(term));
  }

  private buildOverviewContext(): NonNullable<TaskContext['overview']> | undefined {
    const files = this.queries.getAllFiles();
    if (files.length === 0) return undefined;
    const architecture = this.queries.getArchitectureReport() ?? undefined;
    const overviewTree = buildOverviewTree({
      files,
      nodes: this.queries.getAllNodes(),
      architectureAssignments: architecture?.fileAssignments,
    });
    return {
      markdown: formatOverviewTree(overviewTree, { maxDepth: 2, maxEntries: 80 }),
      fileCount: overviewTree.totalFiles,
      directoryCount: overviewTree.totalDirectories,
      symbolCount: overviewTree.totalSymbols,
    };
  }

  /**
   * Surface short call-paths among the symbols this context already found,
   * derived in-memory from the subgraph's `calls` edges (no extra queries).
   *
   * This bakes the value of path-finding INTO the always-loaded `context` tool.
   * Agents reliably read context's output but do NOT discover/adopt a standalone
   * trace tool (in deferred-MCP harnesses they only ToolSearch-select tools they
   * already know). Delivering the flow here means "how does X reach Y" is
   * answered without the agent needing to find, load, or choose a new tool.
   * Chains stop where the static call graph ends (e.g. dynamic dispatch) — that
   * truncation is honest, and the agent can solidkg_node the last hop to bridge.
   */
  private buildCallPathsSection(subgraph: Subgraph): string {
    const adj = new Map<string, string[]>();
    for (const e of subgraph.edges) {
      if (e.kind !== 'calls') continue;
      if (!subgraph.nodes.has(e.source) || !subgraph.nodes.has(e.target)) continue;
      const list = adj.get(e.source);
      if (list) list.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    if (adj.size === 0) return '';

    const MAX_HOPS = 6;
    const chains: string[][] = [];
    let budget = 2000; // bound DFS work on dense subgraphs
    const dfs = (id: string, path: string[], seen: Set<string>): void => {
      if (budget-- <= 0) return;
      const next = (adj.get(id) ?? []).filter((t) => !seen.has(t));
      if (next.length === 0 || path.length >= MAX_HOPS) {
        if (path.length >= 3) chains.push([...path]); // >=3 nodes = a real flow, not a single call
        return;
      }
      for (const t of next) {
        seen.add(t);
        dfs(t, [...path, t], seen);
        seen.delete(t);
      }
    };
    const starts = (subgraph.roots.length > 0
      ? subgraph.roots.filter((id) => adj.has(id))
      : [...adj.keys()]
    ).slice(0, 5);
    for (const s of starts) dfs(s, [s], new Set([s]));
    if (chains.length === 0) return '';

    // Keep only chains that connect TWO OR MORE query-relevant symbols (roots).
    // A chain from a root into an arbitrary callee (render → onMagicFrameGenerate)
    // is structurally valid but tangential to the question; requiring ≥2 roots
    // keeps the chain anchored to what the user actually asked about. Rank by
    // #roots then length, and drop any that are a sub-path of a longer kept chain.
    const rootSet = new Set(subgraph.roots);
    const rootCount = (c: string[]): number => c.reduce((n, id) => n + (rootSet.has(id) ? 1 : 0), 0);
    const relevant = chains.filter((c) => rootCount(c) >= 2);
    relevant.sort((a, b) => rootCount(b) - rootCount(a) || b.length - a.length);
    const kept: string[][] = [];
    for (const c of relevant) {
      const key = c.join('>');
      if (kept.some((k) => k.join('>').includes(key))) continue;
      kept.push(c);
      if (kept.length >= 3) break;
    }
    if (kept.length === 0) return '';
    const name = (id: string): string => subgraph.nodes.get(id)?.name ?? id;

    // Synthesized (dynamic-dispatch) hops are real `calls` edges but invisible to
    // static parsing — mark them inline so the agent sees WHERE the callback was
    // wired up (`registered @file:line`) instead of grepping for it. Keyed by
    // "source>target".
    const synthByPair = new Map<string, string>();
    for (const e of subgraph.edges) {
      if (e.kind !== 'calls' || e.provenance !== 'heuristic') continue;
      const m = e.metadata as Record<string, unknown> | undefined;
      if (!m?.synthesizedBy) continue;
      const at = typeof m.registeredAt === 'string' ? ` @${m.registeredAt}` : '';
      const localFlow = this.localFlowLabel(m);
      const label = m.synthesizedBy === 'callback'
        ? `callback (heuristic) via ${m.via ? `\`${String(m.via)}\`` : 'registrar'}${at}`
        : m.synthesizedBy === 'event-emitter'
        ? `event-emitter (heuristic) event ${m.event ? `\`${String(m.event)}\`` : 'event'}${at}`
        : m.synthesizedBy === 'react-render'
        ? `React re-render (heuristic) via ${m.via ? String(m.via) : 'setState'}${at}`
        : m.synthesizedBy === 'jsx-render'
        ? `jsx-render (heuristic) <${String(m.via || 'child')}>${at}${localFlow ? `; ${localFlow}` : ''}`
        : m.synthesizedBy === 'vue-handler'
        ? `vue-handler (heuristic) @${String(m.event || 'event')}${at}`
        : m.synthesizedBy === 'interface-impl'
        ? `interface-impl (heuristic)${m.via ? ` via \`${String(m.via)}\`` : ''}${at}`
        : m.synthesizedBy === 'rn-event-channel'
        ? `rn-event-channel (heuristic) event ${m.event ? `\`${String(m.event)}\`` : 'native event'}${at}`
        : m.synthesizedBy === 'fabric-native-impl'
        ? `fabric-native-impl (heuristic) ${m.componentName ? `\`${String(m.componentName)}\`` : 'Fabric component'}${at}`
        : m.synthesizedBy === 'flutter-build'
        ? `flutter-build (heuristic) via ${m.via ? String(m.via) : 'setState'}${at}`
        : m.synthesizedBy === 'cpp-override'
        ? `cpp-override (heuristic)${m.via ? ` via \`${String(m.via)}\`` : ''}${at}`
        : null;
      if (!label) continue;
      synthByPair.set(`${e.source}>${e.target}`, label);
    }
    const renderChain = (c: string[]): string => {
      let s = name(c[0]!);
      for (let i = 1; i < c.length; i++) {
        const synth = synthByPair.get(`${c[i - 1]}>${c[i]}`);
        s += synth ? ` →[${synth}] ${name(c[i]!)}` : ` → ${name(c[i]!)}`;
      }
      return s;
    };
    const hasSynth = kept.some((c) => c.some((_, i) => i > 0 && synthByPair.has(`${c[i - 1]}>${c[i]}`)));
    const lines = [
      '',
      '## Call paths',
      '',
      'Execution flow among the key symbols (traced through the call graph):',
      '',
      ...kept.map((c) => `- ${renderChain(c)}`),
      '',
      hasSynth
        ? '_Hops marked `[... (heuristic) ...]` are dynamic-dispatch bridges from synthesized heuristic edges (includes evidence atom like `via`/`event` and registration site when present); the rest are direct calls. If source is still missing, use one focused solidkg_explore for several symbols or solidkg_node for one specific missing hop._'
        : '_If source is still missing, use one focused solidkg_explore for several symbols or solidkg_node for one specific missing hop._',
    ];
    return '\n' + lines.join('\n') + '\n';
  }

  private mergeSearchRankingReasons(
    left: readonly SearchRankingReason[] | undefined,
    right: readonly SearchRankingReason[] | undefined,
  ): readonly SearchRankingReason[] | undefined {
    if (!left && !right) return undefined;
    const byKey = new Map<string, SearchRankingReason>();
    for (const reason of [...(left ?? []), ...(right ?? [])]) {
      const key = `${reason.kind}:${reason.evidence ?? reason.label}`;
      const existing = byKey.get(key);
      if (!existing || reason.weight > existing.weight) byKey.set(key, reason);
    }
    return [...byKey.values()].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
  }

  private collectSearchRankingReasons(results: readonly SearchResult[]): readonly SearchRankingReason[] {
    return this.mergeSearchRankingReasons(undefined, results.flatMap((result) => result.rankingReasons ?? [])) ?? [];
  }

  private localFlowLabel(metadata: Record<string, unknown>): string | null {
    const localFlow = metadata.localFlow;
    if (!localFlow || typeof localFlow !== 'object') return null;
    const candidate = localFlow as Record<string, unknown>;
    if (candidate.kind !== 'jsx-prop-handoff') return null;
    const props = Array.isArray(candidate.props)
      ? candidate.props.filter((prop): prop is string => typeof prop === 'string' && prop.length > 0)
      : [];
    if (props.length === 0) return null;
    const confidence = typeof candidate.confidence === 'number'
      ? `, confidence ${candidate.confidence.toFixed(2)}`
      : '';
    const capped = candidate.capped === true ? ', capped' : '';
    return `local prop handoff ${props.map((prop) => `\`${prop}\``).join(', ')} (heuristic incomplete${confidence}${capped})`;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

    // Start with empty subgraph
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];

    // Handle empty query - return empty subgraph
    if (!query || query.trim().length === 0) {
      return { nodes, edges, roots };
    }

    // === HYBRID SEARCH ===

    // Step 1: Extract potential symbol names from query
    const mcpToolHandlerAliases = new Set(extractMcpToolHandlerAliases(query).map(alias => alias.toLowerCase()));
    const symbolsFromQuery = extractSymbolsFromQuery(query);
    const qualifiedSymbolsFromQuery = extractQualifiedSymbolsFromQuery(query);
    const retrievalTerms = selectRetrievalSearchTerms(query, 4);
    logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

    // Step 2: Look up exact matches for extracted symbols
    let exactMatches: SearchResult[] = [];
    const mcpToolHandlerFiles = new Set<string>();
    if (symbolsFromQuery.length > 0) {
      try {
        // Get more results so we can apply co-location boosting before trimming
        exactMatches = this.queries.findNodesByExactName(symbolsFromQuery, {
          limit: Math.ceil(opts.searchLimit * 5),
          kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        });
        exactMatches = exactMatches.map(result => ({
          ...result,
          score: result.score
            + kindBonus(result.node.kind)
            + nameMatchBonus(result.node.name, query)
            + scorePathRelevance(result.node.filePath, query)
            + exactSymbolIntentBonus(result.node, symbolsFromQuery),
        }));

        const exactFileTokens = extractExactFileIntentTokens(query);
        if (exactFileTokens.size > 0) {
          const existingById = new Map(exactMatches.map(result => [result.node.id, result]));
          for (const symbol of symbolsFromQuery) {
            const fileScopedMatches = this.queries.findNodesByExactName([symbol], {
              limit: Math.max(50, opts.searchLimit * 50),
              kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
            });
            for (const match of fileScopedMatches) {
              if (!matchesExactFileIntent(match.node, exactFileTokens)) continue;
              const scoredMatch = {
                ...match,
                score: match.score
                  + 250
                  + kindBonus(match.node.kind)
                  + nameMatchBonus(match.node.name, query)
                  + scorePathRelevance(match.node.filePath, query)
                  + exactSymbolIntentBonus(match.node, symbolsFromQuery),
              };
              const existing = existingById.get(scoredMatch.node.id);
              if (existing) {
                existing.score = Math.max(existing.score, scoredMatch.score);
              } else {
                exactMatches.push(scoredMatch);
                existingById.set(scoredMatch.node.id, scoredMatch);
              }
            }
          }
        }

        if (mcpToolHandlerAliases.size > 0) {
          exactMatches = exactMatches.map(r => (
            mcpToolHandlerAliases.has(r.node.name.toLowerCase())
              ? { ...r, score: r.score + 120 }
              : r
          ));
          for (const match of exactMatches) {
            if (mcpToolHandlerAliases.has(match.node.name.toLowerCase())) {
              mcpToolHandlerFiles.add(match.node.filePath);
            }
          }
          if (mcpToolHandlerFiles.size > 0) {
            exactMatches = exactMatches.filter(result => mcpToolHandlerFiles.has(result.node.filePath));
          }
        }

        // Co-location boost: when multiple extracted symbols appear in the same file,
        // those results are much more likely to be what the user is looking for.
        // E.g., "scrapeLoop" + "run" both in scrape/scrape.go → boost both.
        if (exactMatches.length > 1) {
          // Build a map of files → how many distinct symbol names matched in that file
          const fileSymbolCounts = new Map<string, Set<string>>();
          for (const r of exactMatches) {
            const names = fileSymbolCounts.get(r.node.filePath) || new Set();
            names.add(r.node.name.toLowerCase());
            fileSymbolCounts.set(r.node.filePath, names);
          }
          // Boost results in files where multiple query symbols co-occur
          exactMatches = exactMatches.map(r => {
            const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
            return {
              ...r,
              score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score,
            };
          });
          exactMatches.sort((a, b) => b.score - a.score);
        }

        // Trim back to reasonable size
        exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
        logDebug('Exact symbol matches', { count: exactMatches.length });
      } catch (error) {
        logDebug('Exact symbol lookup failed', { error: String(error) });
      }
    }

    const qualifiedMatchIds = new Set<string>();
    if (qualifiedSymbolsFromQuery.length > 0) {
      const candidateKinds = opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined;
      const qualifiedMatches: SearchResult[] = [];

      for (const qualifiedSymbol of qualifiedSymbolsFromQuery) {
        const parts = qualifiedSymbol.split('.').filter(Boolean);
        const leaf = parts[parts.length - 1];
        if (!leaf) continue;

        const candidates = this.queries.findNodesByExactName([leaf], {
          limit: Math.max(50, opts.searchLimit * 20),
          kinds: candidateKinds,
        });

        for (const candidate of candidates) {
          const qualifiedScore = scoreQualifiedSymbolMatch(candidate.node, qualifiedSymbol);
          if (qualifiedScore > 0) {
            qualifiedMatchIds.add(candidate.node.id);
            qualifiedMatches.push({
              ...candidate,
              score: candidate.score + qualifiedScore,
            });
          }
        }
      }

      if (qualifiedMatches.length > 0) {
        const existingById = new Map(exactMatches.map(result => [result.node.id, result]));
        for (const match of qualifiedMatches) {
          const existing = existingById.get(match.node.id);
          if (existing) {
            existing.score = Math.max(existing.score, match.score);
          } else {
            exactMatches.push(match);
            existingById.set(match.node.id, match);
          }
        }
        exactMatches.sort((a, b) => b.score - a.score);
        exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
        logDebug('Qualified symbol matches', { count: qualifiedMatches.length });
      }
    }

    // Step 2b: Search for extracted symbols as definition (class/interface) prefixes.
    // When the user writes "REST", "bulk", or "allocation", they usually mean classes
    // like RestController, BulkRequest, AllocationService — not nodes named exactly that.
    // Also tries stem variants: "caching" → "cache" finds Cache, CacheBuilder.
    if (symbolsFromQuery.length > 0) {
      const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      // Expand symbols with stem variants for broader definition matching
      const expandedSymbols = new Set(retrievalTerms);
      for (const sym of retrievalTerms) {
        for (const variant of getStemVariants(sym)) {
          expandedSymbols.add(variant);
        }
      }
      for (const sym of expandedSymbols) {
        // Title-case the symbol: "REST" → "Rest", "bulk" → "Bulk", "allocation" → "Allocation"
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased === sym) continue; // already title-case (e.g., "Engine") — handled by exact match
        // Fetch more results since popular prefixes have many matches
        const prefixResults = this.queries.searchNodes(titleCased, {
          limit: 30,
          kinds: definitionKinds,
        });
        const matched: SearchResult[] = [];
        for (const r of prefixResults) {
          if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
            // Favor shorter names: "AllocationService" (18 chars) over
            // "AllocationBalancingRoundMetrics" (31 chars). Core classes tend
            // to have concise names; test/helper classes are verbose.
            const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
            matched.push({ ...r, score: r.score + 15 + brevityBonus });
          }
        }
        matched.sort((a, b) => b.score - a.score);
        for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
          const existing = exactMatches.find(e => e.node.id === r.node.id);
          if (!existing) {
            exactMatches.push(r);
          }
        }
      }
      exactMatches.sort((a, b) => b.score - a.score);
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
    }

    // Step 3: Run text search for natural language term matching
    // This catches file-name and node-name matches that semantic search may miss,
    // which is critical for template-heavy codebases (e.g., Liquid/Shopify themes)
    // where file names are the primary identifiers.
    const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
      ? opts.nodeKinds
      : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
         'function', 'method', 'property', 'field', 'variable', 'constant',
         'enum', 'enum_member', 'type_alias', 'namespace', 'export',
         'route', 'component'] as NodeKind[];
    let fullQueryResults: SearchResult[] = [];
    let textResults: SearchResult[] = [];
    try {
      fullQueryResults = this.queries.searchNodes(query, {
        limit: opts.searchLimit * 2,
        kinds: searchKinds,
      });
      if (mcpToolHandlerFiles.size > 0) {
        fullQueryResults = fullQueryResults.filter(result => mcpToolHandlerFiles.has(result.node.filePath));
      }
      const searchTerms = retrievalTerms;
      if (searchTerms.length > 0) {
        // Search each term individually to get broader coverage,
        // then boost results that match multiple terms
        const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
        // When no explicit kind filter is set, exclude imports — they flood FTS
        // results with qualified name matches (e.g., "REST" matches 445K import paths)
        // but are almost never what exploration queries want.
        for (const term of searchTerms) {
          const termResults = this.queries.searchNodes(term, {
            limit: opts.searchLimit * 2,
            kinds: searchKinds,
          });
          for (const r of termResults) {
            const existing = termResultsMap.get(r.node.id);
            if (existing) {
              existing.termHits++;
              existing.result.score = Math.max(existing.result.score, r.score);
            } else {
              termResultsMap.set(r.node.id, { result: r, termHits: 1 });
            }
          }
        }
        // Boost results matching multiple terms and sort
        textResults = Array.from(termResultsMap.values())
          .map(({ result, termHits }) => ({
            ...result,
            score: result.score + (termHits - 1) * 5,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.searchLimit * 2);

        if (mcpToolHandlerFiles.size > 0) {
          textResults = textResults.filter(result => mcpToolHandlerFiles.has(result.node.filePath));
        }
      }
      logDebug('Text search results', { count: textResults.length });
    } catch (error) {
      logDebug('Text search failed', { query, error: String(error) });
    }

    // Step 4: Merge results, taking the max score when duplicates appear
    // across search channels. Exact matches may have lower scores than FTS
    // results for the same node — use the best score from any channel.
    const resultById = new Map<string, SearchResult>();
    let searchResults: SearchResult[] = [];

    // Add exact matches first
    for (const result of exactMatches) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    for (const result of fullQueryResults) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
        existing.rankingReasons = this.mergeSearchRankingReasons(existing.rankingReasons, result.rankingReasons);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    // Add text search results, upgrading scores for duplicates
    for (const result of textResults) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
        existing.rankingReasons = this.mergeSearchRankingReasons(existing.rankingReasons, result.rankingReasons);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
    const isGeneratedQuery = isGeneratedFileQuery(query);
    const isBehaviorQuery = this.isBehaviorQuery(queryLower);

    // Deprioritize test files early so they don't take multi-term boost slots
    if (!isTestQuery) {
      for (const result of searchResults) {
        if (isTestFile(result.node.filePath)) {
          result.score *= 0.3;
        }
        if (!isGeneratedQuery && isGeneratedFile(result.node.filePath)) {
          result.score *= 0.2;
        }
      }
    }

    // Step 5a: Multi-term co-occurrence re-ranking (applied BEFORE truncation).
    // For multi-word queries like "search execution from request to shard",
    // nodes matching 2+ query terms in their name or path are far more relevant
    // than nodes matching just one generic term. Without this, "ExecutionUtils"
    // (matches only "execution") fills budget slots meant for "ShardSearchRequest"
    // (matches "shard" + "search" + "request").
    const queryTermsForBoost = extractSearchTerms(query);
    if (queryTermsForBoost.length >= 2) {
      // Group terms that are substrings of each other (stem variants of the same
      // root word). "indexed", "indexe", "index" should count as ONE concept match,
      // not three. Without this, stem variants inflate matchCount and give false
      // multi-term boosts to symbols matching one root word multiple times.
      const termGroups: string[][] = [];
      const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
      const assigned = new Set<string>();
      for (const term of sorted) {
        if (assigned.has(term)) continue;
        const group = [term];
        assigned.add(term);
        for (const other of sorted) {
          if (assigned.has(other)) continue;
          if (term.includes(other) || other.includes(term)) {
            group.push(other);
            assigned.add(other);
          }
        }
        termGroups.push(group);
      }

      // Build a set of exact-match node IDs so we can exempt them from dampening.
      // When the query is "LiveEditMode DevServerPreview", these are specific
      // symbols the user asked for — dampening them because they only match 1
      // term group is counter-productive.
      const exactMatchIds = new Set(exactMatches.map(r => r.node.id));

      for (const result of searchResults) {
        // Check term matches in name (substring) and path DIRECTORIES (exact).
        // Directory segments must match exactly — "search" matches directory
        // "search/" but NOT "elasticsearch/". The class name is checked
        // separately via substring match on the node name.
        const nameLower = result.node.name.toLowerCase();
        const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
        let matchCount = 0;
        for (const group of termGroups) {
          const groupMatches = group.some(term => {
            const inName = nameLower.includes(term);
            const inDir = dirSegments.some(seg => seg === term);
            return inName || inDir;
          });
          if (groupMatches) matchCount++;
        }
        if (matchCount >= 2) {
          // Multiplicative boost — 2 terms → 2x, 3 terms → 2.5x
          result.score *= 1 + matchCount * 0.5;
        } else if (!exactMatchIds.has(result.node.id)) {
          // Mild dampen for single-term matches — they might be generic
          // but could also be the right result (e.g., "Protocol" class for an IPC query).
          // Exempt exact name matches: they are specific symbols the user queried for.
          result.score *= 0.6;
        }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    if (isBehaviorQuery) {
      for (const result of searchResults) {
        result.score *= this.behaviorKindMultiplier(result.node.kind);
      }
      searchResults.sort((a, b) => b.score - a.score || this.behaviorKindMultiplier(b.node.kind) - this.behaviorKindMultiplier(a.node.kind));
    }

    // Step 5b: CamelCase-boundary matching via LIKE query.
    // FTS can't find "Search" inside "TransportSearchAction" (one FTS token).
    // LIKE reliably finds these substring matches. Results are appended with
    // guaranteed slots so they don't compete with higher-scoring prefix matches.
    if (symbolsFromQuery.length > 0) {
      const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      const camelSearchedTerms = new Set<string>();
      const searchIdSet = new Set(searchResults.map(r => r.node.id));
      // Track per-node term hits for multi-term boosting
      const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
      const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);

      for (const sym of retrievalTerms) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;
        const termKey = titleCased.toLowerCase();
        if (camelSearchedTerms.has(termKey)) continue;
        camelSearchedTerms.add(termKey);

        // Fetch a large batch — popular terms like "Search" in Elasticsearch
        // have hundreds of substring matches. The LIKE scan cost is the same
        // regardless of LIMIT (SQLite scans all matches to sort), so we fetch
        // generously and let path-relevance scoring pick the best ones.
        const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelDefinitionKinds,
          excludePrefix: true,
        });

        // Filter to CamelCase boundaries, score by path relevance, and take top N
        const termCandidates: SearchResult[] = [];
        for (const r of likeResults) {
          const name = r.node.name;
          const idx = name.indexOf(titleCased);
          if (idx <= 0) continue;
          // Accept CamelCase boundary (lowercase before match) OR
          // acronym boundary (uppercase before match, e.g., RPCProtocol)
          if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;

          const pathScore = scorePathRelevance(r.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
          termCandidates.push({ node: r.node, score: 8 + brevityBonus + pathScore });
        }
        termCandidates.sort((a, b) => b.score - a.score);

        // Widen the per-term pool for accumulation so multi-term co-occurrences
        // can be discovered. A class matching 3 query terms at CamelCase boundaries
        // is far more relevant than one matching just 1, but it needs to survive
        // the per-term cut for EACH term to accumulate its count.
        const accumPerTerm = maxCamelPerTerm * 4;
        for (const r of termCandidates.slice(0, accumPerTerm)) {
          const existing = camelNodeTerms.get(r.node.id);
          if (existing) {
            existing.termCount++;
          } else {
            camelNodeTerms.set(r.node.id, {
              result: r,
              termCount: 1,
            });
          }
        }
      }

      // Append CamelCase matches with multi-term boost.
      // These are structurally important (class names containing query terms at
      // CamelCase boundaries) but score much lower than FTS results. Scale their
      // scores up so multi-term CamelCase matches can compete with FTS results.
      const camelResults: SearchResult[] = [];
      for (const [, info] of camelNodeTerms) {
        // Multi-term CamelCase matches are extremely relevant — a class matching
        // 3+ query terms in its name (e.g., ExtensionHostProcess) is almost
        // certainly what the user wants. Scale aggressively.
        info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
        camelResults.push(info.result);
      }
      camelResults.sort((a, b) => b.score - a.score);
      const maxCamelTotal = opts.searchLimit;
      for (const r of camelResults.slice(0, maxCamelTotal)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }

      // Step 5c: Compound term matching — find classes whose name contains 2+
      // query terms at ANY position (not just CamelCase boundaries).
      // The CamelCase step above requires idx > 0, which misses classes that
      // START with a query term (e.g., "SearchShardsRequest" starts with "Search").
      // For multi-word queries, a class matching multiple query terms in its name
      // is almost certainly relevant regardless of position.
      if (retrievalTerms.length >= 2) {
        // Collect ALL LIKE results per term (reusing findNodesByNameSubstring)
        // but without the CamelCase boundary or prefix exclusion filters.
        const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
        for (const sym of retrievalTerms) {
          const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
          if (titleCased.length < 3) continue;

          const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelDefinitionKinds,
            excludePrefix: false,
          });

          for (const r of likeResults) {
            if (searchIdSet.has(r.node.id)) continue;
            if (isTestFile(r.node.filePath) && !isTestQuery) continue;
            const entry = compoundTermMap.get(r.node.id);
            if (entry) {
              entry.terms.add(titleCased);
            } else {
              compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
            }
          }
        }

        // Keep only nodes matching 2+ distinct terms
        const compoundResults: SearchResult[] = [];
        for (const [, entry] of compoundTermMap) {
          if (entry.terms.size >= 2) {
            const pathScore = scorePathRelevance(entry.node.filePath, query);
            const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
            compoundResults.push({
              node: entry.node,
              score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus,
            });
          }
        }
        compoundResults.sort((a, b) => b.score - a.score);
        const maxCompound = Math.ceil(opts.searchLimit / 2);
        for (const r of compoundResults.slice(0, maxCompound)) {
          searchResults.push(r);
          searchIdSet.add(r.node.id);
        }
      }
    }

    if (this.isApplyContentRecoveryQuery(queryLower)) {
      const centralMatches = this.findFirstExactMatchPerName(
        APPLY_CONTENT_RECOVERY_ENTRY_NAMES,
        opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      );
      const searchIdSet = new Set(searchResults.map(result => result.node.id));
      for (const match of centralMatches) {
        const existing = searchResults.find(result => result.node.id === match.node.id);
        if (existing) {
          existing.score = Math.max(existing.score, match.score + this.applyContentRecoveryScore(match.node));
        } else if (!searchIdSet.has(match.node.id)) {
          searchResults.push({
            ...match,
            score: match.score + this.applyContentRecoveryScore(match.node),
          });
          searchIdSet.add(match.node.id);
        }
      }
      for (const result of searchResults) {
        result.score += this.applyContentRecoveryScore(result.node);
      }
    }

    if (isCurationOperationAliasQuery(queryLower)) {
      const aliasMatches = this.findFirstExactMatchPerName(
        CURATION_OPERATION_ALIAS_NAMES,
        opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
      );
      const searchIdSet = new Set(searchResults.map(result => result.node.id));
      for (const match of aliasMatches) {
        const existing = searchResults.find(result => result.node.id === match.node.id);
        if (existing) {
          existing.score = Math.max(existing.score, match.score + this.curationOperationAliasScore(match.node));
        } else if (!searchIdSet.has(match.node.id)) {
          searchResults.push({
            ...match,
            score: match.score + this.curationOperationAliasScore(match.node),
          });
          searchIdSet.add(match.node.id);
        }
      }
      for (const result of searchResults) {
        result.score += this.curationOperationAliasScore(result.node);
      }
    }

    // Final sort and truncation — all search channels (exact, text, CamelCase,
    // compound) have now contributed. Sort by score so multi-term matches from
    // later steps can outrank dampened single-term matches from earlier steps.
    searchResults.sort((a, b) => {
      const qualifiedDelta = Number(qualifiedMatchIds.has(b.node.id)) - Number(qualifiedMatchIds.has(a.node.id));
      return qualifiedDelta || b.score - a.score;
    });
    searchResults = searchResults.slice(0, opts.searchLimit * 3);

    searchResults = this.applyRootScopedFailClosedFilter(query, searchResults);

    // Filter by minimum score
    let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);
    if (mcpToolHandlerFiles.size > 0) {
      filteredResults = filteredResults.filter(result =>
        mcpToolHandlerFiles.has(result.node.filePath) && mcpToolHandlerAliases.has(result.node.name.toLowerCase())
      );
    }

    // Resolve imports/exports to their actual definitions
    // If someone searches "terminal" and finds `import { TerminalPanel }`,
    // they want the TerminalPanel class, not the import statement
    filteredResults = this.resolveImportsToDefinitions(filteredResults);

    // Cap entry points so traversal budget isn't spread too thin.
    // With 36 entry points and maxNodes=120, each gets only 3 nodes — useless.
    // Cap to searchLimit so each entry point gets a meaningful traversal budget.
    const entryPointLimit = this.isApplyContentRecoveryQuery(queryLower)
      ? Math.max(opts.searchLimit, APPLY_CONTENT_RECOVERY_ENTRY_NAMES.length)
      : opts.searchLimit;
    if (filteredResults.length > entryPointLimit) {
      filteredResults = filteredResults.slice(0, entryPointLimit);
    }

    // Add entry points to subgraph
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Expand type hierarchy for class/interface entry points.
    // BFS often exhausts its per-entry-point budget on contained methods
    // before reaching extends/implements neighbors. This dedicated step
    // ensures subclasses and superclasses always appear in results.
    // Budget: up to maxNodes/4 hierarchy nodes to avoid flooding.
    const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
    const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
    let hierarchyNodesAdded = 0;
    for (const result of filteredResults) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      if (typeHierarchyKinds.has(result.node.kind)) {
        const hierarchy = this.traverser.getTypeHierarchy(result.node.id);
        for (const [id, node] of hierarchy.nodes) {
          if (!nodes.has(id)) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of hierarchy.edges) {
          const exists = edges.some(
            (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
          );
          if (!exists) {
            edges.push(edge);
          }
        }
      }
    }

    // Pass 2: expand hierarchy of newly-discovered parent types to find siblings.
    // E.g., InternalEngine → Engine (parent, from pass 1) → ReadOnlyEngine (sibling).
    if (hierarchyNodesAdded > 0) {
      const pass2Candidates = [...nodes.values()].filter(
        n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
      );
      for (const candidate of pass2Candidates) {
        if (hierarchyNodesAdded >= maxHierarchyNodes) break;
        const siblingHierarchy = this.traverser.getTypeHierarchy(candidate.id);
        for (const [id, node] of siblingHierarchy.nodes) {
          if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of siblingHierarchy.edges) {
          if (nodes.has(edge.source) && nodes.has(edge.target)) {
            const exists = edges.some(
              (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
            );
            if (!exists) {
              edges.push(edge);
            }
          }
        }
      }
    }

    // Traverse from each entry point
    for (const result of filteredResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });

      // Merge nodes
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
      }

      // Merge edges (avoid duplicates)
      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // Trim to max nodes if needed
    let finalNodes = nodes;
    let finalEdges = edges;
    if (nodes.size > opts.maxNodes) {
      // Prioritize entry points and their direct neighbors
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) {
          priorityIds.add(edge.target);
        }
        if (priorityIds.has(edge.target)) {
          priorityIds.add(edge.source);
        }
      }

      // Keep priority nodes, then fill remaining slots
      finalNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && finalNodes.size < opts.maxNodes) {
          finalNodes.set(id, node);
        }
      }

      // Fill remaining from other nodes
      for (const [id, node] of nodes) {
        if (finalNodes.size >= opts.maxNodes) break;
        if (!finalNodes.has(id)) {
          finalNodes.set(id, node);
        }
      }

      // Filter edges to only include kept nodes
      finalEdges = edges.filter(
        (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
      );
    }

    // Per-file diversity cap: prevent any single file from monopolizing the
    // node budget. When BFS traverses from a method, it follows `contains`
    // to the parent class, then back down to all sibling methods. With
    // multiple entry points in the same class, one file can consume 30-40%
    // of maxNodes. Cap each file to ~20% to ensure cross-file diversity.
    const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
    const fileCounts = new Map<string, string[]>();
    for (const [id, node] of finalNodes) {
      const ids = fileCounts.get(node.filePath) || [];
      ids.push(id);
      fileCounts.set(node.filePath, ids);
    }
    const rootSet = new Set(roots);
    for (const [, nodeIds] of fileCounts) {
      if (nodeIds.length <= maxPerFile) continue;
      // Sort: entry points first, then classes/interfaces, then others
      const kindPriority: Record<string, number> = {
        class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
        method: 1, function: 1, property: 0, field: 0, variable: 0,
      };
      nodeIds.sort((a, b) => {
        const aRoot = rootSet.has(a) ? 10 : 0;
        const bRoot = rootSet.has(b) ? 10 : 0;
        const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
        const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
        return (bRoot + bKind) - (aRoot + aKind);
      });
      // Remove excess nodes (keep the highest-priority ones)
      for (const id of nodeIds.slice(maxPerFile)) {
        finalNodes.delete(id);
      }
    }
    // Non-production node cap: limit test/sample/integration/example files to
    // at most 15% of the budget. Many codebases have dozens of near-identical
    // test implementations (e.g., 6 Guard classes in integration tests) that
    // individually survive score dampening but collectively flood the result.
    // Test entry points are NOT exempt — they should be evicted too.
    if (!isTestQuery) {
      const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
      const nonProdIds: string[] = [];
      for (const [id, node] of finalNodes) {
        if (isTestFile(node.filePath)) {
          nonProdIds.push(id);
        }
      }
      if (nonProdIds.length > maxNonProd) {
        for (const id of nonProdIds.slice(maxNonProd)) {
          finalNodes.delete(id);
          // Also remove from roots — test file entry points shouldn't anchor results
          const rootIdx = roots.indexOf(id);
          if (rootIdx !== -1) roots.splice(rootIdx, 1);
        }
      }
    }

    // Re-filter edges after per-file and non-production caps
    finalEdges = finalEdges.filter(
      (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
    );

    // Edge recovery: BFS with many entry points leaves most nodes disconnected.
    // Discover edges between already-selected nodes to recover connectivity.
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = this.queries.findEdgesBetweenNodes(
      [...finalNodes.keys()],
      recoveryKinds,
    );
    const existingEdgeKeys = new Set(
      finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`)
    );
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingEdgeKeys.has(key)) {
        finalEdges.push(edge);
        existingEdgeKeys.add(key);
      }
    }

    const hyperedges = this.selectSemanticRelations(finalNodes, opts.maxNodes);
    const searchRankingReasons = this.collectSearchRankingReasons(filteredResults);
    const chunkEvidenceNodeIds = filteredResults
      .filter((result) => result.rankingReasons?.some((reason) => reason.kind === 'source_body_chunk'))
      .filter((result) => !result.rankingReasons?.some((reason) => reason.kind === 'exact_symbol' || reason.kind === 'exact_path'))
      .map((result) => result.node.id);

    return {
      nodes: finalNodes,
      edges: finalEdges,
      roots,
      ...(hyperedges.length > 0 ? { hyperedges } : {}),
      ...(searchRankingReasons.length > 0 ? { searchRankingReasons } : {}),
      ...(chunkEvidenceNodeIds.length > 0 ? { chunkEvidenceNodeIds } : {}),
    };
  }

  private selectSemanticRelations(
    finalNodes: Map<string, Node>,
    maxNodes: number
  ): HyperedgeRelation[] {
    if (finalNodes.size < 2) return [];

    const relations = this.queries.findHyperedgesBetweenNodes(
      [...finalNodes.keys()],
      DEFAULT_SEMANTIC_KINDS,
    );

    if (relations.length === 0) return [];

    const sortedRelations = [...relations].sort((a, b) =>
      a.hyperedge.kind.localeCompare(b.hyperedge.kind) ||
      a.hyperedge.id.localeCompare(b.hyperedge.id)
    );

    for (const relation of sortedRelations) {
      const sortedMembers = [...relation.members].sort((a, b) =>
        a.ordinal - b.ordinal ||
        a.role.localeCompare(b.role) ||
        a.node.name.localeCompare(b.node.name) ||
        a.nodeId.localeCompare(b.nodeId)
      );
      relation.members = sortedMembers;

      for (const member of sortedMembers) {
        if (finalNodes.has(member.nodeId)) continue;
        if (!HIGH_VALUE_RELATION_MEMBER_ROLES.has(member.role)) continue;
        if (finalNodes.size >= maxNodes) break;
        finalNodes.set(member.nodeId, member.node);
      }
    }

    return sortedRelations;
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return this.extractNodeCode(node);
  }

  /**
   * Extract code from a node's source file
   */
  private async extractNodeCode(node: Node): Promise<string | null> {
    const filePath = this.resolveIndexedPath(node.filePath);

    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract lines (1-indexed to 0-indexed)
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(lines.length, node.endLine);

      return lines.slice(startIdx, endIdx).join('\n');
    } catch (error) {
      logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
      return null;
    }
  }

  /**
   * Get entry points from a subgraph (the root nodes)
   */
  private getEntryPoints(subgraph: Subgraph): Node[] {
    return subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);
  }

  /**
   * Extract code blocks for key nodes in the subgraph
   */
  private async extractCodeBlocks(
    subgraph: Subgraph,
    maxBlocks: number,
    maxBlockSize: number,
    query: string
  ): Promise<CodeBlock[]> {
    const blocks: CodeBlocksWithSourceCompleteness = [];
    const priorityNodes = this.getPriorityCodeNodes(subgraph, query);
    let unreadableBlocks = 0;

    // Extract code for priority nodes
    for (const node of priorityNodes) {
      if (blocks.length + unreadableBlocks >= maxBlocks) break;

      const code = await this.extractNodeCode(node);
      if (!code) {
        unreadableBlocks++;
        continue;
      }

      // Truncate if too long. Language-neutral marker (no `//` — not a
      // comment in Python, Ruby, etc.); this renders inside a fenced
      // source block whose language varies.
      const isTruncated = code.length > maxBlockSize;
      const content = isTruncated
        ? code.slice(0, maxBlockSize) + '\n... (truncated) ...'
        : code;
      const block: CodeBlockWithSourceCompleteness = {
        content,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: node.language,
        node,
        sourceCompleteness: isTruncated ? 'truncated' : 'complete',
        sourceOriginalChars: code.length,
        sourceReturnedChars: content.length,
      };

      blocks.push(block);
    }

    blocks.sourceCompleteness = this.summarizeSourceCompleteness(
      priorityNodes.length,
      blocks,
      unreadableBlocks,
      maxBlocks,
      maxBlockSize,
    );

    return blocks;
  }

  private getPriorityCodeNodes(subgraph: Subgraph, query: string = ''): Node[] {
    const priorityNodes: Node[] = [];
    const seen = new Set<string>();
    const rootOrder = new Map<string, number>();
    subgraph.roots.forEach((id, index) => rootOrder.set(id, index));
    const exactFileTokens = extractExactFileIntentTokens(query);
    const exactSymbolTokens = new Set(extractSymbolsFromQuery(query).map(symbol => symbol.toLowerCase()));
    const generatedQuery = isGeneratedFileQuery(query);

    const addNode = (node: Node | undefined): void => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);
      priorityNodes.push(node);
    };

    // First: entry points
    for (const id of subgraph.roots) {
      addNode(subgraph.nodes.get(id));
    }

    // Then: functions and methods
    for (const node of subgraph.nodes.values()) {
      if (!seen.has(node.id)) {
        if (node.kind === 'function' || node.kind === 'method') {
          addNode(node);
        }
      }
    }

    // Then: classes
    for (const node of subgraph.nodes.values()) {
      if (!seen.has(node.id)) {
        if (node.kind === 'class') {
          addNode(node);
        }
      }
    }

    const sourceIntentScore = (node: Node): number => {
      const normalizedPath = normalizeSourceIntentToken(node.filePath);
      const normalizedQualifiedName = normalizeSourceIntentToken(node.qualifiedName ?? '');
      const basename = basenameOfSourceIntent(normalizedPath);
      const exactFile = exactFileTokens.has(normalizedPath)
        || exactFileTokens.has(normalizedQualifiedName)
        || exactFileTokens.has(basename);
      const exactSymbol = exactSymbolTokens.has(node.name.toLowerCase());
      const rootBoost = rootOrder.has(node.id) ? 4_000 - (rootOrder.get(node.id) ?? 0) : 0;
      const kindBoost = node.kind === 'function' || node.kind === 'method' ? 250 : node.kind === 'class' ? 100 : 0;
      const testPenalty = isTestFile(node.filePath) ? -2_000 : 0;
      const generatedPenalty = !generatedQuery && isGeneratedFile(node.filePath) ? -3_000 : 0;
      return (exactFile ? 10_000 : 0) + (exactSymbol ? 8_000 : 0) + rootBoost + kindBoost + testPenalty + generatedPenalty;
    };

    return priorityNodes.sort((a, b) => sourceIntentScore(b) - sourceIntentScore(a));
  }

  private buildSourceCompleteness(
    subgraph: Subgraph,
    codeBlocks: CodeBlock[],
    includeCode: boolean,
    maxBlocks: number,
    maxBlockSize: number,
    query: string,
  ): SourceCompletenessMetadata {
    const existing = (codeBlocks as CodeBlocksWithSourceCompleteness).sourceCompleteness;
    if (existing) return existing;

    const candidateBlocks = this.getPriorityCodeNodes(subgraph, query).length;
    return this.summarizeSourceCompleteness(
      candidateBlocks,
      [],
      0,
      maxBlocks,
      maxBlockSize,
      includeCode ? undefined : candidateBlocks,
    );
  }

  private summarizeSourceCompleteness(
    candidateBlocks: number,
    blocks: CodeBlock[],
    unreadableBlocks: number,
    maxBlocks: number,
    maxBlockSize: number,
    forcedOmittedBlocks?: number,
  ): SourceCompletenessMetadata {
    const truncatedBlocks = blocks.filter((block) =>
      (block as CodeBlockWithSourceCompleteness).sourceCompleteness === 'truncated'
    ).length;
    const completeBlocks = blocks.length - truncatedBlocks;
    const attemptedBlocks = blocks.length + unreadableBlocks;
    const omittedBlocks = forcedOmittedBlocks ?? Math.max(0, candidateBlocks - attemptedBlocks);
    const returnedBlocks = blocks.length;
    const status = this.deriveSourceCompletenessStatus(
      candidateBlocks,
      returnedBlocks,
      truncatedBlocks,
      omittedBlocks,
      unreadableBlocks,
    );

    return {
      status,
      candidateBlocks,
      returnedBlocks,
      completeBlocks,
      truncatedBlocks,
      omittedBlocks,
      unreadableBlocks,
      maxBlocks,
      maxBlockSize,
      followUp: this.buildSourceCompletenessFollowUp(status),
    };
  }

  private deriveSourceCompletenessStatus(
    candidateBlocks: number,
    returnedBlocks: number,
    truncatedBlocks: number,
    omittedBlocks: number,
    unreadableBlocks: number,
  ): SourceCompletenessStatus {
    if (candidateBlocks === 0) return 'complete';
    if (returnedBlocks === 0 && unreadableBlocks > 0 && omittedBlocks === 0) return 'unreadable';
    if (returnedBlocks === 0 && omittedBlocks > 0 && unreadableBlocks === 0) return 'omitted';
    if (unreadableBlocks > 0 || omittedBlocks > 0) return 'partial';
    if (truncatedBlocks > 0) return 'truncated';
    return 'complete';
  }

  private buildSourceCompletenessFollowUp(status: SourceCompletenessStatus): SourceCompletenessMetadata['followUp'] {
    if (status === 'complete') {
      return {
        reason: status,
        guidance: 'Returned source blocks cover the selected context. Use more SolidKG only if the question needs different symbols or files.',
        solidkgFirst: ['solidkg_context', 'solidkg_explore'],
      };
    }
    if (status === 'truncated') {
      return {
        reason: status,
        guidance: 'Some returned source blocks were truncated for size. Use a narrower solidkg_explore query or solidkg_node for the specific missing symbol before any targeted file read.',
        solidkgFirst: ['solidkg_explore', 'solidkg_node'],
      };
    }
    if (status === 'unreadable') {
      return {
        reason: status,
        guidance: 'SolidKG selected source whose file content was not readable from disk. Check solidkg_status for pending sync or use a narrower solidkg_node/solidkg_explore call before any targeted file read.',
        solidkgFirst: ['solidkg_status', 'solidkg_node', 'solidkg_explore'],
      };
    }
    if (status === 'omitted') {
      return {
        reason: status,
        guidance: 'Source blocks were intentionally omitted from this context. Re-run solidkg_context with includeCode or use focused solidkg_explore/solidkg_node for the named symbols before any targeted file read.',
        solidkgFirst: ['solidkg_context', 'solidkg_explore', 'solidkg_node'],
      };
    }
    return {
      reason: status,
      guidance: 'Only part of the selected source was returned. Use focused solidkg_explore or solidkg_node for omitted, unreadable, or truncated symbols before any targeted file read.',
      solidkgFirst: ['solidkg_explore', 'solidkg_node', 'solidkg_trace'],
    };
  }

  /**
   * Get unique files from a subgraph
   */
  private getRelatedFiles(subgraph: Subgraph): string[] {
    const files = new Set<string>();
    for (const node of subgraph.nodes.values()) {
      files.add(node.filePath);
    }
    return Array.from(files).sort();
  }

  /**
   * Generate a summary of the context
   */
  private generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
    const nodeCount = subgraph.nodes.size;
    const edgeCount = subgraph.edges.length;
    const files = this.getRelatedFiles(subgraph);

    const entryPointNames = entryPoints
      .slice(0, 3)
      .map((n) => n.name)
      .join(', ');

    const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

    return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
      `Key entry points: ${entryPointNames}${remaining}. ` +
      `${edgeCount} relationships identified.`;
  }

  private isBehaviorQuery(queryLower: string): boolean {
    return /\bhow\s+does\b/.test(queryLower)
      || /\b(?:work|works|flow|flows|execute|executes|run|runs|call|calls|process|processes|handle|handles|implement|implements|implementation|behavior|behaviour)\b/.test(queryLower);
  }

  private behaviorKindMultiplier(kind: NodeKind): number {
    switch (kind) {
      case 'function':
      case 'method':
      case 'route':
      case 'component':
        return 2.4;
      case 'class':
      case 'struct':
      case 'module':
      case 'namespace':
        return 1.35;
      case 'interface':
      case 'type_alias':
      case 'enum':
      case 'enum_member':
        return 0.45;
      default:
        return 1;
    }
  }

  private isApplyContentRecoveryQuery(queryLower: string): boolean {
    return /\bapply\b/.test(queryLower) && /\bcontent\b/.test(queryLower) && /\brecovery\b/.test(queryLower);
  }

  private applyContentRecoveryScore(node: Node): number {
    if (APPLY_CONTENT_RECOVERY_TABLE_NAMES.some(name => name === node.name)) return 500;
    if (node.name === 'complete_apply_mutation_with_review_and_audit') return 450;
    const filePath = node.filePath.toLowerCase();
    if (filePath.includes('/store/apply') || filePath.includes('/migrations/') || filePath.includes('/schema')) return 80;
    return 0;
  }

  private curationOperationAliasScore(node: Node): number {
    return CURATION_OPERATION_ALIAS_NAMES.some(name => name === node.name) ? 500 : 0;
  }

  private findFirstExactMatchPerName(names: readonly string[], kinds: NodeKind[] | undefined): SearchResult[] {
    const results: SearchResult[] = [];
    const seenIds = new Set<string>();
    for (const name of names) {
      const matches = this.queries.findNodesByExactName([name], {
        limit: 10,
        kinds,
      });
      const match = matches[0];
      if (!match || seenIds.has(match.node.id)) continue;
      results.push(match);
      seenIds.add(match.node.id);
    }
    return results;
  }

  /**
   * Resolve import/export nodes to their actual definitions
   *
   * When search returns `import { TerminalPanel }`, users want the TerminalPanel
   * class definition, not the import statement. This follows the `imports` edge
   * to find and return the actual definition instead.
   *
   * @param results - Search results that may include import/export nodes
   * @returns Results with imports resolved to definitions where possible
   */
  private resolveImportsToDefinitions(results: SearchResult[]): SearchResult[] {
    const resolved: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      const { node, score } = result;

      // If it's not an import/export, keep it as-is
      if (node.kind !== 'import' && node.kind !== 'export') {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          resolved.push(result);
        }
        continue;
      }

      // For imports/exports, try to find what they reference
      // Imports have outgoing 'imports' edges to the definition
      // Exports have outgoing 'exports' edges to the definition
      const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
      const outgoingEdges = this.queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

      let foundDefinition = false;
      for (const edge of outgoingEdges) {
        const targetNode = this.queries.getNodeById(edge.target);
        if (targetNode && !seenIds.has(targetNode.id)) {
          // Found the definition - use it instead of the import
          seenIds.add(targetNode.id);
          resolved.push({
            node: targetNode,
            score: score, // Preserve the original score
          });
          foundDefinition = true;
          logDebug('Resolved import to definition', {
            import: node.name,
            definition: targetNode.name,
            kind: targetNode.kind,
          });
        }
      }

      // If we couldn't resolve the import, skip it (it's low-value on its own)
      if (!foundDefinition) {
        logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
      }
    }

    return resolved;
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
  sourceOptions: SourceRootOptions = {}
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser, sourceOptions);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson, formatContextAsMinimalMarkdown, formatContextAsMinimalJson } from './formatter';
export {
  buildContextBudget,
  estimateCharsAsTokens,
  type BuildContextBudgetArgs,
  type ContextBudget,
  type ContextBudgetBaselineKind,
} from './budget';
