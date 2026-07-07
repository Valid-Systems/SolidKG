#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARM_IDS, DEFAULT_FIXTURE, loadScenarioMatrix, REPORT_SCHEMA, validateAnswerQualityResults } from './answer-scenarios.mjs';
import { classifyRawEvidence } from './answer-evidence-contract.mjs';
import { evaluateBenchmarkPassport } from './benchmark-passport.mjs';
import { scoreResults } from './score-answer-quality.mjs';

export const REPORT_FILE_BASENAME = 'llm-answer-quality';
export const CAVEAT = 'Scores compare measured scenarios only and do not prove universal superiority.';
const CURRENT_BENCHMARK_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'opencode-answer-benchmark.mjs');

const ARM_DISPLAY_NAMES = {
  solidkg: 'SolidKG MCP',
  grep_read: 'Grep/Read Baseline',
  tilth: 'Tilth',
  cartog: 'Cartog',
  sverklo: 'Sverklo',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function median(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? Number(((nums[mid - 1] + nums[mid]) / 2).toFixed(2)) : nums[mid];
}

function range(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return nums.length === 0 ? { min: null, max: null } : { min: Math.min(...nums), max: Math.max(...nums) };
}

function avg(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return nums.length === 0 ? null : Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(2));
}

function scenarioMap(matrix) {
  return new Map(asArray(matrix.scenarios).map((scenario) => [scenario.id, scenario]));
}

function armName(results, armId) {
  return asArray(results.arms).find((arm) => arm.id === armId)?.name ?? ARM_DISPLAY_NAMES[armId] ?? armId;
}

function measuredArmIds(runs) {
  const ids = [];
  for (const run of runs) {
    if (ARM_IDS.includes(run.armId) && !ids.includes(run.armId)) ids.push(run.armId);
  }
  return ids;
}

function measuredObjective(results, runs) {
  const arms = measuredArmIds(runs);
  const names = arms.map((armId) => armName(results, armId));
  const scenarioIds = [...new Set(runs.map((run) => run.scenarioId).filter(Boolean))];
  const repeats = [...new Set(runs.map((run) => run.repeat ?? 1))].sort((a, b) => a - b);
  const armLabel = names.length === 0 ? 'no measured arms' : names.join(' against ');
  return {
    measuredArmIds: arms,
    excludedArmIds: ARM_IDS.filter((armId) => !arms.includes(armId)),
    scenarioCount: scenarioIds.length,
    repeatCount: repeats.length,
    claim: `Compare structural code-intelligence tool surfaces for ${armLabel} on measured OpenCode answer-quality runs.`,
  };
}

function reliabilityRows(runs) {
  return ARM_IDS.map((armId) => {
    const armRuns = runs.filter((run) => run.armId === armId);
    const counts = { pass: 0, fail: 0, unsupported: 0, setup_failed: 0, runner_failed: 0, parse_failed: 0, not_run: 0 };
    for (const run of armRuns) counts[run.status ?? run.reliabilityStatus ?? 'not_run'] = (counts[run.status ?? run.reliabilityStatus ?? 'not_run'] ?? 0) + 1;
    const total = armRuns.length;
    return { armId, total, counts, successRate: total > 0 ? Number((counts.pass / total).toFixed(3)) : 0, failureRate: total > 0 ? Number(((total - counts.pass) / total).toFixed(3)) : 0 };
  });
}

function aggregateRows(results, runs) {
  return ARM_IDS.map((armId) => {
    const armRuns = runs.filter((run) => run.armId === armId);
    const qualityScores = armRuns.map((run) => run.score).filter((score) => typeof score === 'number');
    const answerQualityScores = armRuns.map((run) => run.scoring?.answerQualityScore).filter((score) => typeof score === 'number');
    const evidenceQualityScores = armRuns.map((run) => run.scoring?.evidenceQualityScore).filter((score) => typeof score === 'number');
    const toolEconomyScores = armRuns.map((run) => run.scoring?.toolEconomyScore).filter((score) => typeof score === 'number');
    const judgeScores = armRuns.map((run) => run.judge?.secondaryScore).filter((score) => typeof score === 'number');
    const readCounts = armRuns.map((run) => run.readCount ?? run.fallbackMetrics?.readCount ?? 0);
    const grepCounts = armRuns.map((run) => run.grepCount ?? run.fallbackMetrics?.grepCount ?? 0);
    const toolCallCounts = armRuns.map((run) => run.toolCallCount ?? run.toolCalls?.length ?? 0);
    const solidkgToolCalls = armRuns.map((run) => run.solidkgToolCalls ?? run.fallbackMetrics?.solidkgToolCalls ?? 0);
    const peerWrapperCalls = armRuns.map((run) => run.peerWrapperCalls ?? run.fallbackMetrics?.peerWrapperCalls ?? 0);
    const fallbackLoops = armRuns.map((run) => run.fallbackLoopCount ?? run.fallbackMetrics?.fallbackLoopCount ?? 0);
    const setupDurations = armRuns.map((run) => run.setupDurationMs ?? 0);
    const queryDurations = armRuns.map((run) => run.queryDurationMs ?? 0);
    const rawPayloadBytes = armRuns.map((run) => run.rawToolResultPayloadBytes ?? run.fallbackMetrics?.rawToolResultPayloadBytes ?? 0);
    const truncatedPayloads = armRuns.map((run) => run.truncatedToolResultCount ?? run.fallbackMetrics?.truncatedToolResultCount ?? 0);
    return {
      armId,
      armName: armName(results, armId),
      measuredRuns: qualityScores.length,
      averageScore: avg(qualityScores),
      medianScore: median(qualityScores),
      medianAnswerQualityScore: median(answerQualityScores),
      medianEvidenceQualityScore: median(evidenceQualityScores),
      medianToolEconomyScore: median(toolEconomyScores),
      scoreRange: range(qualityScores),
      judgeMedianSecondaryScore: median(judgeScores),
      medianToolCallCount: median(toolCallCounts),
      medianSolidKGMcpCalls: median(solidkgToolCalls),
      medianPeerWrapperCalls: median(peerWrapperCalls),
      medianReadCount: median(readCounts),
      medianGrepCount: median(grepCounts),
      medianFallbackLoopCount: median(fallbackLoops),
      medianSetupDurationMs: median(setupDurations),
      medianQueryDurationMs: median(queryDurations),
      medianRawToolResultPayloadBytes: median(rawPayloadBytes),
      totalRawToolResultPayloadBytes: Number(rawPayloadBytes.reduce((sum, value) => sum + Number(value ?? 0), 0).toFixed(2)),
      totalTruncatedToolResultCount: truncatedPayloads.reduce((sum, value) => sum + Number(value ?? 0), 0),
      totalCostUsd: Number(armRuns.reduce((sum, run) => sum + Number(run.costUsd ?? 0), 0).toFixed(4)),
    };
  });
}

