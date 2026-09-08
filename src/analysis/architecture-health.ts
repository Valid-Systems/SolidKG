import type {
  ArchitectureFileAssignment,
  ArchitectureReport,
  CouplingMetric,
} from '../index';
import type {
  Edge,
  EdgeKind,
  FileRecord,
  Node,
  ScipStats,
  UnresolvedReference,
} from '../types';
import {
  ARCHITECTURE_HEALTH_ANALYSIS_KIND,
  ARCHITECTURE_HEALTH_ANALYSIS_VERSION,
  ARCHITECTURE_HEALTH_SIGNAL_KINDS,
  type ArchitectureHealthCoverage,
  type ArchitectureHealthEvidenceAnchor,
  type ArchitectureHealthFinding,
  type ArchitectureHealthFindingFactKey,
  type ArchitectureHealthMetric,
  type ArchitectureHealthProducerIdentity,
  type ArchitectureHealthProvenance,
  type ArchitectureHealthReport,
  type ArchitectureHealthSignal,
  type ArchitectureHealthSignalKind,
  type NormalizedArchitectureHealthOptions,
} from './architecture-health-types';
import {
  canonicalizeArchitectureHealthReport,
  createCoverageFingerprint,
  createFindingId,
  normalizeArchitectureHealthOptions,
} from './architecture-health-normalization';

const architectureEdgeKinds = new Set<EdgeKind>([
  'imports',
  'references',
  'calls',
  'extends',
  'implements',
  'instantiates',
  'type_of',
]);

const staticCandidateKinds = new Set<Node['kind']>([
  'function',
  'method',
  'class',
]);

type ScopedArchitectureScope = 'package' | 'layer';

type RawArchitectureEdge = {
  readonly edge: Edge;
  readonly sourceNode: Node;
  readonly targetNode: Node;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly provenance: ArchitectureHealthProvenance;
  readonly sourceAssignment: ArchitectureFileAssignment | undefined;
  readonly targetAssignment: ArchitectureFileAssignment | undefined;
};

type ScopedDependencyEdge = {
  readonly source: string;
  readonly target: string;
  readonly edge: RawArchitectureEdge;
};

type ScipFactInput = Pick<
  ScipStats,
  'indexes' | 'documents' | 'occurrences' | 'relationships' | 'linkedNodes'
>;

export interface ArchitectureHealthDerivationInput {
  readonly architecture: ArchitectureReport;
  readonly options: NormalizedArchitectureHealthOptions;
  readonly producer: ArchitectureHealthProducerIdentity;
  readonly files: readonly FileRecord[];
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
  readonly scip: ScipFactInput;
}

