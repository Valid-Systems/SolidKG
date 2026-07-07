export type ContextBudgetBaselineKind =
  | 'changed_files'
  | 'candidate_files'
  | 'candidate_symbols'
  | 'diff'
  | 'not_available';

export type ContextBudgetEstimatorVersion = 'chars_div_4_v1';

type AvailableContextBudgetBaselineKind = Exclude<ContextBudgetBaselineKind, 'not_available'>;

export interface ContextBudget {
  estimated: true;
  baselineKind: ContextBudgetBaselineKind;
  baselineChars: number | null;
  baselineTokens: number | null;
  outputChars: number;
  outputTokens: number;
  savedTokens: number | null;
  savedPercent: number | null;
  estimatorVersion: ContextBudgetEstimatorVersion;
  notes: string[];
}

export type BuildContextBudgetArgs =
  | {
      baselineKind: AvailableContextBudgetBaselineKind;
      baselineChars: number;
      outputChars: number;
      notes?: string[];
    }
  | {
      baselineKind: 'not_available';
      outputChars: number;
      notes?: string[];
    };

export function estimateCharsAsTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function buildContextBudget(args: BuildContextBudgetArgs): ContextBudget {
  const outputTokens = estimateCharsAsTokens(args.outputChars);
  const notes = args.notes ?? [];

  if (args.baselineKind === 'not_available') {
    return {
      estimated: true,
      baselineKind: args.baselineKind,
      baselineChars: null,
      baselineTokens: null,
      outputChars: args.outputChars,
      outputTokens,
      savedTokens: null,
      savedPercent: null,
      estimatorVersion: 'chars_div_4_v1',
      notes,
    };
  }

  const baselineTokens = estimateCharsAsTokens(args.baselineChars);
  const savedTokens = baselineTokens - outputTokens;

  return {
    estimated: true,
    baselineKind: args.baselineKind,
    baselineChars: args.baselineChars,
    baselineTokens,
    outputChars: args.outputChars,
    outputTokens,
    savedTokens,
    savedPercent: baselineTokens === 0 ? null : (savedTokens / baselineTokens) * 100,
    estimatorVersion: 'chars_div_4_v1',
    notes,
  };
}