function pairedBlocks(runs) {
  const blocks = new Map();
  for (const run of runs) {
    const key = `${run.scenarioId}:r${run.repeat ?? 1}`;
    if (!blocks.has(key)) blocks.set(key, { blockId: run.blockId ?? key, scenarioId: run.scenarioId, repeat: run.repeat ?? 1, scoresByArm: {}, deltasVsGrepRead: {} });
    blocks.get(key).scoresByArm[run.armId] = typeof run.score === 'number' ? run.score : null;
  }
  for (const block of blocks.values()) {
    const base = block.scoresByArm.grep_read;
    for (const armId of ARM_IDS) block.deltasVsGrepRead[armId] = typeof block.scoresByArm[armId] === 'number' && typeof base === 'number' ? block.scoresByArm[armId] - base : null;
  }
  return [...blocks.values()];
}

function componentBreakdown(run) {
  const components = run.scoring?.components;
  if (!components) return null;
  return {
    correctness: components.correctness?.points ?? null,
    evidenceCoverage: components.evidenceCoverage?.points ?? null,
    forbiddenClaimAvoidance: components.forbiddenClaimAvoidance?.points ?? null,
    fallbackEfficiency: components.fallbackEfficiency?.points ?? null,
    answerEconomy: components.answerEconomy?.points ?? null,
  };
}

function toolNames(run) {
  return asArray(run.toolCalls).map((call) => call?.tool).filter((tool) => typeof tool === 'string' && tool.length > 0);
}

function normalizeTool(tool) {
  return String(tool ?? '').toLowerCase();
}

function toolCallSequenceSummary(run) {
  const tools = toolNames(run).map(normalizeTool);
  const solidkgNodeCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('node')).length;
  const solidkgContextCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('context')).length;
  const solidkgExploreCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('explore')).length;
  const peerWrapperCalls = tools.filter((tool) => /tilth|cartog|sverklo/.test(tool)).length;
  const classifications = [];
  if (solidkgNodeCalls >= 8) classifications.push('repeated_solidkg_node_calls');
  if (solidkgContextCalls > 1 && solidkgExploreCalls > 1) classifications.push('repeated_context_explore_calls');
  if (peerWrapperCalls > 1) classifications.push('repeated_peer_wrapper_calls');
  return { totalCalls: tools.length, firstTools: tools.slice(0, 8), solidkgNodeCalls, solidkgContextCalls, solidkgExploreCalls, peerWrapperCalls, classifications };
}

