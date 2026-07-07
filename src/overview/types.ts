import type { FileRecord, Node } from '../types';

export interface OverviewTreeOptions {
  readonly path?: string;
  readonly pattern?: string;
  readonly maxDepth?: number;
  readonly expandPaths?: readonly string[];
  readonly includeMetadata?: boolean;
  readonly maxEntries?: number;
}

export interface OverviewArchitectureAssignment {
  readonly filePath: string;
  readonly packageName: string;
  readonly layerName: string;
}

export interface OverviewBuildInput {
  readonly files: readonly FileRecord[];
  readonly nodes?: readonly Node[];
  readonly architectureAssignments?: readonly OverviewArchitectureAssignment[];
}

export interface OverviewLanguageSummary {
  readonly language: string;
  readonly fileCount: number;
}

export interface OverviewKindSummary {
  readonly kind: string;
  readonly count: number;
}

export interface OverviewArchitectureSummary {
  readonly packages: readonly string[];
  readonly layers: readonly string[];
}

export interface OverviewSymbolSummary {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly visibility?: Node['visibility'];
  readonly isExported?: boolean;
}

export interface OverviewNode {
  readonly kind: 'directory' | 'file';
  readonly name: string;
  readonly path: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symbolCount: number;
  readonly languages: readonly OverviewLanguageSummary[];
  readonly nodeKinds: readonly OverviewKindSummary[];
  readonly notableSymbols: readonly OverviewSymbolSummary[];
  readonly architecture?: OverviewArchitectureSummary;
  readonly children: readonly OverviewNode[];
}

export interface OverviewTree {
  readonly root: OverviewNode;
  readonly totalFiles: number;
  readonly totalDirectories: number;
  readonly totalSymbols: number;
}

export interface MutableOverviewNode {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  fileCount: number;
  directoryCount: number;
  symbolCount: number;
  languages: Map<string, number>;
  nodeKinds: Map<string, number>;
  notableSymbols: OverviewSymbolSummary[];
  packages: Map<string, number>;
  layers: Map<string, number>;
  children: Map<string, MutableOverviewNode>;
}

export interface OverviewFileFacts {
  readonly file: FileRecord;
  readonly symbols: readonly OverviewSymbolSummary[];
  readonly overviewPath: string;
  readonly architecture?: OverviewArchitectureSummary;
}