export function deriveArchitectureHealth(
  input: ArchitectureHealthDerivationInput,
): ArchitectureHealthReport {
  const options = normalizeArchitectureHealthOptions(input.options);
  const nodesById = createNodesById(input.nodes);
  const assignmentsByPath = createAssignmentsByPath(
    input.architecture.fileAssignments,
  );
  const rawArchitectureEdges = collectArchitectureEdges(
    input.edges,
    nodesById,
    assignmentsByPath,
  );
  const packageEdges = scopedDependencyEdges(rawArchitectureEdges, 'package');
  const layerEdges = scopedDependencyEdges(rawArchitectureEdges, 'layer');
  const indexErrorPaths = collectIndexErrorPaths(input.files);
  const architectureUnresolvedKeys = collectUnresolvedKeys(
    input.unresolvedReferences.filter((reference) =>
      architectureEdgeKinds.has(reference.referenceKind),
    ),
  );
  const staticUnresolvedKeys = collectUnresolvedKeys(
    input.unresolvedReferences.filter(
      (reference) => reference.referenceKind !== 'contains',
    ),
  );

  const fileCycles = findStronglyConnectedComponents(
    [...new Set([
      ...input.files.map((file) => normalizePath(file.path)),
      ...input.nodes.map((node) => normalizePath(node.filePath)),
    ])],
    rawArchitectureEdges.map((edge) => ({
      source: edge.sourcePath,
      target: edge.targetPath,
    })),
  );
  const packageCycles = findStronglyConnectedComponents(
    input.architecture.packages.map((pkg) => pkg.name),
    input.architecture.packageDependencies,
  );
  const layersConfigured = options.layers.length > 0;
  const layerCycles = layersConfigured
    ? findStronglyConnectedComponents(
      input.architecture.layers.map((layer) => layer.name),
      input.architecture.layerDependencies,
    )
    : [];

  const fileCycleFindings = buildFileCycleFindings(
    fileCycles,
    rawArchitectureEdges,
  );
  const packageCycleFindings = buildScopedCycleFindings(
    'package_dependency_cycle',
    'package',
    packageCycles,
    packageEdges,
  );
  const layerCycleFindings = layersConfigured
    ? buildScopedCycleFindings(
      'layer_dependency_cycle',
      'layer',
      layerCycles,
      layerEdges,
    )
    : [];

  const packageStableFindings = stableDependencyFindings(
    'package_stable_dependency_violation',
    'package',
    input.architecture.packageDependencies,
    input.architecture.coupling.packages,
    packageEdges,
  );
  const layerStableFindings = layersConfigured
    ? stableDependencyFindings(
      'layer_stable_dependency_violation',
      'layer',
      input.architecture.layerDependencies,
      input.architecture.coupling.layers,
      layerEdges,
    )
    : [];

  const packageCouplingFindings = couplingFindings(
    'package_coupling',
    'package',
    input.architecture.coupling.packages,
    packageEdges,
  );
  const layerCouplingFindings = layersConfigured
    ? couplingFindings(
      'layer_coupling',
      'layer',
      input.architecture.coupling.layers,
      layerEdges,
    )
    : [];

  const manifestUnassignedFindings = assignmentFindings(
    'manifest_unassigned_file',
    input.architecture.fileAssignments,
    (assignment) => assignment.packageProvenance === 'root',
  );
  const layerUnassignedFindings = layersConfigured
    ? assignmentFindings(
      'layer_unassigned_file',
      input.architecture.fileAssignments,
      (assignment) => assignment.layerProvenance === 'unassigned',
    )
    : [];
  const staticCandidates = findStaticCandidates(input.nodes, input.edges);
  const staticCandidateFindingRecords = staticCandidateFindings(staticCandidates);

  const graphCoverage = createGraphCoverage(
    indexErrorPaths,
    architectureUnresolvedKeys,
    provenanceFromRawArchitectureEdges(rawArchitectureEdges),
  );
  const packageCoverage = createGraphCoverage(
    indexErrorPaths,
    architectureUnresolvedKeys,
    provenanceFromRawArchitectureEdges(packageEdges.map((entry) => entry.edge)),
  );
  const layerCoverage = layersConfigured
    ? createGraphCoverage(
      indexErrorPaths,
      architectureUnresolvedKeys,
      provenanceFromRawArchitectureEdges(layerEdges.map((entry) => entry.edge)),
    )
    : createLayerNotRunCoverage();
  const staticCoverage = createStaticCoverage(
    indexErrorPaths,
    staticUnresolvedKeys,
    provenanceFromGraphEdges(
      input.edges.filter(
        (edge) => edge.kind !== 'contains'
          && staticCandidateKinds.has(nodesById.get(edge.target)?.kind ?? 'file'),
      ),
    ),
  );
  const assignmentCoverage = createCompleteCoverage();

  const signalsByKind = new Map<
    ArchitectureHealthSignalKind,
    ArchitectureHealthSignal
  >([
    ['file_dependency_cycle', {
      kind: 'file_dependency_cycle',
      coverage: graphCoverage,
      findings: fileCycleFindings,
    }],
    ['package_dependency_cycle', {
      kind: 'package_dependency_cycle',
      coverage: packageCoverage,
      findings: packageCycleFindings,
    }],
    ['layer_dependency_cycle', {
      kind: 'layer_dependency_cycle',
      coverage: layerCoverage,
      findings: layerCycleFindings,
    }],
    ['package_stable_dependency_violation', {
      kind: 'package_stable_dependency_violation',
      coverage: packageCoverage,
      findings: packageStableFindings,
    }],
    ['layer_stable_dependency_violation', {
      kind: 'layer_stable_dependency_violation',
      coverage: layerCoverage,
      findings: layerStableFindings,
    }],
    ['package_coupling', {
      kind: 'package_coupling',
      coverage: packageCoverage,
      findings: packageCouplingFindings,
    }],
    ['layer_coupling', {
      kind: 'layer_coupling',
      coverage: layerCoverage,
      findings: layerCouplingFindings,
    }],
    ['manifest_unassigned_file', {
      kind: 'manifest_unassigned_file',
      coverage: assignmentCoverage,
      findings: manifestUnassignedFindings,
    }],
    ['layer_unassigned_file', {
      kind: 'layer_unassigned_file',
      coverage: layersConfigured ? assignmentCoverage : createLayerNotRunCoverage(),
      findings: layerUnassignedFindings,
    }],
    ['static_unreferenced_candidate', {
      kind: 'static_unreferenced_candidate',
      coverage: staticCoverage,
      findings: staticCandidateFindingRecords,
    }],
  ]);

  const signals = ARCHITECTURE_HEALTH_SIGNAL_KINDS.map((kind) => {
    const signal = signalsByKind.get(kind);
    if (!signal) throw new Error(`missing architecture health signal: ${kind}`);
    return signal;
  });
  const metrics = scalarMetrics({
    indexedFileCount: input.files.length,
    indexErrorFileCount: indexErrorPaths.length,
    unresolvedReferenceCount: input.unresolvedReferences.length,
    fileDependencyCycleCount: fileCycleFindings.length,
    packageDependencyCycleCount: packageCycleFindings.length,
    layerDependencyCycleCount: layerCycleFindings.length,
    packageStableDependencyViolationCount: packageStableFindings.length,
    layerStableDependencyViolationCount: layerStableFindings.length,
    manifestUnassignedFileCount: manifestUnassignedFindings.length,
    layerUnassignedFileCount: layerUnassignedFindings.length,
    staticUnreferencedCandidateCount: staticCandidateFindingRecords.length,
  });

  metrics.push(
    ...couplingMetrics('package', input.architecture.coupling.packages),
    ...couplingMetrics('layer', input.architecture.coupling.layers),
  );

  return canonicalizeArchitectureHealthReport({
    analysisKind: ARCHITECTURE_HEALTH_ANALYSIS_KIND,
    analysisVersion: ARCHITECTURE_HEALTH_ANALYSIS_VERSION,
    options,
    producer: {
      solidkgVersion: input.producer.solidkgVersion,
      schemaVersion: input.producer.schemaVersion,
      graphFactPolicy: input.producer.graphFactPolicy,
    },
    observedGraphFacts: {
      edgeKinds: [...new Set(input.edges.map((edge) => edge.kind))],
      edgeProvenanceCounts: provenanceCounts(input.edges),
      scip: observedScipFacts(input.scip),
    },
    metrics,
    signals,
  });
}

