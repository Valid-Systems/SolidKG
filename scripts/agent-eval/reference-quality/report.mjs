import { METRIC_DIRECTIONS, METRIC_POLICY_VERSION, REPORT_SCHEMA, compareRatio, isAvailabilityStatus } from './policy.mjs';

const RATIO_LANES = Object.freeze([
  { id: 'fairAny', repo: (value) => value.coverage?.fair?.any, aggregate: (value) => value.fairAny }, { id: 'fairSemantic', repo: (value) => value.coverage?.fair?.semantic, aggregate: (value) => value.fairSemantic },
  { id: 'routeLink', repo: (value) => value.routes?.linkRate, aggregate: (value) => value.lanes.routeLink }, { id: 'routeIntegrity', repo: (value) => value.routes?.integrityRate, aggregate: (value) => value.lanes.routeIntegrity },
  { id: 'sourceChunkNode', repo: (value) => value.optional?.sourceChunks?.nodeCoverage, aggregate: (value) => value.lanes.sourceChunkNode }, { id: 'scipDocument', repo: (value) => value.optional?.scip?.documentCoverage, aggregate: (value) => value.lanes.scipDocument },
  { id: 'scipLinkedNode', repo: (value) => value.optional?.scip?.linkedNodeCoverage, aggregate: (value) => value.lanes.scipLinkedNode }, { id: 'capabilityComplete', repo: (value) => value.optional?.capabilities?.completeRate, aggregate: (value) => value.lanes.capabilityComplete },
]);
const REPO_STATUSES = new Set(['measured', 'empty', 'incompatible_schema', 'corrupt']);
const PROBE_STATUSES = new Set(['measured', 'miss', 'abstained', 'nondeterministic', 'error', 'unavailable', 'stale', 'timeout']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) return null; const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3));
}

function aggregateRatio(repos, selector) {
  const ratios = repos.map(selector).filter((value) => value?.denominator > 0);
  const numerator = ratios.reduce((sum, value) => sum + value.numerator, 0);
  const denominator = ratios.reduce((sum, value) => sum + value.denominator, 0);
  return { numerator, denominator, rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(3)), repoMedian: median(ratios.map((value) => value.rate)) };
}

function distribution(values) {
  const result = {};
  for (const value of values) {
    const key = value === null || value === undefined ? 'unavailable' : String(value); result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function sumRows(repos, selector, key) {
  const totals = new Map();
  for (const repo of repos) for (const row of selector(repo) ?? []) totals.set(row[key], (totals.get(row[key]) ?? 0) + Number(row.count));
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => ({ [key]: name, count }));
}

function aggregateLanguages(repos) {
  const grouped = new Map();
  for (const repo of repos) for (const row of repo.languages ?? []) grouped.set(row.language, [...(grouped.get(row.language) ?? []), row]);
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([language, rows]) => ({ language, any: aggregateRatio(rows, (row) => row.any), semantic: aggregateRatio(rows, (row) => row.semantic) }));
}

function aggregateFeatures(repos) { const names = [...new Set(repos.flatMap((repo) => Object.keys(repo.features ?? {})))].sort(); return Object.fromEntries(names.map((name) => [name, distribution(repos.map((repo) => repo.features?.[name]?.status ?? null))])); }

function duplicateCanonicalRepos(repos) {
  const grouped = new Map();
  for (const repo of repos) if (repo.canonicalRemote) grouped.set(repo.canonicalRemote, [...(grouped.get(repo.canonicalRemote) ?? []), repo.repoId]);
  return [...grouped.entries()].filter(([, repoIds]) => repoIds.length > 1).sort(([left], [right]) => left.localeCompare(right)).map(([canonicalRemote, repoIds]) => ({ canonicalRemote, repoIds: repoIds.sort() }));
}

