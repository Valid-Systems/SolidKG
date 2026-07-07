import { normalizeOverviewPath } from './path';
import type { OverviewNode, OverviewTree, OverviewTreeOptions } from './types';

const DIRECTORY_LABEL = '.';
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_ENTRIES = 160;
const ANCHOR_AGGREGATE_FILE_LIMIT = 100;
const LARGE_CHILDREN_COLLAPSE_LIMIT = 80;

export function formatOverviewTree(tree: OverviewTree, options: OverviewTreeOptions = {}): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const includeMetadata = options.includeMetadata !== false;
  const expandPaths = new Set((options.expandPaths ?? []).map(normalizeOverviewPath));
  const lines: string[] = [
    `## Repository Overview (${tree.totalFiles} files, ${tree.totalSymbols} symbols)`,
    '',
  ];
  let emitted = 0;

  const pushLine = (line: string): boolean => {
    if (emitted >= maxEntries) return false;
    lines.push(line);
    emitted += 1;
    return true;
  };

  pushLine(`${displayName(tree.root)}${includeMetadata ? formatSummary(tree.root) : ''}`);
  const rootChildren = visibleChildren(tree.root, 0, { maxDepth, expandPaths });
  for (const [index, child] of rootChildren.entries()) {
    renderNode(
      { node: child, prefix: '', isLast: index === rootChildren.length - 1, depth: 1 },
      { maxDepth, includeMetadata, expandPaths, pushLine, emitted: () => emitted, maxEntries },
    );
  }

  if (emitted >= maxEntries) {
    lines.push(`... output capped at ${maxEntries} entries; narrow path, lower maxDepth, or use expandPaths for focused disclosure.`);
  }
  return lines.join('\n');
}

interface RenderState {
  readonly maxDepth: number;
  readonly includeMetadata: boolean;
  readonly expandPaths: Set<string>;
  readonly pushLine: (line: string) => boolean;
  readonly emitted: () => number;
  readonly maxEntries: number;
}

interface RenderBranch {
  readonly node: OverviewNode;
  readonly prefix: string;
  readonly isLast: boolean;
  readonly depth: number;
}

interface DisclosureState {
  readonly maxDepth: number;
  readonly expandPaths: Set<string>;
}

function renderNode(branch: RenderBranch, state: RenderState): void {
  if (state.emitted() >= state.maxEntries) return;
  const connector = branch.isLast ? '└── ' : '├── ';
  const childPrefix = branch.isLast ? '    ' : '│   ';
  const disclosure = { maxDepth: state.maxDepth, expandPaths: state.expandPaths };
  const shouldDescend = shouldDescendInto(branch.node, branch.depth, disclosure);
  const line = `${branch.prefix}${connector}${displayName(branch.node)}${state.includeMetadata ? formatSummary(branch.node) : ''}${branch.node.kind === 'directory' && !shouldDescend ? formatCollapsed(branch.node) : ''}`;
  if (!state.pushLine(line) || !shouldDescend) return;

  const children = visibleChildren(branch.node, branch.depth, disclosure);
  for (const [index, child] of children.entries()) {
    renderNode(
      { node: child, prefix: branch.prefix + childPrefix, isLast: index === children.length - 1, depth: branch.depth + 1 },
      state,
    );
  }
}

function displayName(node: OverviewNode): string {
  if (node.path === '') return DIRECTORY_LABEL;
  return node.kind === 'directory' ? `${node.name}/` : node.name;
}

function formatSummary(node: OverviewNode): string {
  const parts: string[] = [];
  if (node.kind === 'directory') parts.push(`${node.fileCount} files`);
  if (node.symbolCount > 0) parts.push(`${node.symbolCount} symbols`);
  if (node.languages.length > 0) parts.push(node.languages.map((entry) => `${entry.language} ${entry.fileCount}`).join(', '));
  if (node.nodeKinds.length > 0) parts.push(node.nodeKinds.map((entry) => `${entry.kind} ${entry.count}`).join(', '));
  if (node.architecture?.layers.length) parts.push(`layers: ${node.architecture.layers.join(', ')}`);
  if (shouldShowAnchors(node)) parts.push(`anchors: ${node.notableSymbols.map((symbol) => symbol.name).join(', ')}`);
  return parts.length > 0 ? ` — ${parts.join('; ')}` : '';
}

function shouldShowAnchors(node: OverviewNode): boolean {
  if (node.notableSymbols.length === 0) return false;
  if (node.path === DIRECTORY_LABEL || node.path === '') return false;
  return node.kind === 'file' || node.fileCount <= ANCHOR_AGGREGATE_FILE_LIMIT;
}

function formatCollapsed(node: OverviewNode): string {
  if (node.children.length === 0) return '';
  const dirs = node.children.filter((child) => child.kind === 'directory').length;
  const files = node.children.length - dirs;
  const parts: string[] = [];
  if (dirs > 0) parts.push(`${dirs} dirs`);
  if (files > 0) parts.push(`${files} files`);
  return parts.length > 0 ? ` (${parts.join(', ')} collapsed)` : '';
}

function shouldDescendInto(node: OverviewNode, depth: number, disclosure: DisclosureState): boolean {
  if (node.kind !== 'directory' || node.children.length === 0) return false;
  if (!disclosure.expandPaths.has(node.path) && !hasExpandedDescendant(node.path, disclosure.expandPaths) && depth + 1 >= disclosure.maxDepth && node.children.length > LARGE_CHILDREN_COLLAPSE_LIMIT) return false;
  if (depth < disclosure.maxDepth) return true;
  return disclosure.expandPaths.has(node.path) || hasExpandedDescendant(node.path, disclosure.expandPaths);
}

function visibleChildren(node: OverviewNode, depth: number, disclosure: DisclosureState): OverviewNode[] {
  if (depth < disclosure.maxDepth || disclosure.expandPaths.has(node.path)) return [...node.children];
  if (!hasExpandedDescendant(node.path, disclosure.expandPaths)) return [];
  return node.children.filter((child) => disclosure.expandPaths.has(child.path) || hasExpandedDescendant(child.path, disclosure.expandPaths));
}

function hasExpandedDescendant(pathValue: string, expandPaths: Set<string>): boolean {
  const prefix = pathValue ? `${pathValue}/` : '';
  for (const expanded of expandPaths) {
    if (expanded.startsWith(prefix) && expanded !== pathValue) return true;
  }
  return false;
}