function createNodesById(nodes: readonly Node[]): ReadonlyMap<string, Node> {
  return new Map(
    [...nodes]
      .sort((left, right) => byCodePoint(left.id, right.id)
        || byCodePoint(normalizePath(left.filePath), normalizePath(right.filePath))
        || byCodePoint(left.qualifiedName, right.qualifiedName)
        || left.startLine - right.startLine)
      .map((node) => [node.id, node]),
  );
}

function createAssignmentsByPath(
  assignments: readonly ArchitectureFileAssignment[],
): ReadonlyMap<string, ArchitectureFileAssignment> {
  return new Map(
    [...assignments]
      .sort((left, right) => byCodePoint(normalizePath(left.filePath), normalizePath(right.filePath))
        || byCodePoint(left.packageName, right.packageName)
        || byCodePoint(left.layerName, right.layerName))
      .map((assignment) => [normalizePath(assignment.filePath), assignment]),
  );
}

function collectArchitectureEdges(
  edges: readonly Edge[],
  nodesById: ReadonlyMap<string, Node>,
  assignmentsByPath: ReadonlyMap<string, ArchitectureFileAssignment>,
): RawArchitectureEdge[] {
  const entries: RawArchitectureEdge[] = [];
  for (const edge of [...edges].sort(compareEdges)) {
    if (!architectureEdgeKinds.has(edge.kind)) continue;
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const sourcePath = normalizePath(sourceNode.filePath);
    const targetPath = normalizePath(targetNode.filePath);
    entries.push({
      edge,
      sourceNode,
      targetNode,
      sourcePath,
      targetPath,
      provenance: edgeProvenance(edge),
      sourceAssignment: assignmentsByPath.get(sourcePath),
      targetAssignment: assignmentsByPath.get(targetPath),
    });
  }
  return entries;
}

