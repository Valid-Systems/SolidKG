import type { Language } from '../types';

export const CAPABILITY_FOOTPRINT_SCHEMA = 'solidkg.capability-footprint.v1';

export const CAPABILITY_OPERATIONS = [
  'read',
  'write',
  'guard',
  'emit',
  'subscribe',
  'send',
  'mutate',
] as const;

export type CapabilityOperation = (typeof CAPABILITY_OPERATIONS)[number];

export const CAPABILITY_RESOURCE_KINDS = [
  'datastore',
  'config',
  'auth',
  'channel',
  'filesystem',
  'network',
  'process',
  'state',
  'ui',
] as const;

export type CapabilityResourceKind = (typeof CAPABILITY_RESOURCE_KINDS)[number];

export type CapabilityOrigin = 'ast' | 'scip' | 'framework_resolver' | 'semantic_synthesis' | 'annotation';
export type CapabilityCertainty = 'precise' | 'static' | 'heuristic' | 'unverified';
export type CapabilityScope = 'node_scoped' | 'callsite_scoped' | 'relation_scoped';
export type CapabilityAnalysisStatus = 'complete' | 'partial' | 'unsupported' | 'failed';
export type CapabilityCoverageState = CapabilityAnalysisStatus | 'not_run' | 'stale';

export type CapabilityMetadataValue = string | number | boolean;
export type BoundedValidatedMetadata = Record<string, CapabilityMetadataValue>;

export interface CapabilityAssertion {
  readonly id: string;
  readonly subjectNodeId: string;
  readonly operation: CapabilityOperation;
  readonly resourceKind: CapabilityResourceKind;
  readonly resourceKey: string;
  readonly targetNodeId?: string;
  readonly scope: CapabilityScope;
  readonly filePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly origin: CapabilityOrigin;
  readonly certainty: CapabilityCertainty;
  readonly producerId: string;
  readonly ruleId: string;
  readonly producerVersion: string;
  readonly supportingHyperedgeId?: string;
  readonly metadata?: BoundedValidatedMetadata;
}

export interface CapabilityAnalysisRun {
  readonly filePath: string;
  readonly producerId: string;
  readonly producerVersion: string;
  readonly sourceHash: string;
  readonly status: CapabilityAnalysisStatus;
  readonly diagnostics?: string;
  readonly updatedAt: number;
}

export interface CapabilityAnalysisInput {
  readonly filePath: string;
  readonly language: Language;
  readonly content: string;
  readonly sourceHash: string;
  readonly nodes: readonly import('../types').Node[];
}

export interface CapabilityAnalysisResult {
  readonly assertions: readonly CapabilityAssertion[];
  readonly run: CapabilityAnalysisRun;
}