function buildAggregate(repos) {
  const measured = repos.filter((repo) => repo.status === 'measured');
  return {
    repoCount: repos.length, measuredRepoCount: measured.length,
    statusDistribution: distribution(repos.map((repo) => repo.status)), schemaVersionDistribution: distribution(repos.map((repo) => repo.schemaVersion)),
    producerVersionDistribution: distribution(repos.map((repo) => repo.producerVersion)), featureAvailability: aggregateFeatures(repos),
    duplicateCanonicalRepos: duplicateCanonicalRepos(repos), totalDatabaseBytes: repos.reduce((sum, repo) => sum + Number(repo.databaseBytes ?? 0), 0),
    totalScanDurationMs: repos.reduce((sum, repo) => sum + Number(repo.scanDurationMs ?? 0), 0), noDeclarationExclusions: measured.reduce((sum, repo) => sum + Number(repo.coverage?.fair?.excludedFiles ?? 0), 0),
    fairAny: aggregateRatio(measured, (repo) => repo.coverage.fair.any), fairSemantic: aggregateRatio(measured, (repo) => repo.coverage.fair.semantic),
    languages: aggregateLanguages(measured),
    lanes: Object.fromEntries(RATIO_LANES.slice(2).map((lane) => [lane.id, aggregateRatio(measured, lane.repo)])),
    burdens: {
      unresolvedReferences: measured.reduce((sum, repo) => sum + Number(repo.health?.unresolvedReferences ?? 0), 0), fileErrors: measured.reduce((sum, repo) => sum + Number(repo.health?.fileErrors ?? 0), 0),
      danglingEdges: measured.reduce((sum, repo) => sum + Number(repo.health?.danglingEdges ?? 0), 0), danglingUnresolvedReferences: measured.reduce((sum, repo) => sum + Number(repo.health?.danglingUnresolvedReferences ?? 0), 0),
      missingProvenance: measured.reduce((sum, repo) => sum + Number(repo.health?.missingProvenance ?? 0), 0),
    },
    provenanceDistribution: sumRows(measured, (repo) => repo.health?.provenanceDistribution, 'provenance'), synthesizedFamilies: sumRows(measured, (repo) => repo.health?.synthesizedFamilies, 'synthesizedBy'),
  };
}

function buildProbeQuality(probes) {
  const graded = probes.filter((probe) => {
    if (!['measured', 'miss', 'abstained'].includes(probe.status) || !isObject(probe.summary?.relevance)) return false;
    return ['requiredRecall', 'usefulRecall', 'misleadingIntrusionRate']
      .some((metric) => probe.summary.relevance[metric] !== null && probe.summary.relevance[metric] !== undefined);
  });
  return {
    gradedProbeCount: graded.length,
    requiredRecallMedian: median(graded.map((probe) => probe.summary.relevance.requiredRecall)),
    usefulRecallMedian: median(graded.map((probe) => probe.summary.relevance.usefulRecall)),
    misleadingIntrusionRateMedian: median(graded.map((probe) => probe.summary.relevance.misleadingIntrusionRate)),
  };
}

export function buildReferenceQualityReport(input) {
  const repos = [...input.repos].sort((left, right) => left.repoId.localeCompare(right.repoId));
  const fingerprints = new Map(repos.map((repo) => [repo.repoId, repo.indexFingerprint ?? null]));
  const probes = [...(input.probes ?? [])].map((probe) => ({ ...probe, indexFingerprint: probe.indexFingerprint ?? fingerprints.get(probe.repoId) ?? null }))
    .sort((left, right) => `${left.repoId}/${left.probeId}`.localeCompare(`${right.repoId}/${right.probeId}`));
  return {
    schemaName: REPORT_SCHEMA, metricPolicyVersion: METRIC_POLICY_VERSION,
    claimBoundary: 'Diagnostic reference-index snapshot. Mixed historical indexes do not prove current-build extraction quality or universal superiority.',
    generatedAt: input.generatedAt, provenance: input.provenance, aggregate: buildAggregate(repos), probeQuality: buildProbeQuality(probes), probes, repos,
  };
}

function canonicalValue(value, portable = false) {
  if (portable && typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (portable && typeof value === 'string' && /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(value)) return '<redacted-absolute-path>';
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, portable));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item, portable)]));
  }
  return value;
}

