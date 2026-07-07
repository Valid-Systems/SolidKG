import { createHash } from 'crypto';
import type {
  AnswerPacket,
  CodeBlock,
  EvidencePacketEntry,
  Node,
  RankingReason,
  ReturnedEvidenceActionability,
  SearchRankingReason,
  SourceAnchor,
  SourceCompletenessMetadata,
  Subgraph,
  UncertaintyLabel,
} from '../types';
import { buildReturnedEvidenceActionability, type ReturnedEvidenceActionabilityInput } from './contracts';

export const ANSWER_PACKET_SCHEMA_VERSION = 'solidkg.answer-packet.v1' as const;

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function solidkgToolSuggestions(values: string[]): string[] {
  return values.filter((value) => /^solidkg_[A-Za-z0-9_]+$/.test(value));
}

function evidenceId(anchor: SourceAnchor, label: string): string {
  return `ev_${stableHash({ anchor, label })}`;
}

function packetId(args: Omit<AnswerPacket, 'schemaVersion' | 'packetId' | 'returnedEvidenceActionability'>): string {
  return `ap_${stableHash(args)}`;
}

function nodeAnchor(node: Node): SourceAnchor {
  return {
    nodeId: node.id,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
  };
}

function entryFromNode(node: Node, kind: EvidencePacketEntry['kind'] = 'symbol'): EvidencePacketEntry {
  const sourceAnchor = nodeAnchor(node);
  return {
    evidenceId: evidenceId(sourceAnchor, node.name),
    kind,
    label: node.name,
    sourceAnchor,
  };
}

function sortEvidence(entries: EvidencePacketEntry[]): EvidencePacketEntry[] {
  const byId = new Map<string, EvidencePacketEntry>();
  for (const entry of entries) byId.set(entry.evidenceId, entry);
  return [...byId.values()].sort((a, b) =>
    a.sourceAnchor.filePath.localeCompare(b.sourceAnchor.filePath) ||
    a.sourceAnchor.startLine - b.sourceAnchor.startLine ||
    a.sourceAnchor.endLine - b.sourceAnchor.endLine ||
    (a.sourceAnchor.nodeId ?? '').localeCompare(b.sourceAnchor.nodeId ?? '') ||
    a.label.localeCompare(b.label)
  );
}

function buildPacket(args: Omit<AnswerPacket, 'schemaVersion' | 'packetId'>): AnswerPacket {
  const packetWithoutId = {
    ...args,
    uncertaintyLabels: uniqueSorted(args.uncertaintyLabels),
    evidence: sortEvidence(args.evidence),
    rankingReasons: [...args.rankingReasons].sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)),
    suggestedNextTools: uniqueSorted(solidkgToolSuggestions(args.suggestedNextTools)),
  };
  return {
    schemaVersion: ANSWER_PACKET_SCHEMA_VERSION,
    packetId: packetId({
      query: packetWithoutId.query,
      tool: packetWithoutId.tool,
      sufficiency: packetWithoutId.sufficiency,
      uncertaintyLabels: packetWithoutId.uncertaintyLabels,
      evidence: packetWithoutId.evidence,
      rankingReasons: packetWithoutId.rankingReasons,
      suggestedNextTools: packetWithoutId.suggestedNextTools,
    }),
    ...packetWithoutId,
  };
}

