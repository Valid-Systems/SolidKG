import type {
  ArchitectureDependency,
  ArchitectureFileAssignment,
  ArchitectureLayer,
  ArchitectureLayerRule,
  ArchitecturePackage,
  ArchitectureReport,
  CouplingMetric,
} from '../index';
import type { Edge, EdgeKind, FileRecord, Node } from '../types';

const architectureEdgeKinds = new Set<EdgeKind>([
  'imports',
  'references',
  'calls',
  'extends',
  'implements',
  'instantiates',
  'type_of',
]);

export type ArchitectureManifestPackage = {
  readonly root: string;
  readonly name: string;
};

export type ArchitectureReportProjectionInput = {
  readonly rootPackageName: string;
  readonly files: readonly FileRecord[];
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly manifests: readonly ArchitectureManifestPackage[];
  readonly layerRules: readonly ArchitectureLayerRule[];
};

export function buildArchitectureReport(input: ArchitectureReportProjectionInput): ArchitectureReport {
  const files = input.files.filter((file) => !file.path.endsWith('/package.json'));
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const manifestsByRoot = new Map(input.manifests.map((manifest) => [manifest.root, manifest]));
  const assignments = new Map<string, ArchitectureFileAssignment>();

  for (const file of files) {
    assignments.set(file.path, assignArchitectureFile(file.path, input.layerRules, manifestsByRoot, input.rootPackageName));
  }

  const packageDependencies = new Map<string, Set<EdgeKind>>();
  const layerDependencies = new Map<string, Set<EdgeKind>>();
  for (const edge of input.edges) {
    if (!architectureEdgeKinds.has(edge.kind)) continue;
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const source = assignments.get(sourceNode.filePath);
    const target = assignments.get(targetNode.filePath);
    if (!source || !target) continue;

    if (source.packageName !== target.packageName) {
      addDependencyKind(packageDependencies, source.packageName, target.packageName, edge.kind);
    }
    if (source.layerName !== target.layerName) {
      addDependencyKind(layerDependencies, source.layerName, target.layerName, edge.kind);
    }
  }

  const fileAssignments = [...assignments.values()].sort((left, right) => byCodePoint(left.filePath, right.filePath));
  const packages = buildPackages(fileAssignments);
  const layers = buildLayers(fileAssignments, input.layerRules);
  const packageDependencyList = dependencyMapToList(packageDependencies);
  const layerDependencyList = dependencyMapToList(layerDependencies);
  return {
    packages,
    layers,
    fileAssignments,
    packageDependencies: packageDependencyList,
    layerDependencies: layerDependencyList,
    coupling: {
      packages: couplingFromDependencies(packages.map((pkg) => pkg.name), packageDependencyList),
      layers: couplingFromDependencies(layers.map((layer) => layer.name), layerDependencyList),
    },
  };
}

function assignArchitectureFile(
  filePath: string,
  layerRules: readonly ArchitectureLayerRule[],
  manifestsByRoot: ReadonlyMap<string, ArchitectureManifestPackage>,
  rootPackageName: string,
): ArchitectureFileAssignment {
  const packageInfo = findPackageForFile(filePath, manifestsByRoot, rootPackageName);
  const layerRule = layerRules.find((rule) => rule.paths.some((pattern) => matchesLayerPath(filePath, pattern)));
  return {
    filePath,
    packageName: packageInfo.name,
    packageRoot: packageInfo.root,
    packageProvenance: packageInfo.provenance,
    layerName: layerRule?.name ?? 'unassigned',
    layerProvenance: layerRule ? 'config_layer' : 'unassigned',
  };
}

function findPackageForFile(
  filePath: string,
  manifestsByRoot: ReadonlyMap<string, ArchitectureManifestPackage>,
  rootPackageName: string,
): { readonly name: string; readonly root: string; readonly provenance: 'manifest' | 'root' } {
  let directory: string | null = directoryOf(filePath);
  while (directory !== null) {
    const manifest = manifestsByRoot.get(directory);
    if (manifest) return { name: manifest.name, root: manifest.root, provenance: 'manifest' };
    directory = parentDir(directory);
  }
  return { name: rootPackageName, root: '.', provenance: 'root' };
}

function addDependencyKind(
  dependencies: Map<string, Set<EdgeKind>>,
  source: string,
  target: string,
  kind: EdgeKind,
): void {
  const key = `${source}\0${target}`;
  const kinds = dependencies.get(key) ?? new Set<EdgeKind>();
  kinds.add(kind);
  dependencies.set(key, kinds);
}

function dependencyMapToList(dependencies: ReadonlyMap<string, ReadonlySet<EdgeKind>>): ArchitectureDependency[] {
  return [...dependencies.entries()]
    .map(([key, kinds]) => {
      const separator = key.indexOf('\0');
      return {
        source: key.slice(0, separator),
        target: key.slice(separator + 1),
        edgeKinds: [...kinds].sort(byCodePoint),
      };
    })
    .sort((left, right) => byCodePoint(left.source, right.source) || byCodePoint(left.target, right.target));
}

function buildPackages(assignments: readonly ArchitectureFileAssignment[]): ArchitecturePackage[] {
  const packagesByName = new Map<string, ArchitecturePackage>();
  for (const assignment of assignments) {
    const existing = packagesByName.get(assignment.packageName);
    if (existing) {
      existing.fileCount += 1;
      continue;
    }
    packagesByName.set(assignment.packageName, {
      name: assignment.packageName,
      root: assignment.packageRoot,
      provenance: assignment.packageProvenance === 'manifest' ? 'manifest' : 'root',
      fileCount: 1,
    });
  }
  return [...packagesByName.values()].sort((left, right) => byCodePoint(left.name, right.name));
}

function buildLayers(
  assignments: readonly ArchitectureFileAssignment[],
  layerRules: readonly ArchitectureLayerRule[],
): ArchitectureLayer[] {
  const layersByName = new Map<string, ArchitectureLayer>();
  for (const rule of layerRules) {
    layersByName.set(rule.name, { name: rule.name, provenance: 'config_layer', fileCount: 0 });
  }
  for (const assignment of assignments) {
    const existing = layersByName.get(assignment.layerName);
    if (existing) {
      existing.fileCount += 1;
      continue;
    }
    layersByName.set(assignment.layerName, {
      name: assignment.layerName,
      provenance: assignment.layerProvenance,
      fileCount: 1,
    });
  }
  return [...layersByName.values()]
    .filter((layer) => layer.fileCount > 0 || layer.name !== 'unassigned')
    .sort((left, right) => byCodePoint(left.name, right.name));
}

function couplingFromDependencies(
  names: readonly string[],
  dependencies: readonly ArchitectureDependency[],
): CouplingMetric[] {
  return [...names].sort(byCodePoint).map((name) => {
    const incoming = new Set(dependencies.filter((dependency) => dependency.target === name).map((dependency) => dependency.source));
    const outgoing = new Set(dependencies.filter((dependency) => dependency.source === name).map((dependency) => dependency.target));
    const Ca = incoming.size;
    const Ce = outgoing.size;
    return { name, Ca, Ce, instability: Ca + Ce === 0 ? 0 : Ce / (Ca + Ce) };
  });
}

function matchesLayerPath(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function directoryOf(filePath: string): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '.' : normalized.slice(0, index) || '.';
}

function parentDir(directory: string): string | null {
  if (directory === '.') return null;
  const index = directory.lastIndexOf('/');
  return index === -1 ? '.' : directory.slice(0, index) || '.';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
