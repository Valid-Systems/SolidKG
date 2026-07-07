import type { SearchResult } from '../../src/types.ts';
import type { AiderCentralityTrial } from './aider-centrality.mts';

export type QueryKind = 'body_query' | 'exact_query_control' | 'trace_control' | 'demotion_control' | 'no_match_control';

export type ExpectedLine = { readonly filePath: string; readonly startLine: number; readonly endLine: number };
export type ExpectedChunk = { readonly id: string; readonly filePath: string; readonly startLine: number; readonly endLine: number };

export type ExpectedSet = {
  readonly symbols: readonly string[];
  readonly chunks: readonly ExpectedChunk[];
  readonly files: readonly string[];
  readonly lines: readonly ExpectedLine[];
};

export type TopResult = {
  readonly rank: number;
  readonly symbol: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly rankingReasons: readonly string[];
  readonly chunkEvidence: readonly string[];
};

export type RetrievalMetrics = {
  readonly recallAtK: number;
  readonly mrr: number;
  readonly sourceReferenceFidelity: number;
  readonly topResults: readonly TopResult[];
};

export type TraceControl = {
  readonly found: boolean;
  readonly sourceReferenceFidelity: number;
  readonly outputChars: number;
  readonly toolCalls: number;
  readonly readCount: number;
  readonly grepCount: number;
};

export type QueryReport = {
  readonly id: string;
  readonly kind: QueryKind;
  readonly query: string;
  readonly expected: ExpectedSet;
  readonly metadataOnly: RetrievalMetrics;
  readonly fused: RetrievalMetrics;
  readonly traceControl?: TraceControl;
  readonly controlSignals: {
    readonly exactIntentPreserved: boolean;
    readonly generatedOrTestDemoted: boolean;
    readonly materialBodyImprovement: boolean;
  };
  readonly boundedNoResult: boolean;
  readonly pass: boolean;
};

export type AgentEvalProbe = {
  readonly id: string;
  readonly command: string;
  readonly status: 'pass' | 'not_feasible';
  readonly outputChars: number;
  readonly readCount: number;
  readonly grepCount: number;
  readonly toolCalls: number;
  readonly note: string;
};

export type ExploreSurfaceProbe = {
  readonly query: string;
  readonly maxFiles: number;
  readonly firstSourceFile: string | null;
  readonly expectedFirstFile: string;
  readonly graphRankedNotice: boolean;
  readonly outputChars: number;
  readonly pass: boolean;
};

export type RetrievalQualityReport = {
  readonly schemaName: 'solidkg.retrieval-quality.codeseek.v1';
  readonly generatedAt: string;
  readonly fixture: { readonly name: string; readonly root: string; readonly files: readonly string[] };
  readonly qualityBar: {
    readonly bodySourceBehaviorMustImprove: boolean;
    readonly exactPathTraceControlsMustNotRegress: boolean;
    readonly aiderStyleRankingIsFollowUpOnly: boolean;
  };
  readonly budgetRelevanceCriterion: {
    readonly measuredOnly: true;
    readonly currentRelevantTopKShare: number;
    readonly futureMaterialityThreshold: string;
  };
  readonly summary: {
    readonly pass: boolean;
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly meanRecallAtK: number;
    readonly meanMrr: number;
    readonly meanSourceReferenceFidelity: number;
    readonly materialBodyImprovement: boolean;
    readonly controlsPass: boolean;
    readonly externalServicesUsed: readonly string[];
  };
  readonly queries: readonly QueryReport[];
  readonly aiderCentralityTrial?: AiderCentralityTrial;
  readonly exploreSurfaceProbe?: ExploreSurfaceProbe;
  readonly agentEvalProbes: readonly AgentEvalProbe[];
};

export type HarnessOptions = {
  readonly outputDir?: string;
  readonly fixtureRoot?: string;
  readonly writeArtifacts?: boolean;
};

export type QueryReportInput = {
  readonly id: string;
  readonly kind: QueryKind;
  readonly query: string;
  readonly expected: ExpectedSet;
  readonly results: readonly SearchResult[];
};
