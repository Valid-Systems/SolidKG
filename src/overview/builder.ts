import type { Node } from '../types';
import { pathMatchesRootAwarePrefix } from '../utils';
import { globToOverviewRegex, normalizeOverviewPath } from './path';
import type {
  MutableOverviewNode,
  OverviewArchitectureAssignment,
  OverviewArchitectureSummary,
  OverviewBuildInput,
  OverviewFileFacts,
  OverviewKindSummary,
  OverviewLanguageSummary,
  OverviewNode,
  OverviewSymbolSummary,
  OverviewTree,
  OverviewTreeOptions,
} from './types';

const DIRECTORY_LABEL = '.';
const NOTABLE_SYMBOL_LIMIT = 4;
const SUMMARY_LIMIT = 3;
const TEST_PATH_SEGMENTS = new Set(['test', 'tests', '__tests__', 'fixture', 'fixtures', 'mock', 'mocks']);

const SYMBOL_KIND_PRIORITY = new Map<string, number>([
  ['route', 0],
  ['component', 1],
  ['class', 2],
  ['interface', 3],
  ['function', 4],
  ['method', 5],
  ['type_alias', 6],
]);

export function buildOverviewTree(input: OverviewBuildInput, options: OverviewTreeOptions = {}): OverviewTree {
  const root = createMutableNode('directory', DIRECTORY_LABEL, '');
  const architectureByFile = buildArchitectureLookup(input.architectureAssignments ?? []);
  const symbolsByFile = buildSymbolsByFile(input.nodes ?? []);
  const patternRegex = options.pattern ? globToOverviewRegex(options.pattern) : undefined;
  const targetPath = normalizeOverviewPath(options.path ?? '');

  for (const file of input.files) {
    const overviewPath = overviewPathFor(file.path, targetPath);
    if (targetPath && !overviewPath) continue;
    if (patternRegex && !patternRegex.test(overviewPath ?? normalizeOverviewPath(file.path))) continue;
    const architecture = architectureByFile.get(file.path);
    const facts = architecture
      ? { file, symbols: symbolsByFile.get(file.path) ?? [], overviewPath: overviewPath ?? normalizeOverviewPath(file.path), architecture }
      : { file, symbols: symbolsByFile.get(file.path) ?? [], overviewPath: overviewPath ?? normalizeOverviewPath(file.path) };
    insertFile(root, facts);
  }

  const focused = targetPath ? findMutableNode(root, targetPath) ?? createMissingFocusNode(targetPath) : root;
  const immutableRoot = freezeNode(focused);
  return {
    root: immutableRoot,
    totalFiles: immutableRoot.fileCount,
    totalDirectories: immutableRoot.directoryCount,
    totalSymbols: immutableRoot.symbolCount,
  };
}

function createMutableNode(kind: 'directory' | 'file', name: string, nodePath: string): MutableOverviewNode {
  return {
    kind,
    name,
    path: nodePath,
    fileCount: 0,
    directoryCount: 0,
    symbolCount: 0,
    languages: new Map(),
    nodeKinds: new Map(),
    notableSymbols: [],
    packages: new Map(),
    layers: new Map(),
    children: new Map(),
  };
}

function createMissingFocusNode(targetPath: string): MutableOverviewNode {
  const parts = targetPath.split('/').filter((part) => part.length > 0);
  return createMutableNode('directory', parts[parts.length - 1] ?? targetPath, targetPath);
}

function insertFile(
  root: MutableOverviewNode,
  facts: OverviewFileFacts,
): void {
  const parts = facts.overviewPath.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return;
  const lineage = [root];
  let current = root;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const childPath = parts.slice(0, index + 1).join('/');
    const isFile = index === parts.length - 1;
    let child = current.children.get(part);
    if (!child) {
      child = createMutableNode(isFile ? 'file' : 'directory', part, childPath);
      current.children.set(part, child);
    }
    current = child;
    lineage.push(current);
  }

  for (const node of lineage) {
    addFileFacts(node, facts);
  }
}

function addFileFacts(
  node: MutableOverviewNode,
  facts: OverviewFileFacts,
): void {
  node.fileCount += 1;
  node.symbolCount += facts.file.nodeCount;
  increment(node.languages, facts.file.language);
  for (const symbol of facts.symbols) {
    increment(node.nodeKinds, symbol.kind);
    addNotableSymbol(node, symbol);
  }
  if (!facts.architecture) return;
  for (const packageName of facts.architecture.packages) increment(node.packages, packageName);
  for (const layerName of facts.architecture.layers) increment(node.layers, layerName);
}

function buildArchitectureLookup(assignments: readonly OverviewArchitectureAssignment[]): Map<string, OverviewArchitectureSummary> {
  const byFile = new Map<string, OverviewArchitectureSummary>();
  for (const assignment of assignments) {
    byFile.set(assignment.filePath, {
      packages: [assignment.packageName],
      layers: [assignment.layerName],
    });
  }
  return byFile;
}