export function serializeReport(report) { return `${JSON.stringify(canonicalValue(report, true), null, 2)}\n`; }

function pct(value) { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

export function renderMarkdown(report) {
  const lines = [
    '# SolidKG Reference Quality Baseline', '', '> Diagnostic reference-index snapshot. This is not a current-build extraction or universal superiority claim.', '',
    `Generated: ${report.generatedAt}`, '', `Indexes: ${report.aggregate.repoCount} discovered; ${report.aggregate.measuredRepoCount} measured.`, '',
    '## Aggregate coverage', '', '| Metric | Numerator | Denominator | Micro | Repo median |', '|---|---:|---:|---:|---:|',
    `| Any cross-file dependent | ${report.aggregate.fairAny.numerator} | ${report.aggregate.fairAny.denominator} | ${pct(report.aggregate.fairAny.rate)} | ${pct(report.aggregate.fairAny.repoMedian)} |`, `| Semantic cross-file dependent | ${report.aggregate.fairSemantic.numerator} | ${report.aggregate.fairSemantic.denominator} | ${pct(report.aggregate.fairSemantic.rate)} | ${pct(report.aggregate.fairSemantic.repoMedian)} |`,
    '', '## Independent metric lanes', '', '| Lane | Numerator | Denominator | Micro | Repo median |', '|---|---:|---:|---:|---:|',
    ...Object.entries(report.aggregate.lanes).map(([name, value]) => `| ${name} | ${value.numerator} | ${value.denominator} | ${pct(value.rate)} | ${pct(value.repoMedian)} |`),
    '', '## Language coverage', '', '| Language | Any micro | Any median | Semantic micro | Semantic median |', '|---|---:|---:|---:|---:|',
    ...report.aggregate.languages.map((row) => `| ${row.language} | ${pct(row.any.rate)} | ${pct(row.any.repoMedian)} | ${pct(row.semantic.rate)} | ${pct(row.semantic.repoMedian)} |`),
    '', '## Availability and health', '',
    `- No-declaration exclusions: ${report.aggregate.noDeclarationExclusions}`, `- File errors: ${report.aggregate.burdens.fileErrors}`,
    `- Dangling edges: ${report.aggregate.burdens.danglingEdges}`, `- Duplicate canonical repositories: ${report.aggregate.duplicateCanonicalRepos.length}`,
    `- Schema versions: ${JSON.stringify(report.aggregate.schemaVersionDistribution)}`, `- Producer versions: ${JSON.stringify(report.aggregate.producerVersionDistribution)}`,
    '', '## Graded probe relevance', '',
    `- Graded probes: ${report.probeQuality?.gradedProbeCount ?? 0}`,
    `- Required recall median: ${pct(report.probeQuality?.requiredRecallMedian ?? null)}`,
    `- Useful recall median: ${pct(report.probeQuality?.usefulRecallMedian ?? null)}`,
    `- Misleading intrusion median: ${pct(report.probeQuality?.misleadingIntrusionRateMedian ?? null)}`,
    '', '### Optional feature availability', '',
    ...Object.entries(report.aggregate.featureAvailability).map(([name, statuses]) => `- ${name}: ${JSON.stringify(statuses)}`),
    '', '## Repository results', '', '| Repository | Status | Schema | Files | Fair any | Fair semantic | Unresolved / 1k |', '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const repo of report.repos) lines.push(`| ${repo.repoId} | ${repo.status} | ${repo.schemaVersion ?? 'n/a'} | ${repo.counts?.files ?? 'n/a'} | ${pct(repo.coverage?.fair?.any?.rate ?? null)} | ${pct(repo.coverage?.fair?.semantic?.rate ?? null)} | ${repo.health?.unresolvedPerThousand ?? 'n/a'} |`); lines.push('', '## Status distribution', '');
  for (const [status, count] of Object.entries(report.aggregate.statusDistribution)) lines.push(`- ${status}: ${count}`);
  lines.push('', '## Probe diagnostics', '', '| Probe | Status | Repeats | p50 ms | Payload bytes | Required recall | Misleading intrusion | Expectation misses |', '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const probe of report.probes) lines.push(`| ${probe.repoId}/${probe.probeId} | ${probe.status} | ${probe.summary?.repeatCount ?? 'n/a'} | ${probe.summary?.latencyMs?.p50 ?? 'n/a'} | ${probe.summary?.payloadBytes ?? 'n/a'} | ${pct(probe.summary?.relevance?.requiredRecall ?? null)} | ${pct(probe.summary?.relevance?.misleadingIntrusionRate ?? null)} | ${probe.summary?.expectationMissCount ?? 'n/a'} |`);
  lines.push('', '## Claim boundary', '', report.claimBoundary, ''); return lines.join('\n');
}

function neutralMetric(id, before, after) { return { id, classification: JSON.stringify(canonicalValue(before)) === JSON.stringify(canonicalValue(after)) ? 'unchanged' : 'changed', before: before ?? null, after: after ?? null }; }

function ratioMetric(id, before, after) {
  const classification = JSON.stringify(canonicalValue(before)) === JSON.stringify(canonicalValue(after)) ? 'unchanged'
    : before == null ? 'added' : after == null ? 'removed' : compareRatio(before, after);
  return { id, classification, before: before ?? null, after: after ?? null };
}

function availabilityMetrics(before, after) {
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return names.map((name) => {
    const left = before?.[name] ?? null; const right = after?.[name] ?? null;
    const leftStatus = left?.status ?? 'absent'; const rightStatus = right?.status ?? 'absent';
    const leftAvailable = leftStatus === 'available_empty' || leftStatus === 'available_nonempty';
    const rightAvailable = rightStatus === 'available_empty' || rightStatus === 'available_nonempty';
    const classification = leftStatus === 'absent' && rightAvailable ? 'added'
      : leftAvailable && rightStatus === 'absent' ? 'removed'
        : JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right)) ? 'unchanged' : 'changed';
    return { id: `availability.${name}`, classification, before: left, after: right };
  });
}

function sourceIdentityMatches(before, after) {
  const fingerprintsExist = typeof before.sourceFingerprint === 'string' && before.sourceFingerprint.length > 0 && typeof after.sourceFingerprint === 'string' && after.sourceFingerprint.length > 0;
  return fingerprintsExist ? before.sourceFingerprint === after.sourceFingerprint : typeof before.sourceRevision === 'string' && before.sourceRevision.length > 0 && before.sourceRevision === after.sourceRevision;
}

function compareRepo(before, after) {
  if (before.status !== 'measured' || after.status !== 'measured') {
    const metric = neutralMetric('terminalResult', before, after); return { repoId: before.repoId, classification: metric.classification, metrics: [metric] };
  }
  if (!sourceIdentityMatches(before, after)) {
    const reason = before.sourceFingerprint && after.sourceFingerprint ? 'source_fingerprint_changed' : before.sourceRevision && after.sourceRevision ? 'source_revision_changed' : 'source_identity_unavailable'; return { repoId: before.repoId, classification: 'not_comparable', reason };
  }
  const metrics = [...RATIO_LANES.map((lane) => ratioMetric(lane.id, lane.repo(before), lane.repo(after))), neutralMetric('health', before.health ?? null, after.health ?? null), ...availabilityMetrics(before.features, after.features)];
  const classification = metrics.some((metric) => metric.classification === 'not_comparable') ? 'not_comparable'
    : metrics.some((metric) => metric.classification !== 'unchanged') ? 'changed' : 'unchanged';
  return { repoId: before.repoId, classification, metrics };
}

function compareRepositories(beforeRepos, afterRepos) {
  const before = new Map(beforeRepos.map((repo) => [repo.repoId, repo]));
  const after = new Map(afterRepos.map((repo) => [repo.repoId, repo]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((repoId) => {
    if (!before.has(repoId)) return { repoId, classification: 'added' };
    if (!after.has(repoId)) return { repoId, classification: 'removed' };
    return compareRepo(before.get(repoId), after.get(repoId));
  });
}

function compareProbes(beforeReport, afterReport) {
  const comparable = ['probeManifestHash', 'probeParserHash'].every((name) => typeof beforeReport.provenance?.[name] === 'string' && beforeReport.provenance[name].length > 0 && beforeReport.provenance[name] === afterReport.provenance?.[name]);
  const key = (probe) => `${probe.repoId}/${probe.probeId}`;
  const before = new Map(beforeReport.probes.map((probe) => [key(probe), probe]));
  const after = new Map(afterReport.probes.map((probe) => [key(probe), probe]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((id) => {
    const left = before.get(id); const right = after.get(id); const [repoId, probeId] = id.split('/');
    if (!left) return { repoId, probeId, classification: 'added' };
    if (!right) return { repoId, probeId, classification: 'removed' };
    const fingerprintMatches = typeof left.indexFingerprint === 'string' && left.indexFingerprint.length > 0 && left.indexFingerprint === right.indexFingerprint;
    if (!comparable || !fingerprintMatches) return { repoId, probeId, classification: 'not_comparable' }; const classification = neutralMetric('probe', { status: left.status, summary: left.summary }, { status: right.status, summary: right.summary }).classification; return { repoId, probeId, classification };
  });
}

function overallStatus(repositories, probes) {
  const classifications = [...repositories, ...probes].map((row) => row.classification); return classifications.includes('not_comparable') ? 'not_comparable' : classifications.every((value) => value === 'unchanged') ? 'unchanged' : 'changed';
}

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

function isRatio(value, aggregate = false) {
  if (!isObject(value) || !Number.isInteger(value.numerator) || value.numerator < 0 || !Number.isInteger(value.denominator) || value.denominator < value.numerator) return false;
  const expectedRate = value.denominator === 0 ? null : Number((value.numerator / value.denominator).toFixed(3));
  return value.rate === expectedRate && (!aggregate || (value.denominator === 0 ? value.repoMedian === null : isNumber(value.repoMedian) && value.repoMedian >= 0 && value.repoMedian <= 1));
}

function isDistribution(value) { return isObject(value) && Object.values(value).every((count) => Number.isInteger(count) && count >= 0); }

function isFeatureMap(value) { return isObject(value) && Object.values(value).every((feature) => isObject(feature) && isAvailabilityStatus(feature.status)); }

function isCountRows(value, key) { return Array.isArray(value) && value.every((row) => isObject(row) && typeof row[key] === 'string' && Number.isInteger(row.count) && row.count >= 0); }

function isRepo(value) {
  if (!isObject(value) || typeof value.repoId !== 'string' || !REPO_STATUSES.has(value.status)) return false;
  const identitiesValid = ['sourceRevision', 'sourceFingerprint', 'indexFingerprint'].every((key) => value[key] == null || (typeof value[key] === 'string' && value[key].length > 0));
  if (!identitiesValid || value.status !== 'measured') return identitiesValid;
  const fair = value.coverage?.fair;
  const languagesValid = Array.isArray(value.languages) && value.languages.every((row) => isObject(row) && typeof row.language === 'string' && isRatio(row.any) && isRatio(row.semantic));
  const optionalValid = isObject(value.optional)
    && (value.optional.sourceChunks === undefined || (isObject(value.optional.sourceChunks) && isRatio(value.optional.sourceChunks.nodeCoverage)))
    && (value.optional.scip === undefined || (isObject(value.optional.scip) && isRatio(value.optional.scip.documentCoverage) && (value.optional.scip.linkedNodeCoverage === null || isRatio(value.optional.scip.linkedNodeCoverage))))
    && (value.optional.capabilities === undefined || (isObject(value.optional.capabilities) && isRatio(value.optional.capabilities.completeRate)));
  const healthValid = isObject(value.health) && ['unresolvedReferences', 'unresolvedPerThousand', 'fileErrors', 'danglingEdges', 'danglingUnresolvedReferences', 'missingProvenance', 'crossFileEdges', 'heuristicCrossFileEdges', 'heuristicShare'].every((key) => value.health[key] == null || isNumber(value.health[key]));
  return isObject(fair) && isRatio(fair.any) && isRatio(fair.semantic) && languagesValid && isFeatureMap(value.features)
    && isObject(value.routes) && (value.routes.linkRate === undefined || isRatio(value.routes.linkRate))
    && (value.routes.integrityRate === undefined || value.routes.integrityRate === null || isRatio(value.routes.integrityRate))
    && optionalValid && healthValid && (value.health.provenanceDistribution === undefined || isCountRows(value.health.provenanceDistribution, 'provenance')) && (value.health.synthesizedFamilies === undefined || isCountRows(value.health.synthesizedFamilies, 'synthesizedBy'));
}

function isAggregate(value) {
  if (!isObject(value) || !isRatio(value.fairAny, true) || !isRatio(value.fairSemantic, true) || !isObject(value.lanes)) return false;
  const lanesValid = RATIO_LANES.slice(2).every((lane) => isRatio(value.lanes[lane.id], true));
  const languagesValid = Array.isArray(value.languages) && value.languages.every((row) => isObject(row) && typeof row.language === 'string' && isRatio(row.any, true) && isRatio(row.semantic, true));
  const availabilityValid = isObject(value.featureAvailability) && Object.values(value.featureAvailability).every(isDistribution);
  const rowsValid = isCountRows(value.provenanceDistribution, 'provenance') && isCountRows(value.synthesizedFamilies, 'synthesizedBy') && Array.isArray(value.duplicateCanonicalRepos) && value.duplicateCanonicalRepos.every((row) => isObject(row) && typeof row.canonicalRemote === 'string' && Array.isArray(row.repoIds) && row.repoIds.every((repoId) => typeof repoId === 'string'));
  return lanesValid && languagesValid && availabilityValid && rowsValid && isDistribution(value.statusDistribution)
    && isDistribution(value.schemaVersionDistribution) && isDistribution(value.producerVersionDistribution)
    && Number.isInteger(value.repoCount) && Number.isInteger(value.measuredRepoCount) && isObject(value.burdens)
    && ['unresolvedReferences', 'fileErrors', 'danglingEdges', 'danglingUnresolvedReferences', 'missingProvenance'].every((key) => isNumber(value.burdens[key]))
    && isNumber(value.totalDatabaseBytes) && isNumber(value.totalScanDurationMs) && isNumber(value.noDeclarationExclusions)
    && Array.isArray(value.provenanceDistribution) && Array.isArray(value.synthesizedFamilies);
}

function isNullableRate(value) { return value === null || isNumber(value) && value >= 0 && value <= 1; }

function isProbeRelevance(value) { return isObject(value) && ['requiredRecall', 'usefulRecall', 'misleadingIntrusionRate'].every((key) => isNullableRate(value[key])); }

function isProbeQuality(value) { return isObject(value) && Number.isInteger(value.gradedProbeCount) && value.gradedProbeCount >= 0 && ['requiredRecallMedian', 'usefulRecallMedian', 'misleadingIntrusionRateMedian'].every((key) => isNullableRate(value[key])); }

function isProbeSummary(value) { return isObject(value) && Number.isInteger(value.repeatCount) && isObject(value.latencyMs) && ['p50', 'min', 'max'].every((key) => value.latencyMs[key] === null || isNumber(value.latencyMs[key])) && Number.isInteger(value.payloadBytes) && Array.isArray(value.outputHashes) && value.outputHashes.every((hash) => typeof hash === 'string') && typeof value.deterministic === 'boolean' && isDistribution(value.statuses) && Number.isInteger(value.expectationCount) && Number.isInteger(value.expectationMissCount) && (value.relevance === undefined || isProbeRelevance(value.relevance)); }

function isProbe(value) { return isObject(value) && typeof value.repoId === 'string' && typeof value.probeId === 'string' && PROBE_STATUSES.has(value.status) && (value.indexFingerprint == null || typeof value.indexFingerprint === 'string') && (value.summary === undefined || isProbeSummary(value.summary)) && (value.status !== 'measured' || isProbeSummary(value.summary)); }

function isProvenance(value, probesExist) { return isObject(value) && HASH_PATTERN.test(value.implementationHash) && HASH_PATTERN.test(value.runtimeHash) && typeof value.host === 'string' && value.host.trim().length > 0 && (!probesExist || HASH_PATTERN.test(value.probeManifestHash) && HASH_PATTERN.test(value.probeParserHash)); }

export function isReferenceQualityReport(value) {
  return Boolean(isObject(value) && value.schemaName === REPORT_SCHEMA && value.metricPolicyVersion === METRIC_POLICY_VERSION && typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt)) && typeof value.claimBoundary === 'string'
    && isAggregate(value.aggregate) && Array.isArray(value.repos) && value.repos.every(isRepo) && new Set(value.repos.map((repo) => repo.repoId)).size === value.repos.length
    && (value.probeQuality === undefined || isProbeQuality(value.probeQuality))
    && Array.isArray(value.probes) && isProvenance(value.provenance, value.probes.length > 0) && value.probes.every(isProbe) && new Set(value.probes.map((probe) => `${probe.repoId}/${probe.probeId}`)).size === value.probes.length);
}

function aggregateMetrics(before, after, cohorts) {
  return [
    ...RATIO_LANES.map((lane) => ratioMetric(lane.id, lane.aggregate(before), lane.aggregate(after))),
    neutralMetric('availability', before.featureAvailability, after.featureAvailability),
    neutralMetric('unresolvedPerThousand',
      Object.fromEntries(cohorts.before.map((repo) => [repo.repoId, repo.health?.unresolvedPerThousand ?? null])),
      Object.fromEntries(cohorts.after.map((repo) => [repo.repoId, repo.health?.unresolvedPerThousand ?? null]))),
  ];
}

export function compareReports(before, after) {
  if (isObject(before) && isObject(after) && before.metricPolicyVersion !== after.metricPolicyVersion) return { status: 'not_comparable', reason: 'metric_policy_changed', metrics: [] };
  if (!isReferenceQualityReport(before) || !isReferenceQualityReport(after)) return { status: 'not_comparable', reason: 'invalid_report', metrics: [] };
  const repositories = compareRepositories(before.repos, after.repos);
  const probes = compareProbes(before, after); const sameCohort = repositories.every((row) => row.classification !== 'added' && row.classification !== 'removed');
  const metrics = sameCohort ? aggregateMetrics(before.aggregate, after.aggregate, { before: before.repos, after: after.repos }) : [];
  const intersectionIds = repositories.filter((row) => row.classification !== 'added' && row.classification !== 'removed').map((row) => row.repoId);
  const intersectionRows = repositories.filter((row) => intersectionIds.includes(row.repoId)); const beforeIntersectionRepos = before.repos.filter((repo) => intersectionIds.includes(repo.repoId));
  const afterIntersectionRepos = after.repos.filter((repo) => intersectionIds.includes(repo.repoId)); const beforeIntersection = buildAggregate(beforeIntersectionRepos); const afterIntersection = buildAggregate(afterIntersectionRepos);
  const intersectionMetrics = aggregateMetrics(beforeIntersection, afterIntersection, { before: beforeIntersectionRepos, after: afterIntersectionRepos });
  const intersection = {
    repoIds: intersectionIds,
    status: overallStatus([...intersectionRows, ...intersectionMetrics], probes.filter((probe) => intersectionIds.includes(probe.repoId))),
    before: beforeIntersection, after: afterIntersection,
    metrics: intersectionMetrics,
  };
  const status = sameCohort ? overallStatus([...repositories, ...metrics], probes) : 'not_comparable';
  return { status, sameCohort, metrics, repositories, probes, intersection };
}

export { METRIC_DIRECTIONS };