function answerExcerpt(run) {
  const text = String(run.answer ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function readiness(results, reliability) {
  const calibrationStatus = results.profile === 'calibration' && reliability.some((row) => row.armId === 'solidkg' && row.successRate > 0)
    ? 'successful'
    : (['smoke', 'full'].includes(results.profile) && results.confirmLive ? 'successful' : (results.calibrationStatus ?? 'not_successful'));
  const smokeStatus = results.profile === 'smoke' && reliability.every((row) => row.total === 0 || row.successRate > 0) ? 'successful' : (results.smokeStatus ?? 'not_successful');
  const readyForLiveFullRun = calibrationStatus === 'successful' && smokeStatus === 'successful';
  return {
    calibrationStatus,
    smokeStatus,
    readyForLiveFullRun,
    claim: readyForLiveFullRun ? 'Calibration and smoke evidence are successful; live full run guard may be satisfied.' : 'Live full benchmark is blocked: calibration and smoke statuses are not both successful.',
  };
}

function benchmarkCoverage(runs, plannedRunOrder = []) {
  const measured = measuredArmIds(runs);
  const plannedRunCount = asArray(plannedRunOrder).length;
  const resultRowCount = runs.length;
  const missingPlannedRunCount = Math.max(0, plannedRunCount - resultRowCount);
  const rawEvidenceRows = [];
  const byArm = measured.map((armId) => {
    const armRuns = runs.filter((run) => run.armId === armId);
    const scoreable = armRuns.filter((run) => typeof run.score === 'number');
    for (const run of scoreable) {
      const classification = classifyRawEvidence({ run });
      rawEvidenceRows.push({
        runId: run.id ?? `${run.blockId ?? run.scenarioId}:${armId}`,
        armId,
        scenarioId: run.scenarioId,
        repeat: run.repeat ?? 1,
        status: classification.status,
        causeCode: classification.causeCode,
        sourceAttempted: classification.sourceAttempted,
        errors: classification.errors,
      });
    }
    return {
      armId,
      totalRuns: armRuns.length,
      scoreableRuns: scoreable.length,
      statuses: armRuns.map((run) => run.status ?? run.reliabilityStatus ?? 'not_run'),
    };
  });
  const zeroScoreableArms = byArm.filter((row) => row.scoreableRuns === 0).map((row) => row.armId);
  const singleScoreableArms = byArm.filter((row) => row.scoreableRuns === 1).map((row) => row.armId);
  const missingRunArms = measured.length === 0 ? ARM_IDS : [];
  const excludedArmIds = ARM_IDS.filter((armId) => !measured.includes(armId));
  const rawEvidenceReady = rawEvidenceRows.length > 0 && rawEvidenceRows.every((row) => row.status === 'available');
  const rawEvidenceUnavailable = rawEvidenceRows.some((row) => row.status !== 'available');
  const stopConditions = [
    ...(rawEvidenceUnavailable ? ['raw_tool_outputs_unavailable'] : []),
  ];
  const structuralDecisionReady = zeroScoreableArms.length === 0 && missingRunArms.length === 0 && singleScoreableArms.length === 0 && missingPlannedRunCount === 0;
  const decisionReady = structuralDecisionReady && rawEvidenceReady;
  const warnings = [
    ...(missingPlannedRunCount > 0 ? [`${missingPlannedRunCount} planned runs have no result row`] : []),
    ...missingRunArms.map((armId) => `${armId} has 0 planned/result rows`),
    ...zeroScoreableArms.map((armId) => `${armId} has 0 scoreable measurements`),
    ...singleScoreableArms.map((armId) => `${armId} has only 1 scoreable measurement`),
    ...(rawEvidenceUnavailable ? ['scoreable runs are missing validated raw tool-output sidecars'] : []),
  ];
  return { decisionReady, structuralDecisionReady, rawEvidenceReady, rawEvidenceRows, stopConditions, measuredArmIds: measured, excludedArmIds, plannedRunCount, resultRowCount, missingPlannedRunCount, byArm, zeroScoreableArms, singleScoreableArms, missingRunArms, warnings };
}

export function buildAnswerQualityReport(results, matrix = loadScenarioMatrix(), { currentBenchmarkScriptPath = null, currentScenarioFile = null, expectedSolidKGBin = null } = {}) {
  const validationErrors = validateAnswerQualityResults(results);
  if (validationErrors.length > 0) throw new Error(validationErrors.join('\n'));
  const scored = scoreResults(results, matrix);
  const runs = scored.runs;
  const reliability = reliabilityRows(runs);
  const scenarioById = scenarioMap(matrix);
  const perRunRows = runs.map((run, index) => ({
    order: index + 1,
    plannedOrderId: scored.plannedRunOrder?.[index] ?? run.id ?? `${run.blockId}:${run.armId}`,
    blockId: run.blockId,
    scenarioId: run.scenarioId,
    scenarioTitle: scenarioById.get(run.scenarioId)?.question ?? run.scenarioId,
    repeat: run.repeat ?? 1,
    armId: run.armId,
    status: run.status,
    score: run.score,
    diagnosticCompositeScore: run.scoring?.diagnosticCompositeScore ?? run.score ?? null,
    answerQualityScore: run.scoring?.answerQualityScore ?? null,
    evidenceQualityScore: run.scoring?.evidenceQualityScore ?? null,
    toolEconomyScore: run.scoring?.toolEconomyScore ?? null,
    judgeSecondaryScore: run.judge?.secondaryScore ?? null,
    scoringComponents: componentBreakdown(run),
    scoringNotes: asArray(run.scoring?.notes),
    reason: run.reason ?? '',
    answerExcerpt: answerExcerpt(run),
    toolNames: toolNames(run),
    toolCallSequenceSummary: toolCallSequenceSummary(run),
    setupDurationMs: run.setupDurationMs ?? 0,
    queryDurationMs: run.queryDurationMs ?? 0,
    toolCallCount: run.toolCallCount ?? run.toolCalls?.length ?? 0,
    solidkgToolCalls: run.solidkgToolCalls ?? run.fallbackMetrics?.solidkgToolCalls ?? 0,
    peerWrapperCalls: run.peerWrapperCalls ?? run.fallbackMetrics?.peerWrapperCalls ?? 0,
    readCount: run.readCount ?? run.fallbackMetrics?.readCount ?? 0,
    grepCount: run.grepCount ?? run.fallbackMetrics?.grepCount ?? 0,
    fallbackLoopCount: run.fallbackLoopCount ?? run.fallbackMetrics?.fallbackLoopCount ?? 0,
    rawToolResultPayloadBytes: run.rawToolResultPayloadBytes ?? run.fallbackMetrics?.rawToolResultPayloadBytes ?? 0,
    truncatedToolResultCount: run.truncatedToolResultCount ?? run.fallbackMetrics?.truncatedToolResultCount ?? 0,
    costUsd: run.costUsd ?? 0,
  }));
  return {
    schemaName: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    runConfig: {
      profile: scored.profile,
      seed: scored.seed,
      model: scored.model ?? '',
      variant: scored.variant ?? '',
      maxRuns: scored.maxRuns,
      maxEstimatedCostUsd: scored.maxEstimatedCostUsd,
      estimatedCostUsd: scored.estimatedCostUsd,
      confirmLive: scored.confirmLive,
      transcriptCapability: scored.transcriptCapability,
      solidkgBin: scored.solidkgBin ?? scored.benchmarkPassport?.solidkg?.configuredBin ?? '',
      plannedRunOrder: scored.plannedRunOrder,
    },
    caveats: [CAVEAT, 'Reliability failures are counted separately from deterministic quality averages.'],
    readiness: readiness(scored, reliability),
    benchmarkPassport: scored.benchmarkPassport ?? null,
    passportReadiness: evaluateBenchmarkPassport({ results: scored, currentBenchmarkScriptPath, currentScenarioFile, expectedSolidKGBin }),
    measuredObjective: measuredObjective(scored, runs),
    benchmarkCoverage: benchmarkCoverage(runs, scored.plannedRunOrder),
    aggregateByArm: aggregateRows(scored, runs),
    reliabilityByArm: reliability,
    pairedBlocks: pairedBlocks(runs),
    perRunRows,
    scoredResults: scored,
  };
}

function renderBars(rows) {
  const width = 640;
  const barHeight = 22;
  const height = Math.max(120, rows.length * 36 + 40);
  const bars = rows.map((row, index) => {
    const hasMeasurement = row.measuredRuns > 0;
    const value = hasMeasurement ? Number(row.medianScore ?? row.averageScore ?? 0) : 0;
    const label = hasMeasurement ? String(value) : 'n/a';
    const barWidth = Math.round((value / 100) * 480);
    const y = 30 + index * 36;
    return `<text x="10" y="${y + 15}" font-size="12">${escapeHtml(row.armId)}</text><rect x="120" y="${y}" width="${barWidth}" height="${barHeight}" fill="#3b82f6"></rect><text x="${130 + barWidth}" y="${y + 15}" font-size="12" data-arm-score="${escapeHtml(row.armId)}">${escapeHtml(label)}</text>`;
  }).join('');
  return `<svg width="${width}" height="${height}" role="img" aria-label="Median deterministic score by arm">${bars}</svg>`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# LLM Answer Quality Benchmark Report', '');
  lines.push(`Schema: ${report.schemaName}`);
  lines.push(`Profile: ${report.runConfig.profile}`);
  lines.push(`Seed: ${report.runConfig.seed}`);
  if (report.runConfig.model) lines.push(`Model: ${report.runConfig.model}`);
  if (report.runConfig.variant) lines.push(`Variant: ${report.runConfig.variant}`);
  lines.push(`Caveat: ${CAVEAT}`, '');
  lines.push('## Objective', '');
  lines.push(`Measured objective: ${report.measuredObjective.claim}`);
  lines.push(`Measured arms: ${report.measuredObjective.measuredArmIds.join(', ') || 'none'}`);
  lines.push(`Excluded arms: ${report.measuredObjective.excludedArmIds.join(', ') || 'none'}`);
  lines.push(`Scenario count: ${report.measuredObjective.scenarioCount}`);
  lines.push(`Repeat count: ${report.measuredObjective.repeatCount}`, '');
  lines.push('## Methodology', '');
  lines.push('The report scores final OpenCode answers against deterministic scenario rubrics, then reports secondary blinded judge scores when present. Setup time and query time are reported separately. Reliability failures remain visible and are excluded from quality averages.', '');
  lines.push(`Readiness: ${report.readiness.claim}`, '');
  lines.push('## Benchmark Passport', '');
  lines.push(`Passport status: ${report.passportReadiness.claimGrade ? 'Claim-grade' : 'Diagnostic only'}`);
  lines.push(`Proof tier: ${report.passportReadiness.proofTier}`);
  lines.push(`Required repeat count: ${report.passportReadiness.requiredRepeatCount}`);
  if (report.passportReadiness.benchmarkImplementation) {
    lines.push(`Implementation hashes covered: ${report.passportReadiness.benchmarkImplementation.coveredFiles.join(', ') || 'none'}`);
    if (report.passportReadiness.benchmarkImplementation.missingFiles.length > 0) lines.push(`Implementation hashes missing: ${report.passportReadiness.benchmarkImplementation.missingFiles.join(', ')}`);
    if (report.passportReadiness.benchmarkImplementation.mismatchedFiles.length > 0) lines.push(`Implementation hash mismatches: ${report.passportReadiness.benchmarkImplementation.mismatchedFiles.map((file) => file.relativePath).join(', ')}`);
  }
  if (report.passportReadiness.stopConditions.length > 0) lines.push(`Passport stop conditions: ${report.passportReadiness.stopConditions.join(', ')}`);
  if (report.passportReadiness.warnings.length > 0) {
    lines.push('', 'Passport warnings:');
    for (const warning of report.passportReadiness.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('## Benchmark Coverage', '');
  lines.push(`Coverage status: ${report.benchmarkCoverage.decisionReady ? 'Decision-ready' : 'Not decision-ready'}`);
  lines.push(report.benchmarkCoverage.decisionReady ? 'Every arm has more than one scoreable measurement.' : 'This report is incomplete benchmark evidence. Do not use it to compare tool quality.');
  if (report.benchmarkCoverage.stopConditions.length > 0) lines.push(`Stop conditions: ${report.benchmarkCoverage.stopConditions.join(', ')}`);
  lines.push('', '| Arm | Result rows | Scoreable measurements | Statuses |');
  lines.push('|---|---:|---:|---|');
  for (const row of report.benchmarkCoverage.byArm) lines.push(`| ${row.armId} | ${row.totalRuns} | ${row.scoreableRuns} | ${row.statuses.join(', ') || 'none'} |`);
  if (report.benchmarkCoverage.warnings.length > 0) {
    lines.push('', 'Coverage warnings:');
    for (const warning of report.benchmarkCoverage.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('## Aggregate Arm Table', '');
  lines.push('| Arm | Measured runs | Diagnostic composite | Answer quality | Evidence quality | Tool economy | Score range | Judge median | Median tools | Median SolidKG MCP | Median peer wrappers | Median read | Median grep | Median fallback loops | Median setup ms | Median query ms | Median raw payload bytes | Truncated payloads |');
  lines.push('|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.aggregateByArm) lines.push(`| ${row.armId} | ${row.measuredRuns} | ${row.medianScore ?? 'n/a'} | ${row.medianAnswerQualityScore ?? 'n/a'} | ${row.medianEvidenceQualityScore ?? 'n/a'} | ${row.medianToolEconomyScore ?? 'n/a'} | ${row.scoreRange.min ?? 'n/a'}-${row.scoreRange.max ?? 'n/a'} | ${row.judgeMedianSecondaryScore ?? 'n/a'} | ${row.medianToolCallCount ?? 0} | ${row.medianSolidKGMcpCalls ?? 0} | ${row.medianPeerWrapperCalls ?? 0} | ${row.medianReadCount ?? 0} | ${row.medianGrepCount ?? 0} | ${row.medianFallbackLoopCount ?? 0} | ${row.medianSetupDurationMs ?? 0} | ${row.medianQueryDurationMs ?? 0} | ${row.medianRawToolResultPayloadBytes ?? 0} | ${row.totalTruncatedToolResultCount ?? 0} |`);
  lines.push('', '## Reliability Status Rates', '');
  lines.push('| Arm | Total | Pass | Fail | Unsupported | Setup failed | Runner failed | Parse failed | Not run | Success rate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.reliabilityByArm) lines.push(`| ${row.armId} | ${row.total} | ${row.counts.pass} | ${row.counts.fail} | ${row.counts.unsupported} | ${row.counts.setup_failed} | ${row.counts.runner_failed} | ${row.counts.parse_failed} | ${row.counts.not_run} | ${pct(row.successRate)} |`);
  lines.push('', '## Paired Scenario + Repeat Deltas', '');
  lines.push('| Block ID | Scenario | Repeat | solidkg | grep_read | tilth | cartog | sverklo | Deltas vs grep_read |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const block of report.pairedBlocks) lines.push(`| ${block.blockId} | ${block.scenarioId} | ${block.repeat} | ${block.scoresByArm.solidkg ?? 'n/a'} | ${block.scoresByArm.grep_read ?? 'n/a'} | ${block.scoresByArm.tilth ?? 'n/a'} | ${block.scoresByArm.cartog ?? 'n/a'} | ${block.scoresByArm.sverklo ?? 'n/a'} | ${JSON.stringify(block.deltasVsGrepRead)} |`);
  lines.push('', '## Per Run Rows', '');
  lines.push('| Order | Planned ID | Block | Scenario | Repeat | Arm | Status | Diagnostic composite | Answer quality | Evidence quality | Tool economy | Correctness | Evidence | Forbidden | Fallback efficiency | Economy | Notes | Sequence classes | Judge secondary | Setup ms | Query ms | Tools | SolidKG MCP | Peer wrappers | Read | Grep | Fallback loops | Raw payload bytes | Truncated payloads |');
  lines.push('|---:|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.perRunRows) lines.push(`| ${row.order} | ${row.plannedOrderId} | ${row.blockId} | ${row.scenarioId} | ${row.repeat} | ${row.armId} | ${row.status} | ${row.diagnosticCompositeScore ?? 'n/a'} | ${row.answerQualityScore ?? 'n/a'} | ${row.evidenceQualityScore ?? 'n/a'} | ${row.toolEconomyScore ?? 'n/a'} | ${row.scoringComponents?.correctness ?? 'n/a'} | ${row.scoringComponents?.evidenceCoverage ?? 'n/a'} | ${row.scoringComponents?.forbiddenClaimAvoidance ?? 'n/a'} | ${row.scoringComponents?.fallbackEfficiency ?? 'n/a'} | ${row.scoringComponents?.answerEconomy ?? 'n/a'} | ${row.scoringNotes.join(', ') || 'none'} | ${row.toolCallSequenceSummary.classifications.join(', ') || 'none'} | ${row.judgeSecondaryScore ?? 'n/a'} | ${row.setupDurationMs} | ${row.queryDurationMs} | ${row.toolCallCount} | ${row.solidkgToolCalls} | ${row.peerWrapperCalls} | ${row.readCount} | ${row.grepCount} | ${row.fallbackLoopCount} | ${row.rawToolResultPayloadBytes} | ${row.truncatedToolResultCount} |`);
  return `${lines.join('\n')}\n`;
}

export function renderHtml(report) {
  const passportStopConditions = report.passportReadiness.stopConditions.map((condition) => `<li><code>${escapeHtml(condition)}</code></li>`).join('');
  const passportWarnings = report.passportReadiness.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const passportClass = report.passportReadiness.claimGrade ? 'good' : 'bad';
  const implementationCovered = report.passportReadiness.benchmarkImplementation?.coveredFiles?.join(', ') || 'none';
  const implementationMissing = report.passportReadiness.benchmarkImplementation?.missingFiles?.join(', ') || '';
  const implementationMismatched = report.passportReadiness.benchmarkImplementation?.mismatchedFiles?.map((file) => file.relativePath).join(', ') || '';
  const implementationHashDetails = `<br><strong>Implementation hashes covered:</strong> ${escapeHtml(implementationCovered)}${implementationMissing ? `<br><strong>Implementation hashes missing:</strong> ${escapeHtml(implementationMissing)}` : ''}${implementationMismatched ? `<br><strong>Implementation hash mismatches:</strong> ${escapeHtml(implementationMismatched)}` : ''}`;
  const aggregateRows = report.aggregateByArm.map((row) => `<tr data-arm-id="${escapeHtml(row.armId)}"><td>${escapeHtml(row.armId)}</td><td>${row.measuredRuns}</td><td>${row.averageScore ?? 'n/a'}</td><td>${row.medianScore ?? 'n/a'}</td><td>${row.medianAnswerQualityScore ?? 'n/a'}</td><td>${row.medianEvidenceQualityScore ?? 'n/a'}</td><td>${row.medianToolEconomyScore ?? 'n/a'}</td><td>${row.scoreRange.min ?? 'n/a'}-${row.scoreRange.max ?? 'n/a'}</td><td>${row.judgeMedianSecondaryScore ?? 'n/a'}</td><td>${row.medianToolCallCount ?? 0}</td><td>${row.medianSolidKGMcpCalls ?? 0}</td><td>${row.medianPeerWrapperCalls ?? 0}</td><td>${row.medianReadCount ?? 0}</td><td>${row.medianGrepCount ?? 0}</td><td>${row.medianFallbackLoopCount ?? 0}</td><td>${row.medianSetupDurationMs ?? 0}</td><td>${row.medianQueryDurationMs ?? 0}</td><td>${row.medianRawToolResultPayloadBytes ?? 0}</td><td>${row.totalTruncatedToolResultCount ?? 0}</td></tr>`).join('');
  const reliabilityRows = report.reliabilityByArm.map((row) => `<tr><td>${escapeHtml(row.armId)}</td><td>${row.total}</td><td>${row.counts.pass}</td><td>${row.counts.fail}</td><td>${row.counts.unsupported}</td><td>${row.counts.setup_failed}</td><td>${row.counts.runner_failed}</td><td>${row.counts.parse_failed}</td><td>${row.counts.not_run}</td><td>${pct(row.successRate)}</td><td>${pct(row.failureRate)}</td></tr>`).join('');
  const pairedRows = report.pairedBlocks.map((block) => `<tr><td>${escapeHtml(block.blockId)}</td><td>${escapeHtml(block.scenarioId)}</td><td>${block.repeat}</td><td>${block.scoresByArm.solidkg ?? 'n/a'}</td><td>${block.scoresByArm.grep_read ?? 'n/a'}</td><td>${block.scoresByArm.tilth ?? 'n/a'}</td><td>${block.scoresByArm.cartog ?? 'n/a'}</td><td>${block.scoresByArm.sverklo ?? 'n/a'}</td><td>${escapeHtml(JSON.stringify(block.deltasVsGrepRead))}</td></tr>`).join('');
  const coverageRows = report.benchmarkCoverage.byArm.map((row) => `<tr><td>${escapeHtml(row.armId)}</td><td>${row.totalRuns}</td><td>${row.scoreableRuns}</td><td>${escapeHtml(row.statuses.join(', ') || 'none')}</td></tr>`).join('');
  const coverageWarnings = report.benchmarkCoverage.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const runRows = report.perRunRows.map((row) => `<tr><td>${row.order}</td><td>${escapeHtml(row.plannedOrderId)}</td><td>${escapeHtml(row.blockId)}</td><td>${escapeHtml(row.scenarioId)}</td><td>${row.repeat}</td><td>${escapeHtml(row.armId)}</td><td>${escapeHtml(row.status)}</td><td>${row.diagnosticCompositeScore ?? 'n/a'}</td><td>${row.answerQualityScore ?? 'n/a'}</td><td>${row.evidenceQualityScore ?? 'n/a'}</td><td>${row.toolEconomyScore ?? 'n/a'}</td><td>${row.scoringComponents?.correctness ?? 'n/a'}</td><td>${row.scoringComponents?.evidenceCoverage ?? 'n/a'}</td><td>${row.scoringComponents?.forbiddenClaimAvoidance ?? 'n/a'}</td><td>${row.scoringComponents?.fallbackEfficiency ?? 'n/a'}</td><td>${row.scoringComponents?.answerEconomy ?? 'n/a'}</td><td>${escapeHtml(row.scoringNotes.join(', ') || 'none')}</td><td>${escapeHtml(row.toolCallSequenceSummary.classifications.join(', ') || 'none')}</td><td>${row.judgeSecondaryScore ?? 'n/a'}</td><td>${row.setupDurationMs}</td><td>${row.queryDurationMs}</td><td>${row.toolCallCount}</td><td>${row.solidkgToolCalls}</td><td>${row.peerWrapperCalls}</td><td>${row.readCount}</td><td>${row.grepCount}</td><td>${row.fallbackLoopCount}</td><td>${row.rawToolResultPayloadBytes}</td><td>${row.truncatedToolResultCount}</td><td>${escapeHtml(row.reason ? `Reason: ${row.reason}` : '')}</td><td>${escapeHtml(row.toolNames.length > 0 ? row.toolNames.join(', ') : 'none')}</td><td>${escapeHtml(row.answerExcerpt || 'n/a')}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>LLM Answer Quality Benchmark Report</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111827;line-height:1.45}.lede{max-width:72rem}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem;margin:1rem 0}.card{border:1px solid #d1d5db;border-radius:.75rem;padding:1rem;background:#f9fafb}.card strong{display:block;font-size:.8rem;text-transform:uppercase;color:#4b5563}.card span{font-size:1.25rem;font-weight:700}table{border-collapse:collapse;margin:1rem 0;width:100%;font-size:.9rem}th,td{border:1px solid #ddd;padding:.35rem;text-align:left;vertical-align:top}th{background:#f5f5f5}.note{background:#fff7ed;border:1px solid #fed7aa;border-radius:.75rem;padding:1rem}.bad{background:#fef2f2;border-color:#fecaca}.good{background:#ecfdf5;border-color:#bbf7d0}.scroll{overflow-x:auto}code{background:#f3f4f6;padding:.1rem .25rem;border-radius:.25rem}</style></head><body><h1>LLM Answer Quality Benchmark Report</h1><p class="lede"><strong>Caveat:</strong> ${escapeHtml(CAVEAT)} Reliability counts are not quality scores; failed or unsupported runs stay visible but are excluded from quality averages.</p><section><h2>Objective</h2><p><strong>Measured objective:</strong> ${escapeHtml(report.measuredObjective.claim)}</p><p><strong>Measured arms:</strong> ${escapeHtml(report.measuredObjective.measuredArmIds.join(', ') || 'none')}<br><strong>Excluded arms:</strong> ${escapeHtml(report.measuredObjective.excludedArmIds.join(', ') || 'none')}<br><strong>Scenario count:</strong> ${report.measuredObjective.scenarioCount}<br><strong>Repeat count:</strong> ${report.measuredObjective.repeatCount}</p></section><section><h2>Methodology</h2><p>The report scores final OpenCode answers against deterministic scenario rubrics, then reports secondary blinded judge scores when present. Setup time and query time are reported separately. Reliability failures remain visible and are excluded from quality averages.</p></section><section><h2>Run Configuration</h2><div class="cards"><div class="card"><strong>Generated at</strong><span>${escapeHtml(report.generatedAt)}</span></div><div class="card"><strong>Profile</strong><span>${escapeHtml(report.runConfig.profile)}</span></div><div class="card"><strong>Seed</strong><span>${escapeHtml(report.runConfig.seed)}</span></div><div class="card"><strong>Model</strong><span>${escapeHtml(report.runConfig.model || 'n/a')}</span></div><div class="card"><strong>Variant</strong><span>${escapeHtml(report.runConfig.variant || 'default')}</span></div><div class="card"><strong>Planned runs</strong><span>${report.runConfig.plannedRunOrder.length}</span></div><div class="card"><strong>Max runs</strong><span>${report.runConfig.maxRuns}</span></div><div class="card"><strong>Estimated cost</strong><span>$${report.runConfig.estimatedCostUsd}</span></div><div class="card"><strong>Live confirmed</strong><span>${report.runConfig.confirmLive}</span></div><div class="card"><strong>Transcript capability</strong><span>${escapeHtml(report.runConfig.transcriptCapability?.status ?? 'unknown')}</span></div></div><p class="note">${escapeHtml(report.readiness.claim)}</p></section><section><h2>Benchmark Passport</h2><div class="note ${passportClass}"><p><strong>Status:</strong> ${report.passportReadiness.claimGrade ? 'Claim-grade' : 'Diagnostic only'}<br><strong>Proof tier:</strong> ${escapeHtml(report.passportReadiness.proofTier)}<br><strong>Required repeats:</strong> ${report.passportReadiness.requiredRepeatCount}${implementationHashDetails}</p>${passportStopConditions ? `<p><strong>Stop conditions:</strong></p><ul>${passportStopConditions}</ul>` : ''}${passportWarnings ? `<p><strong>Warnings:</strong></p><ul>${passportWarnings}</ul>` : ''}</div></section><section><h2>Benchmark Coverage</h2><p class="note ${report.benchmarkCoverage.decisionReady ? 'good' : 'bad'}"><strong>${report.benchmarkCoverage.decisionReady ? 'Decision-ready for measured objective' : 'Not decision-ready'}:</strong> ${report.benchmarkCoverage.decisionReady ? 'Every measured arm has more than one scoreable measurement.' : 'This report is incomplete benchmark evidence. Do not use it to compare tool quality.'}</p><ul>${coverageWarnings}</ul><div class="scroll"><table><thead><tr><th>Arm</th><th>Result rows</th><th>Scoreable measurements</th><th>Statuses</th></tr></thead><tbody>${coverageRows}</tbody></table></div></section><section><h2>Professional Shareability</h2><p>This report is shareable only for the measured objective above. It does not claim results for excluded arms, unmeasured repositories, other models, or other prompts.</p></section><section><h2>Status Guide</h2><p>pass: Scoreable answer produced. unsupported: Arm cannot answer through the configured benchmark surface. setup_failed: Required setup or preflight failed. runner_failed: OpenCode, judge, or transcript format failed. parse_failed: Transcript was known but incomplete or malformed.</p></section><section><h2>Graphics</h2>${renderBars(report.aggregateByArm)}</section><section><h2>Aggregate Arm Table</h2><div class="scroll"><table><thead><tr><th>Arm</th><th>Measured</th><th>Average</th><th>Diagnostic composite</th><th>Answer quality</th><th>Evidence quality</th><th>Tool economy</th><th>Range</th><th>Judge median</th><th>Tools</th><th>SolidKG MCP</th><th>Peer wrappers</th><th>Read</th><th>Grep</th><th>Fallback loops</th><th>Setup ms</th><th>Query ms</th><th>Raw payload bytes</th><th>Truncated payloads</th></tr></thead><tbody>${aggregateRows}</tbody></table></div></section><section><h2>Reliability Status Rates</h2><div class="scroll"><table><thead><tr><th>Arm</th><th>Total</th><th>Pass</th><th>Fail</th><th>Unsupported</th><th>Setup failed</th><th>Runner failed</th><th>Parse failed</th><th>Not run</th><th>Success</th><th>Failure</th></tr></thead><tbody>${reliabilityRows}</tbody></table></div></section><section><h2>Paired Scenario Deltas</h2><p>Deltas vs grep_read compare score differences inside the same scenario and repeat block.</p><div class="scroll"><table><thead><tr><th>Block</th><th>Scenario</th><th>Repeat</th><th>SolidKG</th><th>grep_read</th><th>Tilth</th><th>Cartog</th><th>Sverklo</th><th>Deltas vs grep_read</th></tr></thead><tbody>${pairedRows}</tbody></table></div></section><section><h2>Run Details</h2><div class="scroll"><table><thead><tr><th>Order</th><th>Planned ID</th><th>Block</th><th>Scenario</th><th>Repeat</th><th>Arm</th><th>Status</th><th>Diagnostic composite</th><th>Answer quality</th><th>Evidence quality</th><th>Tool economy</th><th>Correctness</th><th>Evidence</th><th>Forbidden</th><th>Fallback efficiency</th><th>Economy</th><th>Notes</th><th>Sequence classes</th><th>Judge</th><th>Setup</th><th>Query</th><th>Tools</th><th>SolidKG MCP</th><th>Peer wrappers</th><th>Read</th><th>Grep</th><th>Fallback</th><th>Raw payload bytes</th><th>Truncated payloads</th><th>Reason</th><th>Tool calls</th><th>Answer excerpt</th></tr></thead><tbody>${runRows}</tbody></table></div></section></body></html>\n`;
}

export function writeAnswerQualityReport({ results, matrix = loadScenarioMatrix(), out, currentBenchmarkScriptPath = null, currentScenarioFile = null, expectedSolidKGBin = null }) {
  if (!out) throw new Error('--out is required');
  mkdirSync(out, { recursive: true });
  const report = buildAnswerQualityReport(results, matrix, { currentBenchmarkScriptPath, currentScenarioFile, expectedSolidKGBin });
  const jsonPath = join(out, `${REPORT_FILE_BASENAME}.json`);
  const mdPath = join(out, `${REPORT_FILE_BASENAME}.md`);
  const htmlPath = join(out, `${REPORT_FILE_BASENAME}.html`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));
  writeFileSync(htmlPath, renderHtml(report));
  return { report, artifacts: { jsonPath, mdPath, htmlPath } };
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
  if (!args.fromResults || !args.out) return { status: 1, stdout: '', stderr: 'usage: report-answer-quality.mjs --from-results <results.json> --out <dir> [--from-scenarios <scenarios.json>]\n' };
  if (!existsSync(args.fromResults)) return { status: 1, stdout: '', stderr: `results file not found: ${args.fromResults}\n` };
  const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
  const currentScenarioFile = args.fromScenarios || DEFAULT_FIXTURE;
  const matrix = loadScenarioMatrix(currentScenarioFile);
  const { report, artifacts } = writeAnswerQualityReport({ results, matrix, out: args.out, currentBenchmarkScriptPath: CURRENT_BENCHMARK_SCRIPT_PATH, currentScenarioFile, expectedSolidKGBin: results.solidkgBin ?? results.benchmarkPassport?.solidkg?.configuredBin ?? null });
  return { status: 0, stdout: `${JSON.stringify({ ok: true, schemaName: report.schemaName, artifacts }, null, 2)}\n`, stderr: '' };
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
