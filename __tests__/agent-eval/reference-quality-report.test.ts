import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality', 'report.mjs');
const validProvenance = { implementationHash: 'a'.repeat(64), runtimeHash: 'b'.repeat(64), host: 'test-host' };
const validProbeProvenance = { ...validProvenance, probeManifestHash: 'c'.repeat(64), probeParserHash: 'd'.repeat(64) };
const validProbe = { repoId: 'one', probeId: 'probe', status: 'measured', indexFingerprint: 'idx-a', summary: { repeatCount: 1, latencyMs: { p50: 5, min: 5, max: 5 }, payloadBytes: 10, outputHashes: ['hash'], deterministic: true, statuses: { measured: 1 }, expectationCount: 0, expectationMissCount: 0, relevance: { requiredRecall: 1, usefulRecall: 0.5, misleadingIntrusionRate: 0 } } };

function evaluate(expression: string): unknown {
  const source = `import * as report from ${JSON.stringify(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href)};\nconst validProvenance = ${JSON.stringify(validProvenance)};\nconst validProbeProvenance = ${JSON.stringify(validProbeProvenance)};\nconst validProbe = ${JSON.stringify(validProbe)};\nconsole.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const measuredRepo = {
  repoId: 'one', status: 'measured', sourceRevision: 'abc', indexFingerprint: 'idx-a',
  coverage: { fair: { any: { numerator: 2, denominator: 4, rate: 0.5 }, semantic: { numerator: 1, denominator: 4, rate: 0.25 }, importOnlyFiles: 1 } },
  languages: [], features: {}, routes: {}, optional: {}, health: {},
};

describe('reference quality reporting and comparison', () => {
  it('renders and self-compares a synthetic corpus deterministically', () => {
    const result = evaluate(`(() => {
      const input = { repos: [${JSON.stringify(measuredRepo)}], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance };
      const first = report.buildReferenceQualityReport(input);
      const second = report.buildReferenceQualityReport(input);
      return { first, sameJson: report.serializeReport(first) === report.serializeReport(second), markdown: report.renderMarkdown(first), comparison: report.compareReports(first, second) };
    })()` ) as { first: { aggregate: { fairAny: { numerator: number; denominator: number; rate: number } } }; sameJson: boolean; markdown: string; comparison: { status: string; metrics: Array<{ classification: string }> } };

    expect(result.sameJson).toBe(true); expect(result.first.aggregate.fairAny).toEqual({ numerator: 2, denominator: 4, rate: 0.5, repoMedian: 0.5 });
    expect(result.markdown).toContain('Diagnostic reference-index snapshot'); expect(result.comparison.status).toBe('unchanged'); expect(result.comparison.metrics.every((metric) => metric.classification === 'unchanged')).toBe(true);
  });

  it('aggregates graded probe relevance without collapsing it into static graph coverage', () => {
    const result = evaluate(`(() => {
      const secondProbe = structuredClone(validProbe);
      secondProbe.probeId = 'probe-two';
      secondProbe.summary.relevance = { requiredRecall: 0.5, usefulRecall: null, misleadingIntrusionRate: 0.25 };
      const value = report.buildReferenceQualityReport({ repos: [${JSON.stringify(measuredRepo)}], probes: [validProbe, secondProbe], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProbeProvenance });
      return { quality: value.probeQuality, markdown: report.renderMarkdown(value), valid: report.isReferenceQualityReport(value) };
    })()`) as { quality: Record<string, number>; markdown: string; valid: boolean };

    expect(result.valid).toBe(true);
    expect(result.quality).toEqual({
      gradedProbeCount: 2,
      requiredRecallMedian: 0.75,
      usefulRecallMedian: 0.5,
      misleadingIntrusionRateMedian: 0.125,
    });
    expect(result.markdown).toContain('Required recall');
    expect(result.markdown).toContain('Misleading intrusion');
  });

  it('marks denominator, policy, and neutral changes honestly', () => {
    const result = evaluate(`(() => {
      const base = report.buildReferenceQualityReport({ repos: [${JSON.stringify(measuredRepo)}], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance });
      const changedRepo = structuredClone(${JSON.stringify(measuredRepo)});
      changedRepo.coverage.fair.any = { numerator: 3, denominator: 5, rate: 0.6 };
      const denominatorChanged = report.buildReferenceQualityReport({ repos: [changedRepo], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance });
      const policyChanged = structuredClone(base);
      policyChanged.metricPolicyVersion = 'other-policy';
      const neutralChanged = structuredClone(base);
      neutralChanged.repos[0].health = { unresolvedPerThousand: 9 };
      return { denominator: report.compareReports(base, denominatorChanged), policy: report.compareReports(base, policyChanged), neutral: report.compareReports(base, neutralChanged) };
    })()`) as Record<string, { status: string; reason?: string; metrics: Array<{ id: string; classification: string }> }>;

    expect(result.denominator.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fairAny', classification: 'not_comparable' })]));
    expect(result.policy.status).toBe('not_comparable'); expect(result.policy.reason).toBe('metric_policy_changed');
    expect(result.neutral.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unresolvedPerThousand', classification: 'changed' })]));
  });

  it('rejects changed source provenance and compares probe diagnostics', () => {
    const result = evaluate(`(() => {
      const input = { repos: [${JSON.stringify(measuredRepo)}], probes: [validProbe], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProbeProvenance };
      const base = report.buildReferenceQualityReport(input);
      const changedRevision = structuredClone(base);
      changedRevision.repos[0].sourceRevision = 'different';
      const changedProbe = structuredClone(base);
      changedProbe.probes[0].summary.payloadBytes = 11;
      return { revision: report.compareReports(base, changedRevision), probe: report.compareReports(base, changedProbe) };
    })()`) as Record<string, { status: string; repositories?: Array<{ repoId: string; classification: string }>; probes?: Array<{ probeId: string; classification: string }> }>;

    expect(result.revision.repositories).toContainEqual({ repoId: 'one', classification: 'not_comparable', reason: 'source_revision_changed' }); expect(result.revision.status).toBe('not_comparable');
    expect(result.probe.probes).toContainEqual(expect.objectContaining({ probeId: 'probe', classification: 'changed' })); expect(result.probe.status).toBe('changed');
  });

  it('reports added and removed repositories with an explicit intersection cohort', () => {
    const result = evaluate(`(() => {
      const beforeRepo = ${JSON.stringify(measuredRepo)};
      const afterRepo = { ...structuredClone(beforeRepo), repoId: 'two' };
      const provenance = validProvenance;
      const before = report.buildReferenceQualityReport({ repos: [beforeRepo], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      const after = report.buildReferenceQualityReport({ repos: [beforeRepo, afterRepo], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      return report.compareReports(before, after);
    })()`) as { status: string; repositories: Array<{ repoId: string; classification: string }>; intersection: { repoIds: string[]; status: string } };

    expect(result.status).toBe('not_comparable'); expect(result.repositories).toContainEqual({ repoId: 'two', classification: 'added' }); expect(result.intersection).toMatchObject({ repoIds: ['one'], status: 'unchanged' });
  });

  it('self-compares identical terminal non-measured repositories as unchanged', () => {
    const result = evaluate(`(() => {
      const provenance = validProvenance;
      const reportValue = report.buildReferenceQualityReport({ repos: [{ repoId: 'empty', status: 'empty' }], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      return report.compareReports(reportValue, reportValue);
    })()`) as { status: string; repositories: Array<{ repoId: string; classification: string }> };

    expect(result.status).toBe('unchanged'); expect(result.repositories).toEqual([expect.objectContaining({ repoId: 'empty', classification: 'unchanged' })]);
  });

  it('includes every independent ratio lane in repository and aggregate comparisons', () => {
    const result = evaluate(`(() => {
      const baselineRepo = structuredClone(${JSON.stringify(measuredRepo)});
      baselineRepo.routes = { linkRate: { numerator: 1, denominator: 4, rate: 0.25 }, integrityRate: { numerator: 1, denominator: 4, rate: 0.25 } };
      baselineRepo.optional = {
        sourceChunks: { nodeCoverage: { numerator: 1, denominator: 4, rate: 0.25 } },
        scip: { documentCoverage: { numerator: 1, denominator: 4, rate: 0.25 }, linkedNodeCoverage: { numerator: 1, denominator: 4, rate: 0.25 } },
        capabilities: { completeRate: { numerator: 1, denominator: 4, rate: 0.25 } },
      };
      baselineRepo.coverage.fair = { ...baselineRepo.coverage.fair, any: { numerator: 1, denominator: 4, rate: 0.25 }, semantic: { numerator: 1, denominator: 4, rate: 0.25 } };
      const paths = {
        fairAny: ['coverage', 'fair', 'any'],
        fairSemantic: ['coverage', 'fair', 'semantic'],
        routeLink: ['routes', 'linkRate'],
        routeIntegrity: ['routes', 'integrityRate'],
        sourceChunkNode: ['optional', 'sourceChunks', 'nodeCoverage'],
        scipDocument: ['optional', 'scip', 'documentCoverage'],
        scipLinkedNode: ['optional', 'scip', 'linkedNodeCoverage'],
        capabilityComplete: ['optional', 'capabilities', 'completeRate'],
      };
      const provenance = validProvenance;
      const build = (repoValue) => report.buildReferenceQualityReport({ repos: [repoValue], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      const before = build(baselineRepo);
      return Object.fromEntries(Object.entries(paths).map(([lane, pathParts]) => {
        const changed = structuredClone(baselineRepo);
        let target = changed;
        for (const part of pathParts.slice(0, -1)) target = target[part];
        target[pathParts.at(-1)] = { numerator: 2, denominator: 4, rate: 0.5 };
        const comparison = report.compareReports(before, build(changed));
        return [lane, { repository: comparison.repositories[0].metrics.find((metric) => metric.id === lane)?.classification, aggregate: comparison.metrics.find((metric) => metric.id === lane)?.classification }];
      }));
    })()`) as Record<string, { repository: string; aggregate: string }>;

    expect(Object.keys(result)).toHaveLength(8); expect(Object.values(result).every((lane) => lane.repository === 'improved')).toBe(true); expect(Object.values(result).every((lane) => lane.aggregate === 'improved')).toBe(true);
  });

  it('requires a matching non-null revision or source fingerprint', () => {
    const result = evaluate(`(() => {
      const provenance = validProvenance;
      const build = (repoValue) => report.buildReferenceQualityReport({ repos: [repoValue], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      const withoutIdentity = { ...structuredClone(${JSON.stringify(measuredRepo)}), sourceRevision: null };
      const fingerprintBefore = { ...structuredClone(withoutIdentity), sourceFingerprint: 'source-a' };
      const fingerprintAfter = { ...structuredClone(fingerprintBefore), sourceRevision: 'different' };
      const revisionBefore = { ...structuredClone(withoutIdentity), sourceRevision: 'revision-a' };
      const revisionAfter = { ...structuredClone(revisionBefore), sourceFingerprint: 'different' };
      return {
        missing: report.compareReports(build(withoutIdentity), build(withoutIdentity)).repositories[0],
        fingerprint: report.compareReports(build(fingerprintBefore), build(fingerprintAfter)).repositories[0],
        revision: report.compareReports(build(revisionBefore), build(revisionAfter)).repositories[0],
      };
    })()`) as Record<string, { classification: string }>;

    expect(result.missing.classification).toBe('not_comparable'); expect(result.fingerprint.classification).toBe('unchanged'); expect(result.revision.classification).toBe('unchanged');
  });

  it('classifies absent and available feature transitions as added and removed', () => {
    const result = evaluate(`(() => {
      const beforeRepo = structuredClone(${JSON.stringify(measuredRepo)});
      beforeRepo.features = { sourceChunks: { status: 'absent' }, scipDocuments: { status: 'available_nonempty' } };
      const afterRepo = structuredClone(beforeRepo);
      afterRepo.features.sourceChunks = { status: 'available_empty' };
      afterRepo.features.scipDocuments = { status: 'absent' };
      const provenance = validProvenance;
      const build = (repoValue) => report.buildReferenceQualityReport({ repos: [repoValue], generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      return report.compareReports(build(beforeRepo), build(afterRepo)).repositories[0].metrics;
    })()`) as Array<{ id: string; classification: string }>;

    expect(result).toContainEqual(expect.objectContaining({ id: 'availability.sourceChunks', classification: 'added' })); expect(result).toContainEqual(expect.objectContaining({ id: 'availability.scipDocuments', classification: 'removed' }));
  });

  it('recomputes intersection aggregates without issuing a full-cohort metric verdict', () => {
    const result = evaluate(`(() => {
      const commonBefore = structuredClone(${JSON.stringify(measuredRepo)});
      commonBefore.coverage.fair.any = { numerator: 1, denominator: 2, rate: 0.5 };
      const commonAfter = structuredClone(commonBefore);
      commonAfter.coverage.fair.any = { numerator: 2, denominator: 2, rate: 1 };
      const removed = { ...structuredClone(commonBefore), repoId: 'removed', coverage: { fair: { ...commonBefore.coverage.fair, any: { numerator: 2, denominator: 2, rate: 1 } } } };
      const added = { ...structuredClone(commonBefore), repoId: 'added', coverage: { fair: { ...commonBefore.coverage.fair, any: { numerator: 0, denominator: 2, rate: 0 } } } };
      const provenance = validProvenance;
      const build = (repos) => report.buildReferenceQualityReport({ repos, generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      return report.compareReports(build([commonBefore, removed]), build([commonAfter, added]));
    })()`) as { status: string; metrics: unknown[]; intersection: { repoIds: string[]; before: { fairAny: { numerator: number; denominator: number } }; after: { fairAny: { numerator: number; denominator: number } }; metrics: Array<{ id: string; classification: string }> } };

    expect(result.status).toBe('not_comparable'); expect(result.metrics).toEqual([]); expect(result.intersection.repoIds).toEqual(['one']);
    expect(result.intersection.before.fairAny).toMatchObject({ numerator: 1, denominator: 2 }); expect(result.intersection.after.fairAny).toMatchObject({ numerator: 2, denominator: 2 }); expect(result.intersection.metrics).toContainEqual(expect.objectContaining({ id: 'fairAny', classification: 'improved' }));
  });

  it('rejects malformed nested report structures', () => {
    const result = evaluate(`(() => {
      const valid = report.buildReferenceQualityReport({ repos: [${JSON.stringify(measuredRepo)}], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance });
      const badAggregate = structuredClone(valid);
      badAggregate.aggregate.fairAny.denominator = 'four';
      const badRepo = structuredClone(valid);
      delete badRepo.repos[0].coverage.fair.semantic.numerator;
      const badProbe = structuredClone(valid);
      badProbe.probes = [{ repoId: 'one', probeId: 'probe', status: 'measured', indexFingerprint: 'idx-a', summary: { repeatCount: 'one' } }];
      return [badAggregate, badRepo, badProbe].map((candidate) => ({
        valid: report.isReferenceQualityReport(candidate),
        comparison: report.compareReports(valid, candidate).reason,
      }));
    })()`) as Array<{ valid: boolean; comparison: string }>;

    expect(result).toEqual([{ valid: false, comparison: 'invalid_report' }, { valid: false, comparison: 'invalid_report' }, { valid: false, comparison: 'invalid_report' }]);
  });

  it('serializes and neutrally compares recursively reordered object keys identically', () => {
    const result = evaluate(`(() => {
      const leftRepo = structuredClone(${JSON.stringify(measuredRepo)});
      leftRepo.health = { unresolvedPerThousand: 1, nested: { alpha: 1, beta: 2 } };
      const rightRepo = structuredClone(leftRepo);
      rightRepo.health = { nested: { beta: 2, alpha: 1 }, unresolvedPerThousand: 1 };
      const provenance = { ...validProvenance, nested: { alpha: 1, beta: 2 } };
      const reorderedProvenance = { nested: { beta: 2, alpha: 1 }, host: validProvenance.host, runtimeHash: validProvenance.runtimeHash, implementationHash: validProvenance.implementationHash };
      const build = (repoValue, provenanceValue) => report.buildReferenceQualityReport({ repos: [repoValue], generatedAt: '2026-01-01T00:00:00.000Z', provenance: provenanceValue });
      const left = build(leftRepo, provenance);
      const right = build(rightRepo, reorderedProvenance);
      return {
        sameJson: report.serializeReport(left) === report.serializeReport(right),
        comparison: report.compareReports(left, right),
      };
    })()`) as { sameJson: boolean; comparison: { status: string; repositories: Array<{ metrics: Array<{ id: string; classification: string }> }> } };

    expect(result.sameJson).toBe(true);
    expect(result.comparison.status).toBe('unchanged');
    expect(result.comparison.repositories[0].metrics).toContainEqual(expect.objectContaining({ id: 'health', classification: 'unchanged' }));
  });

  it('treats matching source revisions as non-comparable when authoritative fingerprints differ', () => {
    const result = evaluate(`(() => {
      const beforeRepo = { ...structuredClone(${JSON.stringify(measuredRepo)}), sourceFingerprint: 'source-a' };
      const afterRepo = { ...structuredClone(beforeRepo), sourceFingerprint: 'source-b' };
      const build = (repoValue) => report.buildReferenceQualityReport({ repos: [repoValue], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance });
      return report.compareReports(build(beforeRepo), build(afterRepo)).repositories[0];
    })()`) as { classification: string; reason: string };

    expect(result).toEqual({ repoId: 'one', classification: 'not_comparable', reason: 'source_fingerprint_changed' });
  });

  it('rejects impossible and internally inconsistent ratio values', () => {
    const result = evaluate(`(() => {
      const base = report.buildReferenceQualityReport({ repos: [${JSON.stringify(measuredRepo)}], generatedAt: '2026-01-01T00:00:00.000Z', provenance: validProvenance });
      const ratios = {
        numeratorAboveDenominator: { numerator: 5, denominator: 4, rate: 1.25 },
        zeroDenominatorWithRate: { numerator: 0, denominator: 0, rate: 0 },
        zeroDenominatorWithNumerator: { numerator: 1, denominator: 0, rate: null },
        mismatchedRate: { numerator: 2, denominator: 4, rate: 0.6 },
        outOfRangeRate: { numerator: 2, denominator: 4, rate: 1.2 },
      };
      const repoResults = Object.fromEntries(Object.entries(ratios).map(([name, ratio]) => {
        const candidate = structuredClone(base);
        candidate.repos[0].coverage.fair.any = ratio;
        return [name, report.isReferenceQualityReport(candidate)];
      }));
      const zeroAggregateMedian = structuredClone(base);
      zeroAggregateMedian.aggregate.lanes.routeLink = { numerator: 0, denominator: 0, rate: null, repoMedian: 0 };
      return { valid: report.isReferenceQualityReport(base), ...repoResults, zeroAggregateMedian: report.isReferenceQualityReport(zeroAggregateMedian) };
    })()`) as Record<string, boolean>;

    expect(result.valid).toBe(true);
    expect(Object.entries(result).filter(([name]) => name !== 'valid').every(([, valid]) => !valid)).toBe(true);
  });

  it('rejects invalid statuses, policy, timestamp, and required provenance', () => {
    const result = evaluate(`(() => {
      const build = (provenance, probes = []) => report.buildReferenceQualityReport({ repos: [${JSON.stringify(measuredRepo)}], probes, generatedAt: '2026-01-01T00:00:00.000Z', provenance });
      const base = build(validProvenance);
      const probeBase = build(validProbeProvenance, [validProbe]);
      const candidates = {};
      candidates.repoStatus = structuredClone(base); candidates.repoStatus.repos[0].status = 'unknown';
      candidates.probeStatus = structuredClone(probeBase); candidates.probeStatus.probes[0].status = 'unknown';
      candidates.policy = structuredClone(base); candidates.policy.metricPolicyVersion = 'other-policy';
      candidates.generatedAt = structuredClone(base); candidates.generatedAt.generatedAt = 'not-a-date';
      candidates.missingImplementation = build({ runtimeHash: validProvenance.runtimeHash, host: validProvenance.host });
      candidates.invalidImplementation = build({ ...validProvenance, implementationHash: 'A'.repeat(64) });
      candidates.missingRuntime = build({ implementationHash: validProvenance.implementationHash, host: validProvenance.host });
      candidates.invalidRuntime = build({ ...validProvenance, runtimeHash: 'short' });
      candidates.emptyHost = build({ ...validProvenance, host: '' });
      candidates.missingManifest = build({ ...validProvenance, probeParserHash: validProbeProvenance.probeParserHash }, [validProbe]);
      candidates.invalidParser = build({ ...validProbeProvenance, probeParserHash: 'D'.repeat(64) }, [validProbe]);
      return { base: report.isReferenceQualityReport(base), probeBase: report.isReferenceQualityReport(probeBase), invalid: Object.fromEntries(Object.entries(candidates).map(([name, candidate]) => [name, report.isReferenceQualityReport(candidate)])) };
    })()`) as { base: boolean; probeBase: boolean; invalid: Record<string, boolean> };

    expect(result).toMatchObject({ base: true, probeBase: true });
    expect(Object.values(result.invalid).every((valid) => !valid)).toBe(true);
  });
});
