import type {
  ReturnedEvidenceActionability,
  ReturnedEvidenceCapState,
  ReturnedEvidenceFreshness,
  ReturnedEvidenceNextAction,
  ReturnedEvidenceProvenance,
  SourceCompletenessStatus,
  UncertaintyLabel,
} from '../types';

export interface ReturnedEvidenceActionabilityInput {
  canAnswerFromReturnedContext?: boolean;
  sourceCoverage?: SourceCompletenessStatus | 'unknown';
  freshness?: ReturnedEvidenceFreshness;
  capState?: ReturnedEvidenceCapState;
  evidenceProvenance?: ReturnedEvidenceProvenance[];
  uncertaintyLabels?: UncertaintyLabel[];
  hasHeuristicEvidence?: boolean;
  hasAmbiguity?: boolean;
  noResults?: boolean;
  noStaticPath?: boolean;
  hasCappedRequiredFacts?: boolean;
  hasUnsupportedMechanism?: boolean;
  missingProvenance?: boolean;
  nextAction?: ReturnedEvidenceNextAction;
}

const SOURCE_INCOMPLETE = new Set<SourceCompletenessStatus | 'unknown'>([
  'partial',
  'truncated',
  'omitted',
  'unreadable',
  'skipped',
]);

const DEFAULT_VALIDATION = [
  'compiler_or_typecheck',
  'relevant_tests',
  'manual_surface_check',
];

export function buildReturnedEvidenceActionability(
  input: ReturnedEvidenceActionabilityInput = {},
): ReturnedEvidenceActionability {
  const sourceCoverage = input.sourceCoverage ?? 'unknown';
  const freshness = input.freshness ?? 'unknown';
  const capState = input.capState ?? (input.hasCappedRequiredFacts ? 'capped' : 'unknown');
  const uncertaintyLabels = input.uncertaintyLabels ?? [];
  const evidenceProvenance = normalizeProvenance(input.evidenceProvenance, input.hasHeuristicEvidence || uncertaintyLabels.includes('heuristic_edge'));
  const blockers = collectBlockers(input, sourceCoverage, freshness, capState, evidenceProvenance, uncertaintyLabels);
  const eligibleActions = blockers.length > 0 || !input.canAnswerFromReturnedContext
    ? ['requires_focused_follow_up'] as const
    : ['explain_returned_evidence', 'localize_candidate'] as const;

  return {
    eligibleActions: [...eligibleActions],
    scope: 'returned_evidence_only',
    blockers,
    evidenceProvenance,
    sourceCoverage,
    freshness,
    capState,
    nextAction: input.nextAction ?? defaultNextAction(blockers),
    mustValidateWith: validationRequirements(blockers),
    notACompletenessClaim: true,
  };
}

function normalizeProvenance(
  provenance: ReturnedEvidenceProvenance[] | undefined,
  hasHeuristicEvidence: boolean | undefined,
): ReturnedEvidenceProvenance[] {
  const values = new Set<ReturnedEvidenceProvenance>(provenance ?? []);
  if (hasHeuristicEvidence) values.add('heuristic');
  if (values.size === 0) values.add('unknown');
  return [...values].sort((a, b) => a.localeCompare(b));
}

function collectBlockers(
  input: ReturnedEvidenceActionabilityInput,
  sourceCoverage: SourceCompletenessStatus | 'unknown',
  freshness: ReturnedEvidenceFreshness,
  capState: ReturnedEvidenceCapState,
  evidenceProvenance: ReturnedEvidenceProvenance[],
  uncertaintyLabels: UncertaintyLabel[],
): string[] {
  const blockers = new Set<string>();
  const requiresMoreEvidence = !input.canAnswerFromReturnedContext;
  if (requiresMoreEvidence && sourceCoverage === 'unknown') blockers.add('source_coverage_unknown');
  if (requiresMoreEvidence && SOURCE_INCOMPLETE.has(sourceCoverage)) blockers.add(`source_${sourceCoverage}`);
  if (requiresMoreEvidence && freshness === 'unknown') blockers.add('freshness_unknown');
  if (freshness === 'stale') blockers.add('stale_evidence');
  if (requiresMoreEvidence && (capState === 'capped' || input.hasCappedRequiredFacts)) blockers.add('capped_required_facts');
  if (input.hasAmbiguity || uncertaintyLabels.includes('ambiguous_symbol')) blockers.add('ambiguous_symbol');
  if (input.noResults || uncertaintyLabels.includes('bounded_no_results')) blockers.add('bounded_no_results');
  if (input.noStaticPath || uncertaintyLabels.includes('bounded_no_static_path')) blockers.add('bounded_no_static_path');
  if (input.hasUnsupportedMechanism) blockers.add('unsupported_mechanism');
  if (requiresMoreEvidence && (input.missingProvenance || evidenceProvenance.includes('unknown'))) blockers.add('missing_provenance');
  if (requiresMoreEvidence) blockers.add('insufficient_returned_context');
  return [...blockers].sort((a, b) => a.localeCompare(b));
}

function defaultNextAction(blockers: string[]): ReturnedEvidenceNextAction {
  if (blockers.includes('ambiguous_symbol')) {
    return { action: 'qualify_symbol', reason: 'Resolve the ambiguous endpoint before relying on this result.' };
  }
  if (blockers.includes('bounded_no_static_path')) {
    return { action: 'inspect_frontier', reason: 'Follow the named frontier; no static path is not proof of absence.' };
  }
  if (blockers.includes('bounded_no_results')) {
    return { action: 'narrow_query', reason: 'Use a more specific symbol, file, or qualified name.' };
  }
  if (blockers.includes('stale_evidence') || blockers.includes('freshness_unknown')) {
    return { action: 'sync_or_verify_freshness', reason: 'Verify the indexed evidence is current before relying on it.' };
  }
  if (blockers.some((blocker) => blocker.startsWith('source_'))) {
    return { action: 'fetch_focused_source', reason: 'Retrieve the missing or incomplete returned source before proceeding.' };
  }
  if (blockers.length > 0) {
    return { action: 'focused_follow_up', reason: blockers[0] ?? 'Evidence is not complete enough for this action.' };
  }
  return { action: 'answer_from_returned_evidence', reason: 'Returned evidence is bounded and sufficient for explanation/localization only.' };
}

function validationRequirements(blockers: string[]): string[] {
  const requirements = new Set(DEFAULT_VALIDATION);
  if (blockers.includes('freshness_unknown') || blockers.includes('stale_evidence')) {
    requirements.add('sync_or_read_stale_files_before_acting');
  }
  if (blockers.includes('ambiguous_symbol')) requirements.add('qualified_symbol_required');
  if (blockers.includes('bounded_no_static_path')) requirements.add('frontier_inspection_required');
  return [...requirements].sort((a, b) => a.localeCompare(b));
}