export function buildContextAnswerPacket(args: {
  query: string;
  entryPoints: Node[];
  subgraph: Subgraph;
  codeBlocks: CodeBlock[];
  sourceCompleteness: SourceCompletenessMetadata;
  semanticRelationCount: number;
  searchRankingReasons?: readonly SearchRankingReason[];
  tool?: string;
}): AnswerPacket {
  const sourceNodeIds = new Set(args.codeBlocks.map((block) => block.node?.id).filter((id): id is string => typeof id === 'string'));
  const evidence = sortEvidence([
    ...args.entryPoints.map((node) => entryFromNode(node)),
    ...args.codeBlocks
      .filter((block) => block.node && !args.entryPoints.some((entry) => entry.id === block.node?.id))
      .map((block) => entryFromNode(block.node as Node, 'source')),
  ]);
  const hasReturnedSourceForEntry = args.entryPoints.length === 0 || args.entryPoints.some((node) => sourceNodeIds.has(node.id));
  const completeEnough = args.sourceCompleteness.returnedBlocks > 0 && args.sourceCompleteness.omittedBlocks === 0 && args.sourceCompleteness.unreadableBlocks === 0;
  const canAnswer = evidence.length > 0 && hasReturnedSourceForEntry && completeEnough;
  const uncertaintyLabels: UncertaintyLabel[] = [];
  if (!canAnswer || args.sourceCompleteness.status !== 'complete') uncertaintyLabels.push('source_partial');
  const hasHeuristicEvidence = args.subgraph.edges.some((edge) => edge.provenance === 'heuristic');
  if (hasHeuristicEvidence) uncertaintyLabels.push('heuristic_edge');

  const rankingReasons: RankingReason[] = [];
  if (args.entryPoints.length > 0) rankingReasons.push({ kind: 'entry_point', label: `${args.entryPoints.length} query entry point(s) matched`, weight: 100 });
  if (args.codeBlocks.length > 0) rankingReasons.push({ kind: 'source_returned', label: `${args.codeBlocks.length} source block(s) returned`, weight: 90 });
  const chunkReasons = args.searchRankingReasons?.filter((reason) => reason.kind === 'source_body_chunk') ?? [];
  if (chunkReasons.length > 0) {
    const chunkLabels = [...new Set(chunkReasons.map((reason) => reason.evidence).filter((value): value is string => typeof value === 'string'))];
    rankingReasons.push({
      kind: 'source_body_chunk',
      label: chunkLabels.length > 0
        ? `${chunkLabels.length} source chunk body/code-token match(es) seeded or boosted context`
        : `${chunkReasons.length} source chunk body/code-token match(es) seeded or boosted context`,
      weight: 95,
    });
  }
  if (args.subgraph.edges.length > 0) rankingReasons.push({ kind: 'graph_relationship', label: `${args.subgraph.edges.length} graph relationship(s) included`, weight: 70 });
  if (args.semanticRelationCount > 0) rankingReasons.push({ kind: 'semantic_relation', label: `${args.semanticRelationCount} semantic relation(s) included`, weight: 80 });

  return buildPacket({
    query: args.query,
    tool: args.tool ?? 'solidkg_context',
    sufficiency: {
      status: canAnswer ? 'sufficient' : evidence.length > 0 ? 'partial' : 'insufficient',
      canAnswerFromReturnedContext: canAnswer,
      reason: canAnswer
        ? 'Returned source and graph evidence cover the selected context.'
        : 'Returned evidence is missing source, entry coverage, or complete source coverage.',
    },
    uncertaintyLabels,
    evidence,
    rankingReasons,
    suggestedNextTools: canAnswer ? [] : args.sourceCompleteness.followUp.solidkgFirst,
  });
}

export function buildNodeAnswerPacket(args: {
  query: string;
  tool: string;
  nodes: Node[];
  canAnswerFromReturnedContext?: boolean;
  uncertaintyLabels?: UncertaintyLabel[];
  rankingReasons?: RankingReason[];
  suggestedNextTools?: string[];
  returnedEvidenceActionability?: ReturnedEvidenceActionability;
  actionabilityInput?: ReturnedEvidenceActionabilityInput;
  includeReturnedEvidenceActionability?: boolean;
}): AnswerPacket {
  const evidence = args.nodes.map((node) => entryFromNode(node));
  const canAnswer = args.canAnswerFromReturnedContext ?? evidence.length > 0;
  const uncertaintyLabels = args.uncertaintyLabels ?? [];
  const hasHeuristicEvidence = uncertaintyLabels.includes('heuristic_edge');
  const suggestedNextTools = args.suggestedNextTools ?? (canAnswer ? [] : ['solidkg_explore', 'solidkg_node']);
  return buildPacket({
    query: args.query,
    tool: args.tool,
    sufficiency: {
      status: canAnswer ? 'sufficient' : evidence.length > 0 ? 'partial' : 'insufficient',
      canAnswerFromReturnedContext: canAnswer,
      reason: canAnswer ? 'Returned graph/source anchors are sufficient for the bounded query.' : 'The bounded query could not be answered from returned context alone.',
    },
    uncertaintyLabels,
    ...(args.includeReturnedEvidenceActionability === true ? {
      returnedEvidenceActionability: args.returnedEvidenceActionability ?? buildReturnedEvidenceActionability({
        canAnswerFromReturnedContext: canAnswer,
        sourceCoverage: args.actionabilityInput?.sourceCoverage ?? (canAnswer ? 'complete' : 'unknown'),
        uncertaintyLabels,
        hasHeuristicEvidence,
        evidenceProvenance: args.actionabilityInput?.evidenceProvenance ?? (hasHeuristicEvidence ? ['heuristic'] : evidence.length > 0 ? ['static'] : ['unknown']),
        ...args.actionabilityInput,
      }),
    } : {}),
    evidence,
    rankingReasons: args.rankingReasons ?? [
      { kind: 'entry_point', label: `${evidence.length} relevant symbol anchor(s) returned`, weight: 100 },
    ],
    suggestedNextTools,
  });
}

