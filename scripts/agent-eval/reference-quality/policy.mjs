export const REPORT_SCHEMA = 'solidkg.reference-quality.report.v1';
export const METRIC_POLICY_VERSION = 'solidkg.reference-quality.metric-policy.v1';

export const DECLARATION_KINDS = Object.freeze([
  'class', 'struct', 'interface', 'trait', 'protocol', 'function', 'method', 'property', 'field',
  'variable', 'constant', 'enum', 'enum_member', 'type_alias', 'namespace', 'route', 'component',
]);

export const ANY_EDGE_KINDS = Object.freeze([
  'calls', 'imports', 'exports', 'extends', 'implements', 'references', 'type_of', 'returns',
  'instantiates', 'overrides', 'decorates',
]);

export const SEMANTIC_EDGE_KINDS = Object.freeze([
  'calls', 'extends', 'implements', 'references', 'type_of', 'returns', 'instantiates', 'overrides',
  'decorates',
]);

export const IMPORT_EDGE_KINDS = Object.freeze(['imports', 'exports']);
export const AVAILABILITY_STATUSES = Object.freeze([
  'absent', 'incompatible_columns', 'available_empty', 'available_nonempty', 'malformed_data',
  'query_error',
]);
export const COMPARISON_STATUSES = Object.freeze([
  'improved', 'regressed', 'changed', 'unchanged', 'added', 'removed', 'not_comparable',
]);

export const METRIC_DIRECTIONS = Object.freeze({
  anyCrossFileCoverage: 'higher',
  semanticCrossFileCoverage: 'higher',
  routeHandlerLinkRate: 'higher',
  routeBindingIntegrityRate: 'higher',
  sourceChunkNodeCoverage: 'higher',
  scipDocumentCoverage: 'higher',
  scipLinkedNodeCoverage: 'higher',
  capabilityCompleteRate: 'higher',
  latencyMs: 'neutral',
  payloadBytes: 'neutral',
  unresolvedPerThousand: 'neutral',
  fileErrorRate: 'neutral',
  danglingRows: 'neutral',
  orphanRows: 'neutral',
  heuristicShare: 'neutral',
  provenanceDistribution: 'neutral',
  synthesizedFamilies: 'neutral',
  statusDistribution: 'neutral',
});

export function isAvailabilityStatus(value) {
  return AVAILABILITY_STATUSES.includes(value);
}

export function isPortablePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return !/^(?:[a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(value);
}

export function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(3)),
  };
}

export function compareRatio(before, after) {
  if (!before || !after || before.denominator !== after.denominator || before.denominator === 0) {
    return 'not_comparable';
  }
  const left = after.numerator * before.denominator;
  const right = before.numerator * after.denominator;
  if (left === right) return 'unchanged';
  return left > right ? 'improved' : 'regressed';
}
