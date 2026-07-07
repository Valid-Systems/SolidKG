/**
 * Context Formatter
 *
 * Formats TaskContext as markdown or JSON for consumption by Claude.
 */

import { Node, Edge, HyperedgeRelation, SemanticRelationProvenance, SourceCompletenessMetadata, TaskContext } from '../types';
import type { ContextBudget } from './budget';
import { redactSensitiveText, RedactionOptions } from './redaction';
import { formatAnswerPacketMarkdown } from '../evidence/packets';

const CONTEXT_JSON_SCHEMA_VERSION = 'solidkg.context.v1';

/**
 * Format context as markdown
 *
 * Creates a compact markdown document optimized for Claude with minimal context usage:
 * - Brief summary
 * - Entry points with locations
 * - Code blocks only for key symbols
 */
export function formatContextAsMarkdown(context: TaskContext, redaction?: RedactionOptions | false): string {
  const lines: string[] = [];

  // Header with query
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  appendContextBudgetMarkdown(lines, context.contextBudget);
  appendSourceCompletenessMarkdown(lines, context.sourceCompleteness);
  appendAnswerPacketMarkdown(lines, context.answerPacket);

  // Entry points - compact format
  if (context.entryPoints.length > 0) {
    lines.push('### Entry Points\n');
    for (const node of context.entryPoints) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}`);
      if (node.signature) {
        lines.push(`  \`${node.signature}\``);
      }
    }
    lines.push('');
  }

  // Related symbols - compact list (skip verbose structure tree)
  const otherSymbols = Array.from(context.subgraph.nodes.values())
    .filter(n => !context.entryPoints.some(e => e.id === n.id))
    .slice(0, 10); // Limit to 10 related symbols

  if (otherSymbols.length > 0) {
    lines.push('### Related Symbols\n');
    const byFile = new Map<string, Node[]>();
    for (const node of otherSymbols) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(`- ${file}: ${nodeList}`);
    }
    lines.push('');
  }

  const semanticRelations = sortHyperedgeRelations(context.subgraph.hyperedges ?? []);
  if (semanticRelations.length > 0) {
    lines.push('### Semantic Relations\n');
    for (const relation of semanticRelations) {
      const headerLocation = formatRelationLocation(
        relation.hyperedge.sourceFile,
        relation.hyperedge.line,
      );
      const provenance = semanticRelationProvenance(relation);
      const provenanceText = provenance ? ` (provenance: ${provenance})` : '';
      lines.push(`- **${relation.hyperedge.kind}**${headerLocation ? ` - ${headerLocation}` : ''}${provenanceText}`);
      for (const member of sortHyperedgeMembers(relation)) {
        const memberLocation = formatRelationLocation(member.node.filePath, member.node.startLine);
        lines.push(`  - ${member.role}: ${member.node.name}${memberLocation ? ` (${memberLocation})` : ''}`);
      }
    }
    lines.push('');
  }

  // Code blocks - only for key entry points
  if (context.codeBlocks.length > 0) {
    lines.push('### Code\n');
    for (const block of context.codeBlocks) {
      const nodeName = block.node?.name ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push('```' + block.language);
      lines.push(redactSensitiveText(block.content, redaction));
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

/**
 * Format context as JSON
 *
 * Returns a structured JSON representation suitable for programmatic use.
 */
export function formatContextAsJson(context: TaskContext, redaction?: RedactionOptions | false): string {
  // Convert Map to array for JSON serialization
  const serializable = {
    schemaVersion: CONTEXT_JSON_SCHEMA_VERSION,
    solidkgVersion: context.solidkgVersion,
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.map((node) => serializeNode(node, redaction)),
    nodes: Array.from(context.subgraph.nodes.values()).map((node) => serializeNode(node, redaction)),
    edges: context.subgraph.edges.map(serializeEdge),
    hyperedges: sortHyperedgeRelations(context.subgraph.hyperedges ?? []).map((relation) => serializeHyperedgeRelation(relation, redaction)),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: redactSensitiveText(block.content, redaction),
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    relatedFiles: context.relatedFiles,
    stats: context.stats,
    ...(context.sourceCompleteness ? { sourceCompleteness: context.sourceCompleteness } : {}),
    ...(context.answerPacket ? { answerPacket: context.answerPacket } : {}),
    ...(context.contextBudget ? { contextBudget: context.contextBudget } : {}),
  };

  return JSON.stringify(serializable, null, 2);
}

export function formatContextAsMinimalMarkdown(context: TaskContext, redaction?: RedactionOptions | false): string {
  const lines: string[] = [];
  const semanticRelations = sortHyperedgeRelations(context.subgraph.hyperedges ?? []);
  const relationCounts = countSemanticRelations(semanticRelations);
  const relatedSymbols = getTopRelatedSymbols(context, 8);

  lines.push('## Code Context');
  lines.push('');
  lines.push(`**Query:** ${context.query}`);
  lines.push('**Detail:** minimal');
  lines.push('');

  appendContextBudgetMarkdown(lines, context.contextBudget);
  appendSourceCompletenessMarkdown(lines, context.sourceCompleteness);
  appendAnswerPacketMarkdown(lines, context.answerPacket);

  lines.push('### Summary');
  lines.push(context.summary);
  lines.push('');

  if (context.overview) {
    lines.push('### Repository Overview');
    lines.push(context.overview.markdown.replace(/^## Repository Overview[^\n]*\n\n?/, ''));
    lines.push('');
  }

  if (context.entryPoints.length > 0) {
    lines.push('### Entry Points');
    for (const node of context.entryPoints.slice(0, 5)) {
      const location = node.startLine ? `:${node.startLine}` : '';
      const signature = node.signature ? ` - ${redactSensitiveText(node.signature, redaction)}` : '';
      lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}${signature}`);
    }
    lines.push('');
  }

  if (relatedSymbols.length > 0) {
    lines.push('### Top Related Symbols');
    for (const node of relatedSymbols) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}`);
    }
    lines.push('');
  }

  if (context.relatedFiles.length > 0) {
    lines.push('### Top Related Files');
    for (const file of context.relatedFiles.slice(0, 8)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  lines.push('### Compact Stats');
  lines.push(`- Symbols: ${context.stats.nodeCount}`);
  lines.push(`- Edges: ${context.stats.edgeCount}`);
  lines.push(`- Files: ${context.stats.fileCount}`);
  lines.push(`- Code blocks: ${context.stats.codeBlockCount}`);
  lines.push('');

  lines.push('### Semantic Relation Counts');
  if (Object.keys(relationCounts).length === 0) {
    lines.push('- None found in this context');
  } else {
    for (const [kind, count] of Object.entries(relationCounts)) {
      lines.push(`- ${kind}: ${count}`);
    }
  }
  lines.push('');

  if (context.codeBlocks.length > 0) {
    lines.push('### Code');
    for (const block of context.codeBlocks) {
      const nodeName = block.node?.name ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})`);
      lines.push('');
      lines.push('```' + block.language);
      lines.push(redactSensitiveText(block.content, redaction));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('### Next Suggested SolidKG Tools');
  for (const suggestion of buildSuggestedTools(context, semanticRelations.length)) {
    lines.push(`- ${suggestion}`);
  }

  return lines.join('\n');
}

export function formatContextAsMinimalJson(context: TaskContext, redaction?: RedactionOptions | false): string {
  const semanticRelations = sortHyperedgeRelations(context.subgraph.hyperedges ?? []);
  const serializable = {
    schemaVersion: CONTEXT_JSON_SCHEMA_VERSION,
    solidkgVersion: context.solidkgVersion,
    detailLevel: 'minimal',
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.slice(0, 5).map((node) => serializeNode(node, redaction)),
    relatedSymbols: getTopRelatedSymbols(context, 10).map((node) => serializeNode(node, redaction)),
    relatedFiles: context.relatedFiles.slice(0, 10),
    stats: {
      nodeCount: context.stats.nodeCount,
      edgeCount: context.stats.edgeCount,
      fileCount: context.stats.fileCount,
      codeBlockCount: context.stats.codeBlockCount,
      semanticRelationCount: semanticRelations.length,
    },
    semanticRelationCounts: countSemanticRelations(semanticRelations),
    ...(context.overview ? { overview: context.overview } : {}),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: redactSensitiveText(block.content, redaction),
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    suggestedTools: buildSuggestedTools(context, semanticRelations.length),
    ...(context.sourceCompleteness ? { sourceCompleteness: context.sourceCompleteness } : {}),
    ...(context.answerPacket ? { answerPacket: context.answerPacket } : {}),
    ...(context.contextBudget ? { contextBudget: context.contextBudget } : {}),
  };

  return JSON.stringify(serializable, null, 2);
}

function getTopRelatedSymbols(context: TaskContext, limit: number): Node[] {
  const entryIds = new Set(context.entryPoints.map((node) => node.id));
  return Array.from(context.subgraph.nodes.values())
    .filter((node) => !entryIds.has(node.id))
    .slice(0, limit);
}

function countSemanticRelations(relations: HyperedgeRelation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const relation of relations) {
    counts[relation.hyperedge.kind] = (counts[relation.hyperedge.kind] ?? 0) + 1;
  }
  return counts;
}

function buildSuggestedTools(context: TaskContext, semanticRelationCount: number): string[] {
  const suggestions = ['solidkg_explore for source grouped by the symbols above'];
  if (context.entryPoints[0]) {
    suggestions.push(`solidkg_node on ${context.entryPoints[0].name} for one symbol's trail and optional source`);
  }
  if (context.subgraph.edges.some((edge) => edge.kind === 'calls')) {
    suggestions.push('solidkg_trace when you know the exact start and end symbols of a flow');
  }
  if (semanticRelationCount > 0) {
    suggestions.push('solidkg_precise_refs when SCIP hints appear for exact definitions and references');
  }
  return suggestions;
}

function appendContextBudgetMarkdown(lines: string[], budget: ContextBudget | undefined): void {
  if (!budget || budget.baselineKind === 'not_available') return;

  lines.push('### Context Budget');
  lines.push(`- Estimate: estimated using ${budget.estimatorVersion}`);
  lines.push(`- Baseline kind: ${budget.baselineKind}`);
  lines.push(`- Baseline tokens: ${budget.baselineTokens} (${budget.baselineChars} chars)`);
  lines.push(`- Output tokens: ${budget.outputTokens} (${budget.outputChars} chars)`);
  const savedPercent = budget.savedPercent === null ? 'n/a' : `${budget.savedPercent.toFixed(1)}%`;
  lines.push(`- Saved tokens: ${budget.savedTokens} (${savedPercent})`);
  if (budget.notes.length > 0) {
    lines.push(`- Notes: ${budget.notes.join(' ')}`);
  }
  lines.push('');
}

function appendSourceCompletenessMarkdown(lines: string[], sourceCompleteness: SourceCompletenessMetadata | undefined): void {
  if (!sourceCompleteness) return;

  lines.push('### Source Completeness');
  lines.push(
    `- Returned source coverage only: ${sourceCompleteness.status} (${sourceCompleteness.returnedBlocks}/${sourceCompleteness.candidateBlocks} blocks returned; complete ${sourceCompleteness.completeBlocks}, truncated ${sourceCompleteness.truncatedBlocks}, omitted ${sourceCompleteness.omittedBlocks}, unreadable ${sourceCompleteness.unreadableBlocks}; max ${sourceCompleteness.maxBlocks} blocks x ${sourceCompleteness.maxBlockSize} chars)`
  );
  lines.push(`- Focused SolidKG follow-up: ${sourceCompleteness.followUp.guidance}`);
  lines.push(`- Try first: ${sourceCompleteness.followUp.solidkgFirst.join(', ')}`);
  lines.push('');
}

function appendAnswerPacketMarkdown(lines: string[], answerPacket: TaskContext['answerPacket']): void {
  if (!answerPacket) return;
  lines.push(formatAnswerPacketMarkdown(answerPacket));
}

function sortHyperedgeRelations(relations: HyperedgeRelation[]): HyperedgeRelation[] {
  return [...relations].sort((a, b) =>
    a.hyperedge.kind.localeCompare(b.hyperedge.kind) ||
    a.hyperedge.id.localeCompare(b.hyperedge.id)
  );
}

function sortHyperedgeMembers(relation: HyperedgeRelation): HyperedgeRelation['members'] {
  return [...relation.members].sort((a, b) =>
    a.ordinal - b.ordinal ||
    a.role.localeCompare(b.role) ||
    a.node.name.localeCompare(b.node.name) ||
    a.nodeId.localeCompare(b.nodeId)
  );
}

function formatRelationLocation(filePath: string | undefined, line: number | undefined): string {
  if (!filePath) return '';
  return line ? `${filePath}:${line}` : filePath;
}

/**
 * Serialize a node for JSON output
 */
function serializeNode(node: Node, redaction?: RedactionOptions | false): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature ? redactSensitiveText(node.signature, redaction) : node.signature,
    docstring: node.docstring ? redactSensitiveText(node.docstring, redaction) : node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
  };
}

/**
 * Serialize an edge for JSON output
 */
function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
  };
}

