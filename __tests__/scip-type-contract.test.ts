import { describe, expect, it } from 'vitest';
import { HYPEREDGE_KINDS } from '../src/types';

describe('SCIP type_contract relation kind', () => {
  it('type_contract is represented as a distinct hyperedge kind', () => {
    expect(HYPEREDGE_KINDS).toContain('type_contract');
  });
});
