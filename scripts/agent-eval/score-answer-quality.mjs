#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadScenarioMatrix, validateAnswerQualityResults } from './answer-scenarios.mjs';

export const SCORE_SCHEMA = 'solidkg.llm-answer-quality.scores.v1';
export const SCORING_WEIGHTS = Object.freeze({
  correctness: 0.45,
  evidenceCoverage: 0.25,
  forbiddenClaimAvoidance: 0.15,
  fallbackEfficiency: 0.10,
  answerEconomy: 0.05,
});
export const NON_QUALITY_STATUSES = new Set(['fail', 'unsupported', 'setup_failed', 'runner_failed', 'parse_failed', 'not_run']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(run) {
  return String(run.answer ?? run.finalAnswer?.text ?? '').trim();
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_./:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function includesNormalized(haystack, needle) {
  const normalizedNeedle = normalize(needle);
  return normalizedNeedle.length > 0 && normalize(haystack).includes(normalizedNeedle);
}

function basenameOf(filePath) {
  return String(filePath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function relevantForbiddenText(claim) {
  return String(claim ?? '').replace(/^\s*do\s+not\s+claim\s+/i, '').replace(/^\s*do\s+not\s+/i, '').trim();
}

function shellInputText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return [input.command, input.cmd, input.script, input.args, input.arguments]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function runMetrics(run) {
  const toolCalls = asArray(run.toolCalls);
  const readCount = Number(run.readCount ?? run.fallbackMetrics?.readCount ?? toolCalls.filter((call) => normalize(call.tool) === 'read').length ?? 0);
  const grepCount = Number(run.grepCount ?? run.fallbackMetrics?.grepCount ?? toolCalls.filter((call) => /(^|_)grep$|^rg$/.test(normalize(call.tool)) || (['bash', 'shell'].includes(normalize(call.tool)) && /\b(rg|grep)\b/.test(shellInputText(call.input)))).length ?? 0);
  const bashCount = Number(run.bashCount ?? run.fallbackMetrics?.bashCount ?? toolCalls.filter((call) => ['bash', 'shell'].includes(normalize(call.tool))).length ?? 0);
  const fallbackLoopCount = Number(run.fallbackLoopCount ?? run.fallbackMetrics?.fallbackLoopCount ?? 0);
  const solidkgToolCalls = Number(run.solidkgToolCalls ?? run.fallbackMetrics?.solidkgToolCalls ?? toolCalls.filter((call) => normalize(call.tool).includes('solidkg')).length ?? 0);
  const peerWrapperCalls = Number(run.peerWrapperCalls ?? run.fallbackMetrics?.peerWrapperCalls ?? toolCalls.filter((call) => /tilth|cartog|sverklo/.test(normalize(call.tool))).length ?? 0);
  return { readCount, grepCount, bashCount, fallbackLoopCount, solidkgToolCalls, peerWrapperCalls, toolCallCount: toolCalls.length };
}

const EVIDENCE_SUPPORT_STOPWORDS = new Set(['this', 'that', 'these', 'those', 'uses', 'use', 'used', 'using', 'but', 'gives', 'give', 'given', 'no', 'not', 'only', 'file', 'files', 'path', 'paths', 'source', 'sources', 'evidence', 'evidences', 'id', 'ids', 'anchor', 'anchors', 'claim', 'claims', 'and', 'or', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'without', 'from', 'by', 'as', 'at', 'it', 'is', 'are', 'be', 'do', 'does', 'did', 'answer', 'answers']);

function evidenceAnchorTokens(evidence) {
  return [evidence?.id, evidence?.file, basenameOf(evidence?.file)]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalize(value));
}

function hasEvidenceAnchor(answer, evidence) {
  const answerText = normalize(answer);
  return evidenceAnchorTokens(evidence).some((token) => token.length > 0 && answerText.includes(token));
}

function hasNonAnchorSupport(answer, evidence) {
  const anchorTokens = new Set(evidenceAnchorTokens(evidence));
  const symbolToken = normalize(evidence?.symbolHint ?? '');
  const supportAnchorTokens = new Set(anchorTokens);
  if (symbolToken.length > 0) supportAnchorTokens.add(symbolToken);
  const answerTokens = normalize(answer).split(' ').filter(Boolean);
  const anchorPositions = answerTokens
    .map((token, index) => supportAnchorTokens.has(token) ? index : -1)
    .filter((index) => index >= 0);
  const localTokens = anchorPositions.length > 0
    ? anchorPositions.flatMap((index) => answerTokens.slice(Math.max(0, index - 12), index + 13))
    : answerTokens;
  const claimTokens = normalize(evidence?.claim ?? '')
    .split(' ')
    .filter((token) => token.length >= 3)
    .filter((token) => !EVIDENCE_SUPPORT_STOPWORDS.has(token));
  if (claimTokens.length > 0) {
    const local = new Set(localTokens);
    const matchedClaimTokens = claimTokens.filter((token) => local.has(token));
    return matchedClaimTokens.length >= Math.min(3, claimTokens.length);
  }
  const supportTokens = localTokens
    .filter((token) => token.length >= 3)
    .filter((token) => !anchorTokens.has(token) && !EVIDENCE_SUPPORT_STOPWORDS.has(token));
  return supportTokens.length >= 5;
}

function evidenceMatches(answer, evidence) {
  return hasEvidenceAnchor(answer, evidence) && hasNonAnchorSupport(answer, evidence);
}

function scoreCorrectness(answer, rubric) {
  const checks = asArray(rubric.mustMention);
  if (checks.length === 0) return { points: answer.length > 0 ? 100 : 0, matched: [], missing: [] };
  const expectedEvidence = asArray(rubric.expectedEvidence);
  const matched = [];
  const inferred = [];
  const missing = [];
  let credit = 0;
  for (const claim of checks) {
    const sourceBackedMatch = expectedEvidence.some((evidence) => normalize(evidence?.symbolHint) === normalize(claim) && evidenceMatches(answer, evidence));
    if (includesNormalized(answer, claim)) {
      matched.push(claim);
      credit += 1;
    } else if (sourceBackedMatch) {
      inferred.push(claim);
      credit += 0.65;
    } else {
      missing.push(claim);
    }
  }
  return { points: Math.round((credit / checks.length) * 100), matched, inferred, missing };
}

function evidenceTokens(evidence) {
  return [evidence.id, evidence.file, basenameOf(evidence.file)].filter((value) => typeof value === 'string' && value.trim().length > 0);
}

function hasEvidenceIdMatch(answer, evidence) {
  return typeof evidence?.id === 'string' && includesNormalized(answer, evidence.id);
}

function hasEvidenceFileMatch(answer, evidence) {
  return [evidence?.file, basenameOf(evidence?.file)].some((token) => typeof token === 'string' && token.trim().length > 0 && includesNormalized(answer, token));
}

function hasEvidenceSymbolMatch(answer, evidence) {
  return typeof evidence?.symbolHint === 'string' && evidence.symbolHint.trim().length > 0 && includesNormalized(answer, evidence.symbolHint);
}

function hasExplicitEvidenceSupport(answer, evidence) {
  return hasEvidenceIdMatch(answer, evidence) && hasEvidenceFileMatch(answer, evidence) && hasEvidenceSymbolMatch(answer, evidence) && hasNonAnchorSupport(answer, evidence);
}

function evidenceMatchDetail(answer, evidence) {
  const idMatched = hasEvidenceIdMatch(answer, evidence);
  const fileMatched = hasEvidenceFileMatch(answer, evidence);
  const symbolMatched = hasEvidenceSymbolMatch(answer, evidence);
  const claimMatched = hasNonAnchorSupport(answer, evidence);
  const matchMode = idMatched && fileMatched && symbolMatched && claimMatched
    ? 'id_file_symbol_claim'
    : fileMatched && symbolMatched && claimMatched
      ? 'file_symbol_claim'
      : fileMatched && claimMatched
        ? 'file_claim'
        : evidenceMatches(answer, evidence)
          ? 'anchor_claim'
          : 'none';
  return { evidenceId: evidence.id ?? evidence.file ?? '', matchMode, fileMatched, symbolMatched, claimMatched, idMatched };
}

function scoreEvidence(answer, rubric) {
  const expected = asArray(rubric.expectedEvidence);
  if (expected.length === 0) return { points: 0, matchedEvidenceIds: [], missingEvidenceIds: [], matchDetails: [] };
  const matchedEvidenceIds = [];
  const missingEvidenceIds = [];
  const matchDetails = [];
  for (const evidence of expected) {
    const evidenceId = evidence.id ?? evidence.file ?? String(matchedEvidenceIds.length + 1);
    const detail = { ...evidenceMatchDetail(answer, evidence), evidenceId };
    if (detail.matchMode !== 'none' || hasExplicitEvidenceSupport(answer, evidence)) {
      matchedEvidenceIds.push(evidenceId);
      matchDetails.push(detail);
    } else {
      missingEvidenceIds.push(evidence.id ?? evidence.file ?? String(missingEvidenceIds.length + 1));
    }
  }
  const coverage = matchedEvidenceIds.length / expected.length;
  const minAnchors = Math.max(1, Number(rubric.minEvidenceAnchors ?? 1));
  const anchorFactor = Math.min(1, matchedEvidenceIds.length / minAnchors);
  return { points: Math.round(coverage * anchorFactor * 100), matchedEvidenceIds, missingEvidenceIds, matchDetails };
}

function scoreForbidden(answer, rubric) {
  const hits = [];
  for (const claim of asArray(rubric.forbiddenClaims)) {
    const relevant = relevantForbiddenText(claim);
    if (includesNormalized(answer, claim) || includesNormalized(answer, relevant)) hits.push(claim);
  }
  return { points: hits.length === 0 ? 100 : Math.max(0, 100 - hits.length * 75), forbiddenHits: hits };
}

function scoreFallback(metrics, run) {
  if (typeof run.fallbackMetrics?.efficiencyScore === 'number') {
    return { points: Math.max(0, Math.min(100, Math.round(run.fallbackMetrics.efficiencyScore))), metrics, notes: [] };
  }
  const localFallback = metrics.readCount + metrics.grepCount + metrics.bashCount;
  const solidkgOverDrill = Math.max(0, metrics.solidkgToolCalls - 12);
  const penalty = (metrics.fallbackLoopCount * 25) + Math.max(0, localFallback - 4) * 8 + solidkgOverDrill * 3;
  const notes = solidkgOverDrill > 0 ? ['excessive_solidkg_tool_calls'] : [];
  return { points: Math.max(0, Math.round(100 - penalty)), metrics, notes };
}

function scoreEconomy(answer) {
  const words = answer.split(/\s+/).filter(Boolean).length;
  if (words === 0) return { points: 0, wordCount: 0 };
  if (words < 20) return { points: 55, wordCount: words };
  if (words <= 350) return { points: 100, wordCount: words };
  if (words <= 700) return { points: 80, wordCount: words };
  return { points: 55, wordCount: words };
}

function weightedScore(components) {
  return Math.round(
    components.correctness.points * SCORING_WEIGHTS.correctness +
    components.evidenceCoverage.points * SCORING_WEIGHTS.evidenceCoverage +
    components.forbiddenClaimAvoidance.points * SCORING_WEIGHTS.forbiddenClaimAvoidance +
    components.fallbackEfficiency.points * SCORING_WEIGHTS.fallbackEfficiency +
    components.answerEconomy.points * SCORING_WEIGHTS.answerEconomy
  );
}

function scoreLanes(components, diagnosticCompositeScore) {
  const answerQualityScore = Math.round(components.correctness.points * 0.8 + components.answerEconomy.points * 0.2);
  const evidenceQualityScore = components.evidenceCoverage.points;
  const toolEconomyScore = components.fallbackEfficiency.points;
  return { answerQualityScore, evidenceQualityScore, toolEconomyScore, diagnosticCompositeScore };
}

export function scoreRun(run, scenarioOrRubric) {
  const status = run.status ?? run.reliabilityStatus ?? 'not_run';
  if (NON_QUALITY_STATUSES.has(status)) {
    return {
      schemaName: SCORE_SCHEMA,
      score: null,
      status,
      reliabilityStatus: status,
      qualityIncluded: false,
      components: null,
      notes: [`${status} is counted for reliability and excluded from quality averages.`],
      answerQualityScore: null,
      evidenceQualityScore: null,
      toolEconomyScore: null,
      diagnosticCompositeScore: null,
      lanes: { answerQualityScore: null, evidenceQualityScore: null, toolEconomyScore: null, diagnosticCompositeScore: null },
    };
  }
  const rubric = scenarioOrRubric?.rubric ?? scenarioOrRubric ?? {};
  const answer = textOf(run);
  const metrics = runMetrics(run);
  const components = {
    correctness: scoreCorrectness(answer, rubric),
    evidenceCoverage: scoreEvidence(answer, rubric),
    forbiddenClaimAvoidance: scoreForbidden(answer, rubric),
    fallbackEfficiency: scoreFallback(metrics, run),
    answerEconomy: scoreEconomy(answer),
  };
  const rawScore = weightedScore(components);
  const notes = components.fallbackEfficiency.notes ?? [];
  const forbiddenCap = components.forbiddenClaimAvoidance.forbiddenHits.length > 0 ? 60 : 100;
  const overDrillCap = notes.includes('excessive_solidkg_tool_calls') && metrics.solidkgToolCalls >= 30 ? 80 : 100;
  const score = Math.min(rawScore, forbiddenCap, overDrillCap);
  const lanes = scoreLanes(components, score);
  return { schemaName: SCORE_SCHEMA, score, ...lanes, lanes, status, reliabilityStatus: status, qualityIncluded: true, components, notes };
}

export function scoreResults(results, matrix = loadScenarioMatrix()) {
  const scenarioById = new Map(asArray(matrix.scenarios).map((scenario) => [scenario.id, scenario]));
  const scoredRuns = asArray(results.runs).map((run) => {
    const scoring = scoreRun(run, scenarioById.get(run.scenarioId));
    return { ...run, score: scoring.score, scoring };
  });
  return { ...results, runs: scoredRuns, reliability: summarizeReliability(scoredRuns), aggregateQuality: summarizeQuality(scoredRuns) };
}

export function summarizeReliability(runs) {
  const byArm = new Map();
  for (const run of asArray(runs)) {
    const arm = run.armId ?? 'unknown';
    if (!byArm.has(arm)) byArm.set(arm, { armId: arm, total: 0, pass: 0, fail: 0, unsupported: 0, setup_failed: 0, runner_failed: 0, parse_failed: 0, not_run: 0 });
    const row = byArm.get(arm);
    const status = run.status ?? run.reliabilityStatus ?? 'not_run';
    row.total += 1;
    row[status] = (row[status] ?? 0) + 1;
  }
  return [...byArm.values()].map((row) => ({ ...row, successRate: row.total > 0 ? Number(((row.pass ?? 0) / row.total).toFixed(3)) : 0 }));
}

export function summarizeQuality(runs) {
  const byArm = new Map();
  for (const run of asArray(runs)) {
    if (typeof run.score !== 'number') continue;
    const arm = run.armId ?? 'unknown';
    if (!byArm.has(arm)) byArm.set(arm, []);
    byArm.get(arm).push(run.score);
  }
  return [...byArm.entries()].map(([armId, scores]) => ({ armId, measuredRuns: scores.length, averageScore: scores.length > 0 ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null }));
}

function parseArgs(argv) {
  const args = { fromResults: '', fromScenarios: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-results') args.fromResults = argv[++i] ?? '';
    else if (argv[i] === '--from-scenarios') args.fromScenarios = argv[++i] ?? '';
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.fromResults) return { status: 1, stdout: '', stderr: 'usage: score-answer-quality.mjs --from-results <results.json> [--from-scenarios <scenarios.json>] [--out <scored.json>]\n' };
  const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
  const errors = validateAnswerQualityResults(results);
  if (errors.length > 0) return { status: 1, stdout: '', stderr: `${errors.join('\n')}\n` };
  const matrix = args.fromScenarios ? loadScenarioMatrix(args.fromScenarios) : loadScenarioMatrix();
  const scored = scoreResults(results, matrix);
  if (args.out) writeFileSync(args.out, `${JSON.stringify(scored, null, 2)}\n`);
  return { status: 0, stdout: `${JSON.stringify(scored, null, 2)}\n`, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runCli();
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

