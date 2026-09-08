export * from './architecture-health-types';
export { deriveArchitectureHealth } from './architecture-health';
export type { ArchitectureHealthDerivationInput } from './architecture-health';
export { compareSnapshotHealthDrift } from './architecture-health-drift';
export type {
  SnapshotHealthDriftComparableReport,
  SnapshotHealthDriftComparisonInput,
} from './architecture-health-drift';
export { buildArchitectureReport } from './architecture-report';
export type {
  ArchitectureManifestPackage,
  ArchitectureReportProjectionInput,
} from './architecture-report';
export {
  canonicalJson,
  canonicalizeArchitectureHealthReport,
  canonicalizeSnapshotHealthDrift,
  createCoverageFingerprint,
  createFindingId,
  normalizeArchitectureHealthOptions,
  parseLayerRules,
} from './architecture-health-normalization';