function serializeHyperedgeRelation(relation: HyperedgeRelation, redaction?: RedactionOptions | false): Record<string, unknown> {
  const provenance = semanticRelationProvenance(relation);
  return {
    provenance,
    hyperedge: {
      id: relation.hyperedge.id,
      kind: relation.hyperedge.kind,
      sourceFile: relation.hyperedge.sourceFile,
      line: relation.hyperedge.line,
      column: relation.hyperedge.column,
      provenance,
      confidence: relation.hyperedge.confidence,
      metadata: redactUnknown(relation.hyperedge.metadata, redaction),
      createdAt: relation.hyperedge.createdAt,
      updatedAt: relation.hyperedge.updatedAt,
    },
    members: sortHyperedgeMembers(relation).map((member) => ({
      nodeId: member.nodeId,
      role: member.role,
      ordinal: member.ordinal,
      metadata: redactUnknown(member.metadata, redaction),
      node: serializeNode(member.node, redaction),
    })),
  };
}

function semanticRelationProvenance(relation: HyperedgeRelation): SemanticRelationProvenance | undefined {
  switch (relation.hyperedge.provenance) {
    case 'scip':
      return 'scip';
    case 'tree-sitter':
      return 'ast_static';
    case 'heuristic':
      return 'semantic_synthesis';
    default:
      return undefined;
  }
}

function redactUnknown(value: unknown, redaction?: RedactionOptions | false): unknown {
  if (typeof value === 'string') return redactSensitiveText(value, redaction);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, redaction));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactUnknown(entry, redaction);
    }
    return out;
  }
  return value;
}
