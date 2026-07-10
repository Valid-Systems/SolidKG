import { describe, expect, it } from 'vitest';
import type { CodeBlock, Node, SourceCompletenessMetadata, Subgraph } from '../src/types';
import {
  buildContextAnswerPacket,
  buildFailureAnswerPacket,
  buildNodeAnswerPacket,
  formatAnswerPacketMarkdown,
} from '../src/evidence/packets';
import { buildReturnedEvidenceActionability } from '../src/evidence/contracts';

function node(id: string, name: string, filePath: string, startLine: number, endLine: number): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
  };
}

const sourceCompleteness: SourceCompletenessMetadata = {
  status: 'complete',
  candidateBlocks: 2,
  returnedBlocks: 2,
  completeBlocks: 2,
  truncatedBlocks: 0,
  omittedBlocks: 0,
  unreadableBlocks: 0,
  maxBlocks: 5,
  maxBlockSize: 1500,
  followUp: {
    reason: 'complete',
    guidance: 'Returned source blocks cover the selected context.',
    solidkgFirst: ['solidkg_context', 'solidkg_explore'],
  },
};

describe('answer and evidence packets', () => {
  it('builds deterministic context packets with sorted evidence anchors and bounded labels', () => {
    const later = node('node-b', 'later', 'src/b.ts', 20, 22);
    const earlier = node('node-a', 'earlier', 'src/a.ts', 3, 6);
    const subgraph: Subgraph = {
      nodes: new Map([[later.id, later], [earlier.id, earlier]]),
      edges: [{ source: earlier.id, target: later.id, kind: 'calls', line: 5 }],
      roots: [later.id, earlier.id],
    };
    const codeBlocks: CodeBlock[] = [
      { filePath: later.filePath, startLine: later.startLine, endLine: later.endLine, language: 'typescript', content: 'later()', node: later },
      { filePath: earlier.filePath, startLine: earlier.startLine, endLine: earlier.endLine, language: 'typescript', content: 'earlier()', node: earlier },
    ];

    const first = buildContextAnswerPacket({
      query: 'how does earlier call later',
      entryPoints: [later, earlier],
      subgraph,
      codeBlocks,
      sourceCompleteness,
      semanticRelationCount: 0,
    });
    const second = buildContextAnswerPacket({
      query: 'how does earlier call later',
      entryPoints: [later, earlier],
      subgraph,
      codeBlocks,
      sourceCompleteness,
      semanticRelationCount: 0,
    });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe('solidkg.answer-packet.v1');
    expect(first.packetId).toMatch(/^ap_[0-9a-f]{16}$/);
    expect(first).not.toHaveProperty('generatedAt');
    expect(first.sufficiency.canAnswerFromReturnedContext).toBe(true);
    expect(first.sufficiency.status).toBe('sufficient');
    expect(first.suggestedNextTools).toEqual([]);
    expect(first.uncertaintyLabels).toEqual([]);
    expect(first.returnedEvidenceActionability).toBeUndefined();
    expect(first.evidence.map((entry) => entry.sourceAnchor.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(first.evidence[0]).toMatchObject({
      evidenceId: 'ev_e6f7ea8536487c1a',
      sourceAnchor: { nodeId: 'node-a', filePath: 'src/a.ts', startLine: 3, endLine: 6 },
    });
    expect(first.rankingReasons.map((reason) => reason.kind)).toEqual(expect.arrayContaining(['entry_point', 'source_returned', 'graph_relationship']));
    expect(formatAnswerPacketMarkdown(first)).not.toContain('Suggested next SolidKG tools:');
  });

  it('builds bounded failure packets without pretending source sufficiency', () => {
    const packet = buildFailureAnswerPacket({
      query: 'missingSymbol',
      tool: 'solidkg_search',
      uncertaintyLabels: ['bounded_no_results'],
      message: 'No results found for missingSymbol',
      suggestedNextTools: ['solidkg_context'],
    });

    expect(packet.schemaVersion).toBe('solidkg.answer-packet.v1');
    expect(packet.sufficiency).toMatchObject({
      status: 'insufficient',
      canAnswerFromReturnedContext: false,
    });
    expect(packet.uncertaintyLabels).toEqual(['bounded_no_results']);
    expect(packet.returnedEvidenceActionability).toBeUndefined();
    expect(packet.evidence).toEqual([]);
    expect(formatAnswerPacketMarkdown(packet)).toContain('Uncertainty: bounded_no_results');
  });

  it('treats intentionally omitted source as sufficient for minimal orientation', () => {
    const entry = node('entry', 'EntryPoint', 'src/entry.ts', 1, 8);
    const packet = buildContextAnswerPacket({
      query: 'orient me to EntryPoint',
      entryPoints: [entry],
      subgraph: { nodes: new Map([[entry.id, entry]]), edges: [], roots: [entry.id] },
      codeBlocks: [],
      sourceCompleteness: {
        ...sourceCompleteness,
        status: 'omitted',
        returnedBlocks: 0,
        completeBlocks: 0,
        omittedBlocks: 2,
        followUp: {
          reason: 'omitted',
          guidance: 'Source was intentionally omitted for minimal orientation.',
          solidkgFirst: ['solidkg_context', 'solidkg_explore', 'solidkg_node'],
        },
      },
      semanticRelationCount: 0,
    });

    expect(packet.sufficiency).toMatchObject({
      status: 'sufficient',
      canAnswerFromReturnedContext: true,
    });
    expect(packet.uncertaintyLabels).toContain('source_partial');
    expect(packet.suggestedNextTools).toEqual([]);
  });

  it('does not let peripheral omitted source override returned entry source', () => {
    const entry = node('entry', 'EntryPoint', 'src/entry.ts', 1, 8);
    const peripheral = node('peripheral', 'Peripheral', 'src/peripheral.ts', 1, 8);
    const packet = buildContextAnswerPacket({
      query: 'explain EntryPoint',
      entryPoints: [entry],
      subgraph: {
        nodes: new Map([[entry.id, entry], [peripheral.id, peripheral]]),
        edges: [{ source: entry.id, target: peripheral.id, kind: 'calls', line: 4 }],
        roots: [entry.id],
      },
      codeBlocks: [{
        filePath: entry.filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        language: 'typescript',
        content: 'EntryPoint()',
        node: entry,
      }],
      sourceCompleteness: {
        ...sourceCompleteness,
        status: 'partial',
        returnedBlocks: 1,
        completeBlocks: 1,
        omittedBlocks: 1,
        followUp: {
          reason: 'partial',
          guidance: 'One peripheral candidate was omitted.',
          solidkgFirst: ['solidkg_explore', 'solidkg_node'],
        },
      },
      semanticRelationCount: 0,
    });

    expect(packet.sufficiency.canAnswerFromReturnedContext).toBe(true);
    expect(packet.suggestedNextTools).toEqual([]);
  });

  it('renders returned evidence actionability additively', () => {
    const packet = buildNodeAnswerPacket({
      query: 'scoreRun',
      tool: 'solidkg_node',
      nodes: [node('score-run', 'scoreRun', 'scripts/agent-eval/score-answer-quality.mjs', 206, 240)],
      includeReturnedEvidenceActionability: true,
    });
    const markdown = formatAnswerPacketMarkdown(packet);

    expect(markdown).toContain('### Answer Packet');
    expect(markdown).toContain('- Binary sufficiency: sufficient');
    expect(markdown).toContain('- Returned evidence actionability:');
    expect(markdown).toContain('Scope: returned_evidence_only');
    expect(markdown).toContain('Not a completeness claim: true');
    expect(markdown).toContain('Evidence anchors:');
  });

  it('classifies unresolved answer boundaries as requiring focused follow-up', () => {
    const blockedInputs = [
      { hasAmbiguity: true },
      { noResults: true },
      { noStaticPath: true },
      { freshness: 'stale' as const },
      { hasUnsupportedMechanism: true },
    ];

    for (const input of blockedInputs) {
      const actionability = buildReturnedEvidenceActionability({
        canAnswerFromReturnedContext: true,
        sourceCoverage: 'complete',
        freshness: 'fresh',
        ...input,
      });

      expect(actionability.eligibleActions).toEqual(['requires_focused_follow_up']);
      expect(actionability.blockers.length).toBeGreaterThan(0);
      expect(actionability.notACompletenessClaim).toBe(true);
    }
  });

  it('keeps unknown freshness as metadata when returned evidence is answerable', () => {
    const actionability = buildReturnedEvidenceActionability({
      canAnswerFromReturnedContext: true,
      sourceCoverage: 'complete',
      freshness: 'unknown',
    });

    expect(actionability.eligibleActions).toEqual(['explain_returned_evidence', 'localize_candidate']);
    expect(actionability.blockers).toEqual([]);
    expect(actionability.mustValidateWith).not.toContain('sync_or_read_stale_files_before_acting');
  });

  it('never emits edit or review eligibility in the first slice', () => {
    const actionabilities = [
      buildReturnedEvidenceActionability({ canAnswerFromReturnedContext: false }),
      buildReturnedEvidenceActionability({
        canAnswerFromReturnedContext: true,
        sourceCoverage: 'complete',
        freshness: 'fresh',
      }),
    ];

    for (const actionability of actionabilities) {
      expect(actionability.eligibleActions).not.toContain('edit');
      expect(actionability.eligibleActions).not.toContain('review');
      expect(actionability.eligibleActions).not.toContain('safe_to_edit');
      expect(actionability.eligibleActions).not.toContain('safe_to_review');
    }
  });

  it('allows only explain and localize for complete fresh bounded evidence', () => {
    const actionability = buildReturnedEvidenceActionability({
      canAnswerFromReturnedContext: true,
      sourceCoverage: 'complete',
      freshness: 'fresh',
      capState: 'uncapped',
      evidenceProvenance: ['static'],
    });

    expect(actionability.eligibleActions).toEqual(['explain_returned_evidence', 'localize_candidate']);
    expect(actionability.blockers).toEqual([]);
    expect(actionability.nextAction.action).toBe('answer_from_returned_evidence');
  });

  it('keeps coverage, caps, and heuristic provenance as metadata when the returned answer is sufficient', () => {
    const actionability = buildReturnedEvidenceActionability({
      canAnswerFromReturnedContext: true,
      sourceCoverage: 'truncated',
      freshness: 'unknown',
      capState: 'capped',
      evidenceProvenance: ['heuristic'],
      hasHeuristicEvidence: true,
      hasCappedRequiredFacts: true,
    });

    expect(actionability.eligibleActions).toEqual(['explain_returned_evidence', 'localize_candidate']);
    expect(actionability.blockers).toEqual([]);
    expect(actionability.nextAction.action).toBe('answer_from_returned_evidence');
    expect(actionability.sourceCoverage).toBe('truncated');
    expect(actionability.capState).toBe('capped');
    expect(actionability.evidenceProvenance).toEqual(['heuristic']);
  });

  it('never contradicts sufficient binary evidence with focused-follow-up actionability', () => {
    const packet = buildNodeAnswerPacket({
      query: 'heuristic path',
      tool: 'solidkg_trace',
      nodes: [node('start', 'start', 'src/a.ts', 1, 3)],
      canAnswerFromReturnedContext: true,
      uncertaintyLabels: ['heuristic_edge', 'source_partial'],
      actionabilityInput: {
        sourceCoverage: 'truncated',
        freshness: 'unknown',
        capState: 'capped',
        evidenceProvenance: ['heuristic'],
        hasCappedRequiredFacts: true,
      },
      includeReturnedEvidenceActionability: true,
    });

    expect(packet.sufficiency.canAnswerFromReturnedContext).toBe(true);
    expect(packet.returnedEvidenceActionability?.eligibleActions).not.toContain('requires_focused_follow_up');
    expect(packet.returnedEvidenceActionability?.nextAction.action).toBe('answer_from_returned_evidence');
  });

  it('keeps heuristic uncertainty as metadata when binary evidence is sufficient', () => {
    const packet = buildNodeAnswerPacket({
      query: 'heuristic path',
      tool: 'solidkg_trace',
      nodes: [node('start', 'start', 'src/a.ts', 1, 3)],
      canAnswerFromReturnedContext: true,
      uncertaintyLabels: ['heuristic_edge'],
      includeReturnedEvidenceActionability: true,
    });

    expect(packet.sufficiency.canAnswerFromReturnedContext).toBe(true);
    expect(packet.returnedEvidenceActionability?.eligibleActions).toEqual(['explain_returned_evidence', 'localize_candidate']);
    expect(packet.returnedEvidenceActionability?.blockers).toEqual([]);
  });

  it('keeps actionability additive outside packet ID compatibility fields', () => {
    const base = buildNodeAnswerPacket({
      query: 'scoreRun',
      tool: 'solidkg_node',
      nodes: [node('score-run', 'scoreRun', 'scripts/agent-eval/score-answer-quality.mjs', 206, 240)],
    });
    const withActionability = buildNodeAnswerPacket({
      query: 'scoreRun',
      tool: 'solidkg_node',
      nodes: [node('score-run', 'scoreRun', 'scripts/agent-eval/score-answer-quality.mjs', 206, 240)],
      includeReturnedEvidenceActionability: true,
    });
    const withSuggestedTool = buildNodeAnswerPacket({
      query: 'scoreRun',
      tool: 'solidkg_node',
      nodes: [node('score-run', 'scoreRun', 'scripts/agent-eval/score-answer-quality.mjs', 206, 240)],
      suggestedNextTools: ['solidkg_context'],
    });

    expect(withActionability.returnedEvidenceActionability).toBeDefined();
    expect(withActionability.packetId).toBe(base.packetId);
    expect(withSuggestedTool.packetId).not.toBe(base.packetId);
  });

  it('does not invite recursive node lookups when returned node context is sufficient', () => {
    const packet = buildNodeAnswerPacket({
      query: 'scoreRun',
      tool: 'solidkg_node',
      nodes: [node('score-run', 'scoreRun', 'scripts/agent-eval/score-answer-quality.mjs', 206, 240)],
      canAnswerFromReturnedContext: true,
    });
    const markdown = formatAnswerPacketMarkdown(packet);

    expect(packet.sufficiency.canAnswerFromReturnedContext).toBe(true);
    expect(packet.suggestedNextTools).not.toContain('solidkg_node');
    expect(markdown).not.toContain('Suggested next SolidKG tools: solidkg_node');
  });

  it('filters raw file tools out of suggested next SolidKG tools', () => {
    const packet = buildFailureAnswerPacket({
      query: 'missingSymbol',
      tool: 'solidkg_explore',
      uncertaintyLabels: ['source_partial'],
      message: 'Source was partial.',
      suggestedNextTools: ['Read', 'Grep', 'solidkg_explore', 'solidkg_node'],
    });
    const markdown = formatAnswerPacketMarkdown(packet);

    expect(packet.suggestedNextTools).toEqual(['solidkg_explore', 'solidkg_node']);
    expect(markdown).toContain('Suggested next SolidKG tools: solidkg_explore, solidkg_node');
    expect(markdown).not.toContain('Read');
    expect(markdown).not.toContain('Grep');
  });
});