function buildSymbolsByFile(nodes: readonly Node[]): Map<string, OverviewSymbolSummary[]> {
  const byFile = new Map<string, OverviewSymbolSummary[]>();
  for (const node of nodes) {
    if (node.kind === 'file' || node.kind === 'module' || node.kind === 'import' || node.kind === 'export' || node.kind === 'parameter') continue;
    const existing = byFile.get(node.filePath) ?? [];
    existing.push({
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
      ...(node.visibility !== undefined ? { visibility: node.visibility } : {}),
      ...(node.isExported !== undefined ? { isExported: node.isExported } : {}),
    });
    byFile.set(node.filePath, existing);
  }
  for (const [filePath, symbols] of byFile) {
    byFile.set(filePath, symbols.sort(compareSymbols));
  }
  return byFile;
}

function overviewPathFor(filePath: string, targetPath: string): string | undefined {
  const normalizedFile = normalizeOverviewPath(filePath);
  if (!targetPath) return normalizedFile;
  if (!pathMatchesRootAwarePrefix(normalizedFile, targetPath)) return undefined;
  if (targetPath.startsWith('@')) return normalizedFile;
  return normalizedFile.replace(/^@[^/]+\//, '');
}

function findMutableNode(root: MutableOverviewNode, targetPath: string): MutableOverviewNode | undefined {
  let current: MutableOverviewNode | undefined = root;
  for (const part of normalizeOverviewPath(targetPath).split('/').filter((entry) => entry.length > 0)) {
    current = current?.children.get(part);
    if (!current) return undefined;
  }
  return current;
}

function freezeNode(node: MutableOverviewNode): OverviewNode {
  const children = [...node.children.values()].sort(compareNodes).map(freezeNode);
  return {
    kind: node.kind,
    name: node.name,
    path: node.path,
    fileCount: node.fileCount,
    directoryCount: children.filter((child) => child.kind === 'directory').reduce((sum, child) => sum + child.directoryCount + 1, 0),
    symbolCount: node.symbolCount,
    languages: summarizeLanguages(node.languages),
    nodeKinds: summarizeKinds(node.nodeKinds),
    notableSymbols: [...node.notableSymbols].sort(compareSymbols).slice(0, NOTABLE_SYMBOL_LIMIT),
    architecture: buildArchitectureSummary(node),
    children,
  };
}

function buildArchitectureSummary(node: MutableOverviewNode): OverviewArchitectureSummary | undefined {
  const packages = summarizeNames(node.packages);
  const layers = summarizeNames(node.layers);
  if (packages.length === 0 && layers.length === 0) return undefined;
  return { packages, layers };
}

function summarizeLanguages(map: Map<string, number>): OverviewLanguageSummary[] {
  return sortedSummaryEntries(map).map(([language, fileCount]) => ({ language, fileCount }));
}

function summarizeKinds(map: Map<string, number>): OverviewKindSummary[] {
  return sortedSummaryEntries(map).map(([kind, count]) => ({ kind, count }));
}

function summarizeNames(map: Map<string, number>): string[] {
  return sortedSummaryEntries(map).map(([name]) => name);
}

function sortedSummaryEntries(map: Map<string, number>): Array<readonly [string, number]> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, SUMMARY_LIMIT);
}

function addNotableSymbol(node: MutableOverviewNode, symbol: OverviewSymbolSummary): void {
  if (!isAnchorCandidate(symbol)) return;
  if (node.notableSymbols.some((existing) => symbolAnchorKey(existing) === symbolAnchorKey(symbol))) return;
  node.notableSymbols.push(symbol);
  node.notableSymbols.sort(compareSymbols);
  if (node.notableSymbols.length > NOTABLE_SYMBOL_LIMIT) node.notableSymbols.length = NOTABLE_SYMBOL_LIMIT;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function compareNodes(left: MutableOverviewNode | OverviewNode, right: MutableOverviewNode | OverviewNode): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function compareSymbols(left: OverviewSymbolSummary, right: OverviewSymbolSummary): number {
  return symbolRank(left) - symbolRank(right)
    || left.filePath.localeCompare(right.filePath)
    || left.name.localeCompare(right.name);
}

function isAnchorCandidate(symbol: OverviewSymbolSummary): boolean {
  const trimmed = symbol.name.trim();
  return SYMBOL_KIND_PRIORITY.has(symbol.kind) && trimmed.length > 1 && /[\p{L}\p{N}]/u.test(trimmed);
}

function symbolAnchorKey(symbol: OverviewSymbolSummary): string {
  return `${symbol.kind}:${symbol.name.trim().toLowerCase()}`;
}

function symbolRank(symbol: OverviewSymbolSummary): number {
  return symbolPriority(symbol.kind) * 1000
    + visibilityPriority(symbol)
    + pathPriority(symbol.filePath);
}

function visibilityPriority(symbol: OverviewSymbolSummary): number {
  if (symbol.isExported || symbol.visibility === 'public') return 0;
  if (symbol.visibility === 'protected' || symbol.visibility === 'internal') return 20;
  if (symbol.visibility === 'private') return 40;
  return 10;
}

function pathPriority(filePath: string): number {
  const segments = filePath.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => TEST_PATH_SEGMENTS.has(segment)) ? 100 : 0;
}

function symbolPriority(kind: string): number {
  return SYMBOL_KIND_PRIORITY.get(kind) ?? 100;
}
