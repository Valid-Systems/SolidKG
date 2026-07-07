import { describe, it, expect } from 'vitest';
import { buildContextBudget, estimateCharsAsTokens } from '../src/context/budget';

describe('estimateCharsAsTokens', () => {
  it('uses the chars/4 estimator with ceiling rounding', () => {
    expect(estimateCharsAsTokens(0)).toBe(0);
    expect(estimateCharsAsTokens(1)).toBe(1);
    expect(estimateCharsAsTokens(4)).toBe(1);
    expect(estimateCharsAsTokens(5)).toBe(2);
  });
});

describe('buildContextBudget', () => {
  it('reports positive savings against changed files', () => {
    const budget = buildContextBudget({
      baselineKind: 'changed_files',
      baselineChars: 400,
      outputChars: 100,
      notes: ['compared with changed files only'],
    });

    expect(budget).toEqual({
      estimated: true,
      baselineKind: 'changed_files',
      baselineChars: 400,
      baselineTokens: 100,
      outputChars: 100,
      outputTokens: 25,
      savedTokens: 75,
      savedPercent: 75,
      estimatorVersion: 'chars_div_4_v1',
      notes: ['compared with changed files only'],
    });
  });

  it('uses explicit null baseline and savings fields when no baseline is available', () => {
    const budget = buildContextBudget({
      baselineKind: 'not_available',
      outputChars: 128,
    });

    expect(budget).toEqual({
      estimated: true,
      baselineKind: 'not_available',
      baselineChars: null,
      baselineTokens: null,
      outputChars: 128,
      outputTokens: 32,
      savedTokens: null,
      savedPercent: null,
      estimatorVersion: 'chars_div_4_v1',
      notes: [],
    });
    expect(JSON.stringify(budget)).toContain('"baselineTokens":null');
    expect(JSON.stringify(budget)).toContain('"savedTokens":null');
  });

  it('allows negative savings when output exceeds the baseline', () => {
    const budget = buildContextBudget({
      baselineKind: 'diff',
      baselineChars: 40,
      outputChars: 100,
    });

    expect(budget.baselineTokens).toBe(10);
    expect(budget.outputTokens).toBe(25);
    expect(budget.savedTokens).toBe(-15);
    expect(budget.savedPercent).toBe(-150);
  });

  it('supports every honest baseline kind without whole-repo baselines', () => {
    const baselineKinds = ['changed_files', 'candidate_files', 'candidate_symbols', 'diff'] as const;

    for (const baselineKind of baselineKinds) {
      expect(buildContextBudget({ baselineKind, baselineChars: 16, outputChars: 4 })).toMatchObject({
        baselineKind,
        baselineTokens: 4,
        outputTokens: 1,
        savedTokens: 3,
      });
    }
  });
});