export function buildFailureAnswerPacket(args: {
  query: string;
  tool: string;
  uncertaintyLabels: UncertaintyLabel[];
  message: string;
  suggestedNextTools?: string[];
  returnedEvidenceActionability?: ReturnedEvidenceActionability;
  actionabilityInput?: ReturnedEvidenceActionabilityInput;
  includeReturnedEvidenceActionability?: boolean;
}): AnswerPacket {
  return buildPacket({
    query: args.query,
    tool: args.tool,
    sufficiency: {
      status: 'insufficient',
      canAnswerFromReturnedContext: false,
      reason: args.message,
    },
    uncertaintyLabels: args.uncertaintyLabels,
    ...(args.includeReturnedEvidenceActionability === true ? {
      returnedEvidenceActionability: args.returnedEvidenceActionability ?? buildReturnedEvidenceActionability({
        canAnswerFromReturnedContext: false,
        sourceCoverage: 'unknown',
        uncertaintyLabels: args.uncertaintyLabels,
        noResults: args.uncertaintyLabels.includes('bounded_no_results'),
        noStaticPath: args.uncertaintyLabels.includes('bounded_no_static_path'),
        hasAmbiguity: args.uncertaintyLabels.includes('ambiguous_symbol'),
        ...args.actionabilityInput,
      }),
    } : {}),
    evidence: [],
    rankingReasons: [{ kind: 'failure_boundary', label: args.message, weight: 100 }],
    suggestedNextTools: args.suggestedNextTools ?? ['solidkg_context', 'solidkg_search'],
  });
}

export function formatAnswerPacketMarkdown(packet: AnswerPacket): string {
  const lines = [
    '### Answer Packet',
    `- Schema: ${packet.schemaVersion}`,
    `- Packet ID: ${packet.packetId}`,
    `- Binary sufficiency: ${packet.sufficiency.status} (${packet.sufficiency.canAnswerFromReturnedContext ? 'can answer from returned context' : 'cannot answer from returned context'})`,
    `- Reason: ${packet.sufficiency.reason}`,
    `- Uncertainty: ${packet.uncertaintyLabels.length > 0 ? packet.uncertaintyLabels.join(', ') : 'none'}`,
  ];
  if (packet.evidence.length > 0) {
    lines.push('- Evidence anchors:');
    for (const entry of packet.evidence.slice(0, 8)) {
      const anchor = entry.sourceAnchor;
      lines.push(`  - ${entry.evidenceId}: ${entry.label} (${anchor.filePath}:${anchor.startLine}-${anchor.endLine})`);
    }
  }
  if (packet.returnedEvidenceActionability) {
    const actionability = packet.returnedEvidenceActionability;
    lines.push('- Returned evidence actionability:');
    lines.push(`  - Eligible actions: ${actionability.eligibleActions.join(', ')}`);
    lines.push(`  - Scope: ${actionability.scope}`);
    lines.push(`  - Blockers: ${actionability.blockers.length > 0 ? actionability.blockers.join(', ') : 'none'}`);
    lines.push(`  - Evidence provenance: ${actionability.evidenceProvenance.join(', ')}`);
    lines.push(`  - Source coverage: ${actionability.sourceCoverage}`);
    lines.push(`  - Freshness: ${actionability.freshness}`);
    lines.push(`  - Cap state: ${actionability.capState}`);
    lines.push(`  - Next action: ${actionability.nextAction.action} — ${actionability.nextAction.reason}`);
    lines.push(`  - Must validate with: ${actionability.mustValidateWith.join(', ')}`);
    lines.push(`  - Not a completeness claim: ${actionability.notACompletenessClaim}`);
  }
  if (packet.rankingReasons.length > 0) {
    lines.push('- Ranking reasons:');
    for (const reason of packet.rankingReasons.slice(0, 6)) {
      lines.push(`  - ${reason.kind}: ${reason.label}`);
    }
  }
  if (packet.suggestedNextTools.length > 0) {
    lines.push(`- Suggested next SolidKG tools: ${packet.suggestedNextTools.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}
