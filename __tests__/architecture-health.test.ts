/// <reference types="node" />
/// <reference types="vitest" />

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_HEALTH_ANALYSIS_KIND,
  ARCHITECTURE_HEALTH_ANALYSIS_VERSION,
  ARCHITECTURE_HEALTH_SIGNAL_KINDS,
  canonicalizeArchitectureHealthReport,
  canonicalizeSnapshotHealthDrift,
  canonicalJson,
  createCoverageFingerprint,
  createFindingId,
  normalizeArchitectureHealthOptions,
  parseLayerRules,
  type ArchitectureHealthCoverage,
  type ArchitectureHealthReport,
  type SnapshotHealthDrift,
} from '../src/analysis';

const fixturePath = join(__dirname, 'fixtures', 'architecture-health-v1.json');

describe('architecture health v1 contracts', () => {
  it('wire fixture round-trips canonical report and embedded JSON bytes', () => {
    const fixtureBytes = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(fixtureBytes) as { report: ArchitectureHealthReport; storedRow: { optionsJson: string; payloadJson: string }; drift: unknown };
    expect(`${canonicalJson(fixture)}\n`).toBe(fixtureBytes);
    expect(canonicalJson(canonicalizeArchitectureHealthReport(fixture.report))).toBe(canonicalJson(fixture.report));
    expect(canonicalJson(JSON.parse(fixture.storedRow.optionsJson))).toBe(fixture.storedRow.optionsJson);
    const payload = JSON.parse(fixture.storedRow.payloadJson) as { health: ArchitectureHealthReport; options: unknown };
    expect(canonicalJson(payload)).toBe(fixture.storedRow.payloadJson);
    expect(payload).toHaveProperty('health.analysisKind', ARCHITECTURE_HEALTH_ANALYSIS_KIND);
    expect(payload.health).toEqual(fixture.report);
    expect(canonicalJson(canonicalizeSnapshotHealthDrift(fixture.drift as SnapshotHealthDrift))).toBe(canonicalJson(fixture.drift));
  });

  it('wire fixture exercises the required non-empty v1 contract shape', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      report: ArchitectureHealthReport;
      drift: SnapshotHealthDrift;
    };

    expect(fixture.report.metrics.filter((metric) => metric.kind === 'scalar')).toHaveLength(11);
    expect(fixture.report.metrics.filter((metric) => metric.kind === 'coupling')).toHaveLength(1);
    expect(fixture.report.signals.map((signal) => signal.kind)).toEqual(ARCHITECTURE_HEALTH_SIGNAL_KINDS);
    const findings = fixture.report.signals.flatMap((signal) => signal.findings);
    expect(findings).toHaveLength(1);
    expect(findings.filter((finding) => finding.facts.length > 0 && finding.evidence.length > 0)).toHaveLength(1);
    expect(findings.flatMap((finding) => finding.evidence)).toHaveLength(1);
    const [stableFinding] = findings;
    if (!stableFinding) throw new Error('fixture must contain its required stable-dependency finding');
    const sourceInstability = stableFinding.facts.find((fact) => fact.key === 'source_instability');
    const targetInstability = stableFinding.facts.find((fact) => fact.key === 'target_instability');
    if (!sourceInstability || !targetInstability) throw new Error('stable-dependency finding must include instability facts');
    expect(sourceInstability.value).toBeLessThan(targetInstability.value);
    expect(fixture.report.signals.filter((signal) => signal.kind !== 'package_stable_dependency_violation').every((signal) => signal.findings.length === 0)).toBe(true);
    expect(fixture.drift.baselineCoverage).toHaveLength(ARCHITECTURE_HEALTH_SIGNAL_KINDS.length);
    expect(fixture.drift.currentCoverage).toHaveLength(ARCHITECTURE_HEALTH_SIGNAL_KINDS.length);
    expect(fixture.drift.omittedSignals).toHaveLength(1);
    expect(fixture.drift.introduced).toHaveLength(1);
    expect(fixture.drift.resolved).toHaveLength(1);
    expect(fixture.drift.persisting).toHaveLength(1);
    expect(fixture.drift.metricDeltas.map((delta) => delta.kind)).toEqual(['scalar', 'coupling']);
  });

  it('contracts expose frozen discriminator/version and explicit null/empty behavior', () => {
    expect(ARCHITECTURE_HEALTH_ANALYSIS_KIND).toBe('architecture_health');
    expect(ARCHITECTURE_HEALTH_ANALYSIS_VERSION).toBe(1);
  });

  it('normalization sorts rule patterns but preserves first-match rule order', () => {
    const normalized = normalizeArchitectureHealthOptions({ layers: [{ name: 'first', paths: ['b/**', './a/**', 'b/**'] }, { name: 'second', paths: ['src/**'] }] });
    expect(normalized).toEqual({ layers: [{ name: 'first', paths: ['a/**', 'b/**'] }, { name: 'second', paths: ['src/**'] }] });
    expect(normalizeArchitectureHealthOptions({ layers: [...normalized.layers].reverse() })).not.toEqual(normalized);
    expect(() => normalizeArchitectureHealthOptions({ layers: [{ name: ' ', paths: ['src/**'] }] })).toThrow('layer name');
    expect(parseLayerRules('[{"name":"first","paths":["src/**"]}]')).toEqual([{ name: 'first', paths: ['src/**'] }]);
  });

  it('stable finding ids distinguish directed roles and same-file qualified symbols while excluding metrics', () => {
    const forward = createFindingId('package_stable_dependency_violation', 'package', [['source', 'a'], ['target', 'b']]);
    const reverse = createFindingId('package_stable_dependency_violation', 'package', [['source', 'b'], ['target', 'a']]);
    const first = createFindingId('static_unreferenced_candidate', 'symbol', ['src/a.ts', 'function', 'A.one']);
    const second = createFindingId('static_unreferenced_candidate', 'symbol', ['src/a.ts', 'function', 'A.two']);
    expect(forward).not.toBe(reverse);
    expect(first).not.toBe(second);
    expect(createFindingId('package_coupling', 'package', ['z'])).toMatch(/^[0-9a-f]{24}$/);
  });

  it('coverage fingerprint ignores consumed provenance and sorts degradation inputs', () => {
    expect(createCoverageFingerprint('partial', [{ code: 'unresolved_references_present', count: 1 }, { code: 'index_errors_present', count: 2 }], ['b.ts', 'a.ts'], ['z', 'a'])).toBe(createCoverageFingerprint('partial', [{ code: 'index_errors_present', count: 2 }, { code: 'unresolved_references_present', count: 1 }], ['a.ts', 'b.ts'], ['a', 'z']));
  });

  it('derives coverage fingerprints from canonical coverage facts', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { report: ArchitectureHealthReport };
    const sourceCoverage = {
      status: 'partial',
      reasons: [{ code: 'unresolved_references_present', count: 1 }, { code: 'index_errors_present', count: 2 }],
      relevantErrorFilePaths: ['.\\b.ts', './a.ts'],
      relevantUnresolvedReferenceKeys: ['z', 'a'],
      consumedProvenance: ['scip', 'heuristic'],
      degradationFingerprint: 'manually-supplied-value',
    } satisfies ArchitectureHealthCoverage;

    const report = canonicalizeArchitectureHealthReport({
      ...fixture.report,
      signals: [{ kind: 'file_dependency_cycle', coverage: sourceCoverage, findings: [] }],
    });

    expect(report.signals[0]?.coverage).toEqual({
      status: 'partial',
      reasons: [{ code: 'index_errors_present', count: 2 }, { code: 'unresolved_references_present', count: 1 }],
      relevantErrorFilePaths: ['a.ts', 'b.ts'],
      relevantUnresolvedReferenceKeys: ['a', 'z'],
      consumedProvenance: ['heuristic', 'scip'],
      degradationFingerprint: createCoverageFingerprint(
        'partial',
        [{ code: 'index_errors_present', count: 2 }, { code: 'unresolved_references_present', count: 1 }],
        ['a.ts', 'b.ts'],
        ['a', 'z'],
      ),
    });
  });

  it('coupling delta canonicalization zero-fills absent sides and orders components', () => {
    const drift = canonicalizeSnapshotHealthDrift({ analysisKind: 'architecture_health', analysisVersion: 1, baselineLabel: 'b', comparisonStatus: 'comparable', reasons: [], graphDiffCounts: { addedNodes: 0, removedNodes: 0, changedNodes: 0, addedEdges: 0, removedEdges: 0, changedEdges: 0, addedHyperedges: 0, removedHyperedges: 0, changedHyperedges: 0, addedHyperedgeMembers: 0, removedHyperedgeMembers: 0, changedHyperedgeMembers: 0 }, baselineCoverage: [], currentCoverage: [], omittedSignals: [], introduced: [], resolved: [], persisting: [], metricDeltas: [{ kind: 'coupling', scope: 'package', name: 'z', metric: 'instability', baseline: 0, current: 1, delta: 1 }, { kind: 'coupling', scope: 'package', name: 'a', metric: 'efferent_coupling', baseline: 0, current: 1, delta: 1 }, { kind: 'coupling', scope: 'package', name: 'z', metric: 'afferent_coupling', baseline: 0, current: 1, delta: 1 }] });
    expect(drift.metricDeltas.map((delta) => `${delta.kind === 'coupling' ? `${delta.name}:${delta.metric}` : delta.key}`)).toEqual(['a:efferent_coupling', 'z:afferent_coupling', 'z:instability']);
  });

  it('rejects missing or incomplete graph diff counts', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { drift: Record<string, unknown> };
    const { graphDiffCounts: _omitted, ...withoutCounts } = fixture.drift;
    expect(() => canonicalizeSnapshotHealthDrift(withoutCounts as never)).toThrow('graphDiffCounts must be an object');
    expect(() => canonicalizeSnapshotHealthDrift({ ...fixture.drift, graphDiffCounts: { addedNodes: 0 } } as never)).toThrow('graphDiffCounts.removedNodes must be a finite number');
  });

  it('ordering ranks coupling by Ce then Ca then name and subjects otherwise', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { report: ArchitectureHealthReport };
    const coverage = { status: 'complete' as const, reasons: [], relevantErrorFilePaths: [], relevantUnresolvedReferenceKeys: [], consumedProvenance: [], degradationFingerprint: 'complete' };
    const finding = (name: string, afferent: number, efferent: number) => ({ id: name.repeat(24), signalKind: 'package_coupling' as const, scope: 'package' as const, subjects: [name], facts: [{ key: 'afferent_coupling' as const, value: afferent }, { key: 'efferent_coupling' as const, value: efferent }], evidence: [] });
    const report = canonicalizeArchitectureHealthReport({ ...fixture.report, metrics: [{ kind: 'coupling', scope: 'package', name: 'a', afferentCoupling: 9, efferentCoupling: 1, instability: 0.1 }, { kind: 'coupling', scope: 'package', name: 'z', afferentCoupling: 1, efferentCoupling: 2, instability: 0.7 }], signals: [{ kind: 'package_coupling', coverage, findings: [finding('a', 9, 1), finding('z', 1, 2)] }] });
    expect(report.metrics.map((metric) => metric.kind === 'coupling' ? metric.name : metric.key)).toEqual(['z', 'a']);
    expect(report.signals[0]?.findings.map(({ subjects }) => subjects[0])).toEqual(['z', 'a']);
  });
});
