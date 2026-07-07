import type SolidKG from '../index';

export interface FileListEntry {
  readonly path: string;
  readonly language: string;
  readonly nodeCount: number;
}

export interface LayerRule {
  readonly name: string;
  readonly paths: string[];
}

function isLayerRule(value: unknown): value is LayerRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'name' in value
    && 'paths' in value
    && typeof value.name === 'string'
    && Array.isArray(value.paths)
    && value.paths.every((path): path is string => typeof path === 'string');
}

export function formatArchitecturePackageLookup(lookup: ReturnType<SolidKG['getPackageLookup']>): string {
  if (!lookup.package) {
    if (lookup.kind === 'path') {
      const layerSuggestion = formatArchitectureLayerSuggestion(lookup.matchedPath ?? lookup.query);
      return [
        `No indexed files matched path "${lookup.query}".`,
        'Package lookup returns manifest/root package rollups, not arbitrary path-scoped package metrics.',
        `For path-level coupling, run solidkg_architecture with action="analyze" and layersJson=${layerSuggestion}, then inspect action="coupling" layers.`,
      ].join('\n');
    }
    return `Package "${lookup.query}" not found.`;
  }

  if (lookup.kind === 'path' && lookup.resolvedBy === 'owning_package') {
    const matchedPath = lookup.matchedPath ?? lookup.query;
    const layerSuggestion = formatArchitectureLayerSuggestion(matchedPath);
    return [
      `Path "${lookup.query}" resolved to owning package "${lookup.package.name}" at root "${lookup.package.root}".`,
      `Matched files under "${matchedPath}": ${lookup.matchedFileCount ?? 0}.`,
      `The rollup below is package-level, not scoped only to "${lookup.query}".`,
      `For path-level coupling, run solidkg_architecture with action="analyze" and layersJson=${layerSuggestion}, then inspect action="coupling" layers.`,
      '',
      JSON.stringify(lookup.package, null, 2),
    ].join('\n');
  }

  return JSON.stringify(lookup.package, null, 2);
}

export function formatArchitectureLayerSuggestion(pathPrefix: string): string {
  const normalized = pathPrefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const pathPattern = normalized ? `${normalized}/**` : '**';
  return JSON.stringify([{ name: normalized || 'path-scope', paths: [pathPattern] }]);
}

export function parseLayerRules(value: unknown): LayerRule[] | string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'layersJson must be a JSON string';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return 'layersJson must be a JSON array';
    const rules: LayerRule[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'each layer rule must be an object';
      if (!isLayerRule(entry)) {
        return 'each layer rule must have a string name and string[] paths';
      }
      rules.push({ name: entry.name, paths: entry.paths });
    }
    return rules;
  } catch (err) {
    return `layersJson is invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function formatSnapshotList(snapshots: Awaited<ReturnType<SolidKG['listSnapshots']>>): string {
  if (snapshots.length === 0) return 'No graph snapshots saved.';
  const lines = ['## Graph Snapshots', ''];
  for (const snapshot of snapshots) {
    lines.push(`- ${snapshot.label}: ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges, ${snapshot.hyperedgeCount} hyperedges (${new Date(snapshot.createdAt).toISOString()})`);
    if (snapshot.description) lines.push(`  ${snapshot.description}`);
  }
  return lines.join('\n');
}

export function formatSnapshotDiff(label: string, diff: Awaited<ReturnType<SolidKG['diffSnapshot']>>): string {
  const lines = [`## Snapshot Diff: ${label}`, ''];
  const sections: Array<[string, unknown[]]> = [
    ['Added nodes', diff.addedNodes],
    ['Removed nodes', diff.removedNodes],
    ['Changed nodes', diff.changedNodes],
    ['Added edges', diff.addedEdges],
    ['Removed edges', diff.removedEdges],
    ['Changed edges', diff.changedEdges],
    ['Added hyperedges', diff.addedHyperedges],
    ['Removed hyperedges', diff.removedHyperedges],
    ['Changed hyperedges', diff.changedHyperedges],
    ['Added hyperedge members', diff.addedHyperedgeMembers],
    ['Removed hyperedge members', diff.removedHyperedgeMembers],
    ['Changed hyperedge members', diff.changedHyperedgeMembers],
  ];
  for (const [name, records] of sections) {
    lines.push(`### ${name}: ${records.length}`);
    for (const record of records.slice(0, 20)) {
      lines.push(`- ${JSON.stringify(record)}`);
    }
    if (records.length > 20) lines.push(`- +${records.length - 20} more`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatArchitectureReport(report: ReturnType<SolidKG['getArchitecture']>): string {
  const lines = ['## Architecture Rollup', ''];
  lines.push(`**Packages:** ${report.packages.length}`);
  for (const pkg of report.packages) {
    const metric = report.coupling.packages.find((entry) => entry.name === pkg.name);
    const coupling = metric ? ` Ca=${metric.Ca} Ce=${metric.Ce} I=${metric.instability.toFixed(2)}` : '';
    lines.push(`- ${pkg.name} (${pkg.root}, ${pkg.fileCount} files)${coupling}`);
  }
  lines.push('', `**Layers:** ${report.layers.length}`);
  for (const layer of report.layers) {
    const metric = report.coupling.layers.find((entry) => entry.name === layer.name);
    const coupling = metric ? ` Ca=${metric.Ca} Ce=${metric.Ce} I=${metric.instability.toFixed(2)}` : '';
    lines.push(`- ${layer.name} (${layer.fileCount} files)${coupling}`);
  }
  lines.push('', `**Package dependencies:** ${report.packageDependencies.length}`);
  for (const dep of report.packageDependencies.slice(0, 50)) {
    lines.push(`- ${dep.source} -> ${dep.target} (${dep.edgeKinds.join(', ')})`);
  }
  if (report.packageDependencies.length > 50) lines.push(`- +${report.packageDependencies.length - 50} more`);
  lines.push('', `**Layer dependencies:** ${report.layerDependencies.length}`);
  for (const dep of report.layerDependencies.slice(0, 50)) {
    lines.push(`- ${dep.source} -> ${dep.target} (${dep.edgeKinds.join(', ')})`);
  }
  if (report.layerDependencies.length > 50) lines.push(`- +${report.layerDependencies.length - 50} more`);
  return lines.join('\n');
}

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function formatFilesFlat(files: readonly FileListEntry[], includeMetadata: boolean): string {
  const lines: string[] = [`## Files (${files.length})`, ''];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
  }
  return lines.join('\n');
}

export function formatFilesGrouped(files: readonly FileListEntry[], includeMetadata: boolean): string {
  const byLang = new Map<string, FileListEntry[]>();
  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }
  const lines: string[] = [`## Files by Language (${files.length} total)`, ''];
  const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [lang, langFiles] of sortedLangs) {
    lines.push(`### ${lang} (${langFiles.length})`);
    for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file?: { language: string; nodeCount: number };
}

export function formatFilesTree(files: readonly FileListEntry[], includeMetadata: boolean, maxDepth?: number): string {
  const root: TreeNode = { name: '', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      let child = current.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        current.children.set(part, child);
      }
      current = child;
      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const lines: string[] = [`## Project Structure (${files.length} files)`, ''];
  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
      }
      lines.push(line);
    }
    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const [i, child] of children.entries()) {
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };
  renderNode(root, '', true, 0);
  return lines.join('\n');
}
