import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_HEALTH_SIGNAL_KINDS,
  buildArchitectureReport,
  canonicalJson,
  deriveArchitectureHealth,
  normalizeArchitectureHealthOptions,
  type ArchitectureHealthDerivationInput,
  type ArchitectureHealthReport,
  type ArchitectureHealthSignal,
  type ArchitectureHealthSignalKind,
  type ArchitectureLayerRule,
  type ArchitectureManifestPackage,
} from '../src/analysis';
import type {
  Edge,
  FileRecord,
  Node,
  UnresolvedReference,
} from '../src/types';

type GraphFixture = {
  readonly files: readonly FileRecord[];
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly manifests: readonly ArchitectureManifestPackage[];
  readonly layerRules: readonly ArchitectureLayerRule[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
};

function file(path: string, errors: FileRecord['errors'] = []): FileRecord {
  return {
    path,
    contentHash: `hash:${path}`,
    language: 'typescript',
    size: 1,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 1,
    errors,
  };
}

function node(input: {
  readonly id: string;
  readonly filePath: string;
  readonly name: string;
  readonly isExported?: boolean;
}): Node {
  return {
    id: input.id,
    kind: 'function',
    name: input.name,
    qualifiedName: `${input.filePath}::${input.name}`,
    filePath: input.filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    isExported: input.isExported ?? true,
    updatedAt: 1,
  };
}

function edge(
  source: string,
  target: string,
  provenance: NonNullable<Edge['provenance']> = 'tree-sitter',
): Edge {
  return {
    source,
    target,
    kind: 'imports',
    line: 1,
    column: 0,
    provenance,
  };
}

function createFixture(): GraphFixture {
  const packages = ['a', 'b', 'c', 'd', 'e'];
  return {
    files: [
      ...packages.map((name) => file(`packages/${name}/${name}.ts`)),
      file('src/orphan.ts'),
    ],
    nodes: [
      ...packages.map((name) => node({
        id: name,
        filePath: `packages/${name}/${name}.ts`,
        name,
      })),
      node({
        id: 'unused',
        filePath: 'src/orphan.ts',
        name: 'unused',
        isExported: false,
      }),
    ],
    edges: [
      edge('a', 'b'),
      edge('b', 'a'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('d', 'a'),
      edge('c', 'e'),
      edge('c', 'b'),
    ],
    manifests: packages.map((name) => ({
      root: `packages/${name}`,
      name,
    })),
    layerRules: packages.map((name) => ({
      name: `layer-${name}`,
      paths: [`packages/${name}/**`],
    })),
    unresolvedReferences: [],
  };
}

function derive(fixture: GraphFixture): ArchitectureHealthReport {
  const options = normalizeArchitectureHealthOptions({
    layers: fixture.layerRules,
  });
  const input: ArchitectureHealthDerivationInput = {
    architecture: buildArchitectureReport({
      rootPackageName: 'root',
      files: fixture.files,
      nodes: fixture.nodes,
      edges: fixture.edges,
      manifests: fixture.manifests,
      layerRules: options.layers,
    }),
    options,
    producer: {
      solidkgVersion: '1.0.0',
      schemaVersion: 11,
      graphFactPolicy: 'all_indexed_architecture_edges_v1',
    },
    files: fixture.files,
    nodes: fixture.nodes,
    edges: fixture.edges,
    unresolvedReferences: fixture.unresolvedReferences,
    scip: {
      indexes: 0,
      documents: 0,
      occurrences: 0,
      relationships: 0,
      linkedNodes: 0,
    },
  };
  return deriveArchitectureHealth(input);
}

function signal(
  report: ArchitectureHealthReport,
  kind: ArchitectureHealthSignalKind,
): ArchitectureHealthSignal {
  const result = report.signals.find((entry) => entry.kind === kind);
  if (!result) throw new Error(`missing signal ${kind}`);
  return result;
}

function scalarMetrics(report: ArchitectureHealthReport): Record<string, number> {
  return Object.fromEntries(
    report.metrics
      .filter((metric) => metric.kind === 'scalar')
      .map((metric) => [metric.key, metric.value]),
  );
}

describe('architecture health derivation', () => {
  it('derives every v1 signal from a graph with evidence-bearing findings', () => {
    const report = derive(createFixture());

    expect(report.signals.map((entry) => entry.kind)).toEqual(
      ARCHITECTURE_HEALTH_SIGNAL_KINDS,
    );
    expect(report.signals.map((entry) => entry.findings.length)).toEqual([
      1, 1, 1, 1, 1, 5, 5, 1, 1, 1,
    ]);
    expect(scalarMetrics(report)).toEqual({
      indexed_file_count: 6,
      index_error_file_count: 0,
      unresolved_reference_count: 0,
      file_dependency_cycle_count: 1,
      package_dependency_cycle_count: 1,
      layer_dependency_cycle_count: 1,
      package_stable_dependency_violation_count: 1,
      layer_stable_dependency_violation_count: 1,
      manifest_unassigned_file_count: 1,
      layer_unassigned_file_count: 1,
      static_unreferenced_candidate_count: 1,
    });
    expect(signal(report, 'package_coupling').findings.map((finding) => finding.subjects[0])).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
    expect(signal(report, 'layer_coupling').findings.map((finding) => finding.subjects[0])).toEqual([
      'layer-a', 'layer-b', 'layer-c', 'layer-d', 'layer-e',
    ]);
    expect(signal(report, 'package_stable_dependency_violation').findings).toEqual([
      expect.objectContaining({
        scope: 'package',
        subjects: ['a', 'c'],
        facts: [
          { key: 'source_afferent_coupling', value: 2 },
          { key: 'source_efferent_coupling', value: 2 },
          { key: 'source_instability', value: 0.5 },
          { key: 'target_afferent_coupling', value: 1 },
          { key: 'target_efferent_coupling', value: 2 },
          { key: 'target_instability', value: 2 / 3 },
        ],
        evidence: [expect.objectContaining({
          path: 'packages/a/a.ts',
          source: 'a',
          target: 'c',
          edgeKind: 'imports',
          provenance: 'tree-sitter',
        })],
      }),
    ]);
    expect(signal(report, 'manifest_unassigned_file').findings[0]).toMatchObject({
      scope: 'file',
      subjects: ['src/orphan.ts'],
      evidence: [{
        path: 'src/orphan.ts',
        line: null,
        symbol: null,
        source: null,
        target: null,
        edgeKind: null,
        provenance: null,
      }],
    });
    expect(signal(report, 'static_unreferenced_candidate')).toMatchObject({
      coverage: {
        status: 'partial',
        reasons: [{ code: 'static_unreferenced_candidate_only', count: 1 }],
        relevantErrorFilePaths: [],
        relevantUnresolvedReferenceKeys: [],
        consumedProvenance: ['tree-sitter'],
      },
      findings: [expect.objectContaining({
        scope: 'symbol',
        subjects: ['src/orphan.ts', 'function', 'src/orphan.ts::unused'],
      })],
    });
    expect(report.observedGraphFacts).toEqual({
      edgeKinds: ['imports'],
      edgeProvenanceCounts: [{ provenance: 'tree-sitter', count: 7 }],
      scip: {
        status: 'unavailable',
        documentCount: 0,
        occurrenceCount: 0,
        relationshipCount: 0,
      },
    });
  });

  it('returns zero findings for every initial signal without inventing dead-code certainty', () => {
    const report = derive({
      files: [file('packages/a/clean.ts')],
      nodes: [node({
        id: 'clean',
        filePath: 'packages/a/clean.ts',
        name: 'clean',
      })],
      edges: [],
      manifests: [{ root: 'packages/a', name: 'a' }],
      layerRules: [{ name: 'application', paths: ['packages/a/**'] }],
      unresolvedReferences: [],
    });

    expect(report.signals.map((entry) => entry.findings)).toEqual(
      ARCHITECTURE_HEALTH_SIGNAL_KINDS.map(() => []),
    );
    for (const kind of ARCHITECTURE_HEALTH_SIGNAL_KINDS) {
      const coverage = signal(report, kind).coverage;
      if (kind === 'static_unreferenced_candidate') {
        expect(coverage).toMatchObject({
          status: 'partial',
          reasons: [{ code: 'static_unreferenced_candidate_only', count: 1 }],
        });
      } else {
        expect(coverage.status).toBe('complete');
      }
    }
  });

  it('marks all layer-only signals not_run without layer rules', () => {
    const fixture = createFixture();
    const report = derive({ ...fixture, layerRules: [] });
    const layerSignalKinds: readonly ArchitectureHealthSignalKind[] = [
      'layer_dependency_cycle',
      'layer_stable_dependency_violation',
      'layer_coupling',
      'layer_unassigned_file',
    ];

    for (const kind of layerSignalKinds) {
      expect(signal(report, kind)).toMatchObject({
        coverage: {
          status: 'not_run',
          reasons: [{ code: 'layer_rules_not_configured', count: 1 }],
        },
        findings: [],
      });
    }
    expect(signal(report, 'package_dependency_cycle').findings).toHaveLength(1);
    expect(signal(report, 'static_unreferenced_candidate').coverage.status).toBe('partial');
  });

  it('degrades only graph-derived signals for extraction errors and unresolved references', () => {
    const fixture = createFixture();
    const indexError = {
      message: 'parse failed',
      severity: 'error' as const,
      filePath: 'packages/a/a.ts',
    };
    const unresolvedReference: UnresolvedReference = {
      fromNodeId: 'a',
      referenceName: 'missing',
      referenceKind: 'imports',
      line: 10,
      column: 0,
      filePath: 'packages/a/a.ts',
      language: 'typescript',
    };
    const report = derive({
      ...fixture,
      files: fixture.files.map((entry) => entry.path === 'packages/a/a.ts'
        ? { ...entry, errors: [indexError] }
        : entry),
      unresolvedReferences: [unresolvedReference],
    });
    const affected: readonly ArchitectureHealthSignalKind[] = [
      'file_dependency_cycle',
      'package_dependency_cycle',
      'layer_dependency_cycle',
      'package_stable_dependency_violation',
      'layer_stable_dependency_violation',
      'package_coupling',
      'layer_coupling',
      'static_unreferenced_candidate',
    ];

    for (const kind of affected) {
      expect(signal(report, kind).coverage).toMatchObject({
        status: 'partial',
        relevantErrorFilePaths: ['packages/a/a.ts'],
        relevantUnresolvedReferenceKeys: [
          '["packages/a/a.ts","a","missing","imports",10,0]',
        ],
      });
    }
    expect(signal(report, 'manifest_unassigned_file').coverage.status).toBe('complete');
    expect(signal(report, 'layer_unassigned_file').coverage.status).toBe('complete');
  });

  it('records heuristic provenance as graph evidence without changing the signal set', () => {
    const fixture = createFixture();
    const report = derive({
      ...fixture,
      edges: fixture.edges.map((entry) => ({ ...entry, provenance: 'heuristic' })),
    });
    const graphSignals: readonly ArchitectureHealthSignalKind[] = [
      'file_dependency_cycle',
      'package_dependency_cycle',
      'layer_dependency_cycle',
      'package_stable_dependency_violation',
      'layer_stable_dependency_violation',
      'package_coupling',
      'layer_coupling',
      'static_unreferenced_candidate',
    ];

    for (const kind of graphSignals) {
      expect(signal(report, kind).coverage.consumedProvenance).toEqual(['heuristic']);
    }
    expect(report.observedGraphFacts.edgeProvenanceCounts).toEqual([
      { provenance: 'heuristic', count: 7 },
    ]);
    expect(signal(report, 'manifest_unassigned_file').coverage.consumedProvenance).toEqual([]);
  });

  it('is byte-identical for repeated and permuted graph inputs', () => {
    const fixture = createFixture();
    const first = derive(fixture);
    const repeated = derive(fixture);
    const permuted = derive({
      ...fixture,
      files: [...fixture.files].reverse(),
      nodes: [...fixture.nodes].reverse(),
      edges: [...fixture.edges].reverse(),
      manifests: [...fixture.manifests].reverse(),
    });

    expect(canonicalJson(repeated)).toBe(canonicalJson(first));
    expect(canonicalJson(permuted)).toBe(canonicalJson(first));
  });
});