function scopedDependencyEdges(
  edges: readonly RawArchitectureEdge[],
  scope: ScopedArchitectureScope,
): ScopedDependencyEdge[] {
  return edges.flatMap((entry) => {
    const sourceAssignment = entry.sourceAssignment;
    const targetAssignment = entry.targetAssignment;
    if (!sourceAssignment || !targetAssignment) return [];
    const source = scope === 'package'
      ? sourceAssignment.packageName
      : sourceAssignment.layerName;
    const target = scope === 'package'
      ? targetAssignment.packageName
      : targetAssignment.layerName;
    if (source === target) return [];
    return [{ source, target, edge: entry }];
  });
}

function collectIndexErrorPaths(files: readonly FileRecord[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    for (const error of file.errors ?? []) {
      if (error.severity !== 'error') continue;
      paths.add(normalizePath(error.filePath ?? file.path));
    }
  }
  return [...paths].sort(byCodePoint);
}

function collectUnresolvedKeys(
  references: readonly UnresolvedReference[],
): string[] {
  return [...new Set(references.map(unresolvedReferenceKey))].sort(byCodePoint);
}

function unresolvedReferenceKey(reference: UnresolvedReference): string {
  return JSON.stringify([
    normalizePath(reference.filePath ?? ''),
    reference.fromNodeId,
    reference.referenceName,
    reference.referenceKind,
    reference.line,
    reference.column,
  ]);
}

function findStronglyConnectedComponents(
  names: readonly string[],
  dependencies: readonly { source: string; target: string }[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();
  const ensure = (name: string): void => {
    if (!adjacency.has(name)) adjacency.set(name, new Set());
    if (!reverseAdjacency.has(name)) reverseAdjacency.set(name, new Set());
  };
  for (const name of names) ensure(name);
  for (const dependency of dependencies) {
    ensure(dependency.source);
    ensure(dependency.target);
    adjacency.get(dependency.source)?.add(dependency.target);
    reverseAdjacency.get(dependency.target)?.add(dependency.source);
  }

  const orderedNames = [...adjacency.keys()].sort(byCodePoint);
  const visited = new Set<string>();
  const finishingOrder: string[] = [];
  for (const start of orderedNames) {
    if (visited.has(start)) continue;
    const stack: Array<{ name: string; neighbors: string[]; index: number }> = [{
      name: start,
      neighbors: [...(adjacency.get(start) ?? [])].sort(byCodePoint),
      index: 0,
    }];
    visited.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const neighbor = frame.neighbors[frame.index];
      if (neighbor !== undefined) {
        frame.index += 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push({
            name: neighbor,
            neighbors: [...(adjacency.get(neighbor) ?? [])].sort(byCodePoint),
            index: 0,
          });
        }
        continue;
      }
      finishingOrder.push(frame.name);
      stack.pop();
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const start of [...finishingOrder].reverse()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const name = stack.pop();
      if (name === undefined) continue;
      component.push(name);
      for (const neighbor of [...(reverseAdjacency.get(name) ?? [])].sort(byCodePoint).reverse()) {
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    if (component.length > 1) components.push(component.sort(byCodePoint));
  }
  return components.sort((left, right) => byCodePoint(left.join('\u0000'), right.join('\u0000')));
}

function buildFileCycleFindings(
  components: readonly string[][],
  edges: readonly RawArchitectureEdge[],
): ArchitectureHealthFinding[] {
  return components.map((component) => {
    const members = new Set(component);
    const evidence = evidenceFromRawEdges(
      edges.filter((edge) => members.has(edge.sourcePath) && members.has(edge.targetPath)),
    );
    return finding('file_dependency_cycle', 'file', component, [], evidence, component);
  });
}

function buildScopedCycleFindings(
  signalKind: Extract<ArchitectureHealthSignalKind, `${ScopedArchitectureScope}_dependency_cycle`>,
  scope: ScopedArchitectureScope,
  components: readonly string[][],
  edges: readonly ScopedDependencyEdge[],
): ArchitectureHealthFinding[] {
  return components.map((component) => {
    const members = new Set(component);
    const evidence = evidenceFromScopedEdges(
      edges.filter((edge) => members.has(edge.source) && members.has(edge.target)),
    );
    return finding(signalKind, scope, component, [], evidence, component);
  });
}

function stableDependencyFindings(
  signalKind: Extract<ArchitectureHealthSignalKind, `${'package' | 'layer'}_stable_dependency_violation`>,
  scope: ScopedArchitectureScope,
  dependencies: readonly { source: string; target: string }[],
  coupling: readonly CouplingMetric[],
  edges: readonly ScopedDependencyEdge[],
): ArchitectureHealthFinding[] {
  const couplingByName = new Map(
    [...coupling]
      .sort((left, right) => byCodePoint(left.name, right.name))
      .map((metric) => [metric.name, metric]),
  );
  const uniqueDependencies = new Map<string, { source: string; target: string }>();
  for (const dependency of dependencies) {
    uniqueDependencies.set(`${dependency.source}\u0000${dependency.target}`, dependency);
  }
  return [...uniqueDependencies.values()]
    .sort((left, right) => byCodePoint(left.source, right.source) || byCodePoint(left.target, right.target))
    .flatMap((dependency) => {
      const source = couplingByName.get(dependency.source);
      const target = couplingByName.get(dependency.target);
      if (!source || !target || source.instability >= target.instability) return [];
      const facts: Array<{ key: ArchitectureHealthFindingFactKey; value: number }> = [
        { key: 'source_afferent_coupling', value: source.Ca },
        { key: 'source_efferent_coupling', value: source.Ce },
        { key: 'source_instability', value: source.instability },
        { key: 'target_afferent_coupling', value: target.Ca },
        { key: 'target_efferent_coupling', value: target.Ce },
        { key: 'target_instability', value: target.instability },
      ];
      return [finding(
        signalKind,
        scope,
        [dependency.source, dependency.target],
        facts,
        evidenceFromScopedEdges(
          edges.filter((edge) => edge.source === dependency.source && edge.target === dependency.target),
        ),
        [['source', dependency.source], ['target', dependency.target]],
      )];
    });
}

function couplingFindings(
  signalKind: Extract<ArchitectureHealthSignalKind, `${'package' | 'layer'}_coupling`>,
  scope: ScopedArchitectureScope,
  coupling: readonly CouplingMetric[],
  edges: readonly ScopedDependencyEdge[],
): ArchitectureHealthFinding[] {
  return [...coupling]
    .filter((metric) => metric.Ca + metric.Ce > 0)
    .sort(compareCoupling)
    .map((metric) => finding(
      signalKind,
      scope,
      [metric.name],
      [
        { key: 'afferent_coupling', value: metric.Ca },
        { key: 'efferent_coupling', value: metric.Ce },
        { key: 'instability', value: metric.instability },
      ],
      evidenceFromScopedEdges(
        edges.filter((edge) => edge.source === metric.name || edge.target === metric.name),
      ),
      [metric.name],
    ));
}

function assignmentFindings(
  signalKind: Extract<ArchitectureHealthSignalKind, `${'manifest' | 'layer'}_unassigned_file`>,
  assignments: readonly ArchitectureFileAssignment[],
  predicate: (assignment: ArchitectureFileAssignment) => boolean,
): ArchitectureHealthFinding[] {
  const byPath = new Map<string, ArchitectureFileAssignment>();
  for (const assignment of assignments) {
    if (!predicate(assignment)) continue;
    byPath.set(normalizePath(assignment.filePath), assignment);
  }
  return [...byPath.values()]
    .sort((left, right) => byCodePoint(normalizePath(left.filePath), normalizePath(right.filePath)))
    .map((assignment) => {
      const path = normalizePath(assignment.filePath);
      return finding(signalKind, 'file', [path], [], [{
        path,
        line: null,
        symbol: null,
        source: null,
        target: null,
        edgeKind: null,
        provenance: null,
      }], [path]);
    });
}

function findStaticCandidates(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Node[] {
  const referencedNodeIds = new Set(
    edges
      .filter((edge) => edge.kind !== 'contains')
      .map((edge) => edge.target),
  );
  const candidatesByIdentity = new Map<string, Node>();
  for (const node of nodes) {
    if (!staticCandidateKinds.has(node.kind) || node.isExported || referencedNodeIds.has(node.id)) continue;
    const identity = `${normalizePath(node.filePath)}\u0000${node.kind}\u0000${node.qualifiedName}`;
    const previous = candidatesByIdentity.get(identity);
    if (!previous || compareNodes(node, previous) < 0) candidatesByIdentity.set(identity, node);
  }
  return [...candidatesByIdentity.values()].sort(compareNodes);
}

function staticCandidateFindings(nodes: readonly Node[]): ArchitectureHealthFinding[] {
  return nodes.map((node) => {
    const path = normalizePath(node.filePath);
    return finding(
      'static_unreferenced_candidate',
      'symbol',
      [path, node.kind, node.qualifiedName],
      [],
      [{
        path,
        line: node.startLine,
        symbol: node.qualifiedName,
        source: null,
        target: null,
        edgeKind: null,
        provenance: null,
      }],
      [path, node.kind, node.qualifiedName],
    );
  });
}

function finding(
  signalKind: ArchitectureHealthSignalKind,
  scope: ArchitectureHealthFinding['scope'],
  subjects: readonly string[],
  facts: readonly { key: ArchitectureHealthFindingFactKey; value: number }[],
  evidence: readonly ArchitectureHealthEvidenceAnchor[],
  identityParts: readonly unknown[],
): ArchitectureHealthFinding {
  return {
    id: createFindingId(signalKind, scope, identityParts),
    signalKind,
    scope,
    subjects: [...subjects],
    facts: [...facts],
    evidence: canonicalEvidence(evidence, scope === 'file'),
  };
}

function evidenceFromRawEdges(
  edges: readonly RawArchitectureEdge[],
): ArchitectureHealthEvidenceAnchor[] {
  return edges.map((entry) => ({
    path: entry.sourcePath,
    line: entry.edge.line ?? entry.sourceNode.startLine,
    symbol: entry.sourceNode.qualifiedName,
    source: entry.sourcePath,
    target: entry.targetPath,
    edgeKind: entry.edge.kind,
    provenance: entry.provenance,
  }));
}

function evidenceFromScopedEdges(
  edges: readonly ScopedDependencyEdge[],
): ArchitectureHealthEvidenceAnchor[] {
  return edges.map((entry) => ({
    path: entry.edge.sourcePath,
    line: entry.edge.edge.line ?? entry.edge.sourceNode.startLine,
    symbol: entry.edge.sourceNode.qualifiedName,
    source: entry.source,
    target: entry.target,
    edgeKind: entry.edge.edge.kind,
    provenance: entry.edge.provenance,
  }));
}

function canonicalEvidence(
  evidence: readonly ArchitectureHealthEvidenceAnchor[],
  normalizeEndpoints: boolean,
): ArchitectureHealthEvidenceAnchor[] {
  const unique = new Map<string, ArchitectureHealthEvidenceAnchor>();
  for (const anchor of evidence) {
    const normalized: ArchitectureHealthEvidenceAnchor = {
      path: anchor.path === null ? null : normalizePath(anchor.path),
      line: anchor.line,
      symbol: anchor.symbol,
      source: anchor.source === null
        ? null
        : normalizeEndpoints ? normalizePath(anchor.source) : anchor.source,
      target: anchor.target === null
        ? null
        : normalizeEndpoints ? normalizePath(anchor.target) : anchor.target,
      edgeKind: anchor.edgeKind,
      provenance: anchor.provenance,
    };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort(compareEvidence);
}

function createGraphCoverage(
  errorPaths: readonly string[],
  unresolvedKeys: readonly string[],
  provenance: readonly ArchitectureHealthProvenance[],
): ArchitectureHealthCoverage {
  const reasons: ArchitectureHealthCoverage['reasons'] = [];
  if (errorPaths.length > 0) {
    reasons.push({ code: 'index_errors_present', count: errorPaths.length });
  }
  if (unresolvedKeys.length > 0) {
    reasons.push({ code: 'unresolved_references_present', count: unresolvedKeys.length });
  }
  return coverage(
    reasons.length === 0 ? 'complete' : 'partial',
    reasons,
    errorPaths,
    unresolvedKeys,
    provenance,
  );
}

function createStaticCoverage(
  errorPaths: readonly string[],
  unresolvedKeys: readonly string[],
  provenance: readonly ArchitectureHealthProvenance[],
): ArchitectureHealthCoverage {
  const reasons: ArchitectureHealthCoverage['reasons'] = [{
    code: 'static_unreferenced_candidate_only',
    count: 1,
  }];
  if (errorPaths.length > 0) {
    reasons.push({ code: 'index_errors_present', count: errorPaths.length });
  }
  if (unresolvedKeys.length > 0) {
    reasons.push({ code: 'unresolved_references_present', count: unresolvedKeys.length });
  }
  return coverage('partial', reasons, errorPaths, unresolvedKeys, provenance);
}

function createLayerNotRunCoverage(): ArchitectureHealthCoverage {
  return coverage(
    'not_run',
    [{ code: 'layer_rules_not_configured', count: 1 }],
    [],
    [],
    [],
  );
}

function createCompleteCoverage(): ArchitectureHealthCoverage {
  return coverage('complete', [], [], [], []);
}

function coverage(
  status: ArchitectureHealthCoverage['status'],
  reasons: ArchitectureHealthCoverage['reasons'],
  errorPaths: readonly string[],
  unresolvedKeys: readonly string[],
  provenance: readonly ArchitectureHealthProvenance[],
): ArchitectureHealthCoverage {
  const sortedReasons = [...reasons].sort((left, right) => byCodePoint(left.code, right.code));
  const sortedErrorPaths = [...new Set(errorPaths.map(normalizePath))].sort(byCodePoint);
  const sortedUnresolvedKeys = [...new Set(unresolvedKeys)].sort(byCodePoint);
  return {
    status,
    reasons: sortedReasons,
    relevantErrorFilePaths: sortedErrorPaths,
    relevantUnresolvedReferenceKeys: sortedUnresolvedKeys,
    consumedProvenance: [...new Set(provenance)].sort(byCodePoint),
    degradationFingerprint: createCoverageFingerprint(
      status,
      sortedReasons,
      sortedErrorPaths,
      sortedUnresolvedKeys,
    ),
  };
}

function provenanceFromRawArchitectureEdges(
  edges: readonly RawArchitectureEdge[],
): ArchitectureHealthProvenance[] {
  return edges.map((edge) => edge.provenance);
}

function provenanceFromGraphEdges(
  edges: readonly Edge[],
): ArchitectureHealthProvenance[] {
  return edges.map(edgeProvenance);
}

function couplingMetrics(
  scope: ScopedArchitectureScope,
  coupling: readonly CouplingMetric[],
): Array<Extract<ArchitectureHealthMetric, { kind: 'coupling' }>> {
  return coupling
    .filter((metric) => metric.Ca + metric.Ce > 0)
    .map((metric) => ({
      kind: 'coupling',
      scope,
      name: metric.name,
      afferentCoupling: metric.Ca,
      efferentCoupling: metric.Ce,
      instability: metric.instability,
    }));
}

function provenanceCounts(
  edges: readonly Edge[],
): Array<{ provenance: ArchitectureHealthProvenance; count: number }> {
  const counts = new Map<ArchitectureHealthProvenance, number>();
  for (const edge of edges) {
    const provenance = edgeProvenance(edge);
    counts.set(provenance, (counts.get(provenance) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => byCodePoint(left, right))
    .map(([provenance, count]) => ({ provenance, count }));
}

function observedScipFacts(scip: ScipFactInput): ArchitectureHealthReport['observedGraphFacts']['scip'] {
  return {
    status: scip.indexes === 0
      ? 'unavailable'
      : scip.linkedNodes === 0
        ? 'imported_unlinked'
        : 'linked',
    documentCount: scip.documents,
    occurrenceCount: scip.occurrences,
    relationshipCount: scip.relationships,
  };
}

function scalarMetrics(counts: {
  readonly indexedFileCount: number;
  readonly indexErrorFileCount: number;
  readonly unresolvedReferenceCount: number;
  readonly fileDependencyCycleCount: number;
  readonly packageDependencyCycleCount: number;
  readonly layerDependencyCycleCount: number;
  readonly packageStableDependencyViolationCount: number;
  readonly layerStableDependencyViolationCount: number;
  readonly manifestUnassignedFileCount: number;
  readonly layerUnassignedFileCount: number;
  readonly staticUnreferencedCandidateCount: number;
}): ArchitectureHealthMetric[] {
  return [
    { kind: 'scalar', key: 'indexed_file_count', value: counts.indexedFileCount },
    { kind: 'scalar', key: 'index_error_file_count', value: counts.indexErrorFileCount },
    { kind: 'scalar', key: 'unresolved_reference_count', value: counts.unresolvedReferenceCount },
    { kind: 'scalar', key: 'file_dependency_cycle_count', value: counts.fileDependencyCycleCount },
    { kind: 'scalar', key: 'package_dependency_cycle_count', value: counts.packageDependencyCycleCount },
    { kind: 'scalar', key: 'layer_dependency_cycle_count', value: counts.layerDependencyCycleCount },
    { kind: 'scalar', key: 'package_stable_dependency_violation_count', value: counts.packageStableDependencyViolationCount },
    { kind: 'scalar', key: 'layer_stable_dependency_violation_count', value: counts.layerStableDependencyViolationCount },
    { kind: 'scalar', key: 'manifest_unassigned_file_count', value: counts.manifestUnassignedFileCount },
    { kind: 'scalar', key: 'layer_unassigned_file_count', value: counts.layerUnassignedFileCount },
    { kind: 'scalar', key: 'static_unreferenced_candidate_count', value: counts.staticUnreferencedCandidateCount },
  ];
}

function edgeProvenance(edge: Edge): ArchitectureHealthProvenance {
  return edge.provenance ?? 'unspecified';
}

function compareEdges(left: Edge, right: Edge): number {
  return byCodePoint(left.source, right.source)
    || byCodePoint(left.target, right.target)
    || byCodePoint(left.kind, right.kind)
    || (left.line ?? -1) - (right.line ?? -1)
    || (left.column ?? -1) - (right.column ?? -1)
    || byCodePoint(edgeProvenance(left), edgeProvenance(right));
}

function compareNodes(left: Node, right: Node): number {
  return byCodePoint(normalizePath(left.filePath), normalizePath(right.filePath))
    || byCodePoint(left.kind, right.kind)
    || byCodePoint(left.qualifiedName, right.qualifiedName)
    || left.startLine - right.startLine
    || byCodePoint(left.id, right.id);
}

function compareCoupling(left: CouplingMetric, right: CouplingMetric): number {
  return right.Ce - left.Ce || right.Ca - left.Ca || byCodePoint(left.name, right.name);
}

function compareEvidence(
  left: ArchitectureHealthEvidenceAnchor,
  right: ArchitectureHealthEvidenceAnchor,
): number {
  return byCodePoint(left.path ?? '', right.path ?? '')
    || (left.line ?? -1) - (right.line ?? -1)
    || byCodePoint(left.symbol ?? '', right.symbol ?? '')
    || byCodePoint(left.source ?? '', right.source ?? '')
    || byCodePoint(left.target ?? '', right.target ?? '')
    || byCodePoint(left.edgeKind ?? '', right.edgeKind ?? '')
    || byCodePoint(left.provenance ?? '', right.provenance ?? '');
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}
