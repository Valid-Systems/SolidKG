#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyRawEvidence, validateEvidenceDossier } from './answer-evidence-contract.mjs';

export const DIAGNOSTIC_COMPARISON_SCHEMA = 'solidkg.llm-answer-quality.diagnostic-comparison.v1';
export const REPORT_BASENAME = 'llm-answer-diagnostic-comparison';
export const CLAIM_BOUNDARY = 'Diagnostic comparison only. Aggregate scores remain non-claim-grade until scorer repair and held-out validation pass.';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTool(tool) {
  return String(tool ?? '').toLowerCase();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseJsonlIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const events = [];
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: 'parse_error', raw: line });
    }
  }
  return events;
}

function toolCalls(run, events) {
  const runCalls = asArray(run.toolCalls);
  if (runCalls.length > 0) return runCalls;
  return events.filter((event) => event?.type === 'tool_call').map((event) => ({ tool: event.tool, input: event.input }));
}

function evidenceDossierAvailability(run) {
  if (!run?.evidenceDossierPath || !existsSync(run.evidenceDossierPath)) return null;
  try {
    const dossier = readJson(run.evidenceDossierPath);
    const validation = validateEvidenceDossier(dossier);
    return { available: validation.toolResultPayloadsAvailable, errors: validation.errors, path: run.evidenceDossierPath };
  } catch (error) {
    return { available: false, errors: [error.message], path: run.evidenceDossierPath };
  }
}

function hasToolResultPayload(run) {
  const dossier = evidenceDossierAvailability(run);
  return dossier?.available === true;
}

function summarizeToolSequence(calls) {
  const tools = calls.map((call) => normalizeTool(call.tool));
  const solidkgNodeCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('node')).length;
  const solidkgContextCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('context')).length;
  const solidkgExploreCalls = tools.filter((tool) => tool.includes('solidkg') && tool.includes('explore')).length;
  const peerWrapperCalls = tools.filter((tool) => /tilth|cartog|sverklo/.test(tool)).length;
  const classifications = [];
  if (solidkgNodeCalls >= 8) classifications.push('repeated_solidkg_node_calls');
  if (solidkgContextCalls > 1 && solidkgExploreCalls > 1) classifications.push('repeated_context_explore_calls');
  if (peerWrapperCalls > 1) classifications.push('repeated_peer_wrapper_calls');
  return { totalCalls: calls.length, firstTools: tools.slice(0, 8), solidkgNodeCalls, solidkgContextCalls, solidkgExploreCalls, peerWrapperCalls, classifications };
}

function hasFinalAnswer(run, events) {
  return (typeof run.answer === 'string' && run.answer.trim().length > 0) || events.some((event) => event?.type === 'final' && typeof event.content === 'string' && event.content.trim().length > 0);
}

function metricsForRun(run) {
  const events = parseJsonlIfExists(run.transcriptPath);
  const calls = toolCalls(run, events);
  const solidkgCalls = Number(run.solidkgToolCalls ?? calls.filter((call) => normalizeTool(call.tool).includes('solidkg')).length);
  const peerWrapperCalls = Number(run.peerWrapperCalls ?? calls.filter((call) => /tilth|cartog|sverklo/.test(normalizeTool(call.tool))).length);
  const readCount = Number(run.readCount ?? calls.filter((call) => normalizeTool(call.tool) === 'read').length);
  const grepCount = Number(run.grepCount ?? calls.filter((call) => /(^|_)grep$|^rg$/.test(normalizeTool(call.tool))).length);
  const toolCallSequenceSummary = summarizeToolSequence(calls);
  const classifications = [];
  if (run.armId === 'solidkg' && solidkgCalls > 0 && readCount > 0) classifications.push('solidkg_then_local_read_fallback');
  if (run.armId === 'solidkg' && solidkgCalls >= 10) classifications.push('solidkg_over_drill_risk');
  if (run.armId !== 'solidkg' && peerWrapperCalls > 0 && readCount > 0) classifications.push('peer_wrapper_plus_fallback');
  if (readCount > 0 || grepCount > 0) classifications.push('fallback_used');
  classifications.push(...toolCallSequenceSummary.classifications);
  const dossier = evidenceDossierAvailability(run);
  const rawEvidenceStatus = classifyRawEvidence({ run, events });
  if (!hasToolResultPayload(run)) classifications.push('raw_tool_outputs_unavailable');
  return {
    id: run.id,
    armId: run.armId,
    status: run.status ?? run.reliabilityStatus ?? 'not_run',
    transcriptPath: run.transcriptPath ?? null,
    evidenceDossierPath: run.evidenceDossierPath ?? null,
    finalAnswerPresent: hasFinalAnswer(run, events),
    toolCallCount: calls.length,
    solidkgCalls,
    peerWrapperCalls,
    readCount,
    grepCount,
    toolResultPayloadsAvailable: hasToolResultPayload(run),
    rawAvailabilityErrors: rawEvidenceStatus.errors ?? dossier?.errors ?? [],
    rawEvidenceStatus,
    toolCallSequenceSummary,
    classifications,
  };
}

function compareByScenario(runs, scenarios) {
  const scenarioById = new Map(asArray(scenarios.scenarios).map((scenario) => [scenario.id, scenario]));
  const byBlock = new Map();
  for (const run of runs) {
    const key = run.blockId ?? `${run.scenarioId}:r${run.repeat ?? 1}`;
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(run);
  }
  return [...byBlock.entries()].map(([blockId, blockRuns]) => {
    const scenarioId = blockRuns[0]?.scenarioId ?? blockId;
    const analyzedRuns = blockRuns.map(metricsForRun);
    return {
      blockId,
      scenarioId,
      question: scenarioById.get(scenarioId)?.question ?? null,
      solidkgRun: analyzedRuns.find((run) => run.armId === 'solidkg') ?? null,
      baselineRuns: analyzedRuns.filter((run) => run.armId !== 'solidkg'),
    };
  });
}

export function scorerRepairDesign() {
  return {
    metricOrder: ['reliability', 'correctness', 'sourceEvidence', 'roleCoverage', 'uncertaintyCalibration', 'fallbackAndToolEconomy'],
    requiredAdversarialFixtures: [
      'wrong_answer_with_right_file_tokens_fails',
      'correct_paraphrase_with_source_evidence_passes',
      'correct_files_missing_glue_hop_is_penalized',
      'false_runtime_claim_with_plausible_citation_fails',
      'fallback_heavy_but_correct_answer_is_separated_from_tool_sufficiency',
    ],
    nonGoals: [
      'do_not_match_expected_evidence_ids_as_correctness',
      'do_not_reward_file_token_seo_without_source_supported_claims',
      'do_not_merge_natural_workflow_raw_tool_sufficiency_and_fallback_constrained_lanes',
    ],
  };
}

export function buildDiagnosticComparisonReport({ runDir }) {
  if (!runDir) throw new Error('runDir is required');
  const resolvedRunDir = resolve(runDir);
  const resultsPath = join(resolvedRunDir, 'live-results.json');
  const scenariosPath = join(resolvedRunDir, 'custom-scenarios.json');
  if (!existsSync(resultsPath)) throw new Error(`live-results.json not found: ${resultsPath}`);
  if (!existsSync(scenariosPath)) throw new Error(`custom-scenarios.json not found: ${scenariosPath}`);
  const results = readJson(resultsPath);
  const scenarios = readJson(scenariosPath);
  const comparisons = compareByScenario(asArray(results.runs), scenarios);
  const allRuns = comparisons.flatMap((comparison) => [comparison.solidkgRun, ...comparison.baselineRuns].filter(Boolean));
  const missingRawOutputRuns = allRuns.filter((run) => !run.toolResultPayloadsAvailable);
  const toolResultPayloadsAvailable = allRuns.length > 0 && missingRawOutputRuns.length === 0;
  const stopConditions = [];
  if (!toolResultPayloadsAvailable) stopConditions.push('raw_tool_outputs_unavailable');
  const causeCodesByRun = Object.fromEntries(allRuns.map((run) => [run.id, run.rawEvidenceStatus?.causeCode ?? 'unknown']));
  return {
    schemaName: DIAGNOSTIC_COMPARISON_SCHEMA,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    claimBoundary: CLAIM_BOUNDARY,
    runDir: resolvedRunDir,
    rawOutputAvailability: {
      toolResultPayloadsAvailable,
      missingRunIds: missingRawOutputRuns.map((run) => run.id),
      missingTranscriptPaths: missingRawOutputRuns.map((run) => run.transcriptPath).filter(Boolean),
      missingEvidenceDossierPaths: missingRawOutputRuns.map((run) => run.evidenceDossierPath).filter(Boolean),
      causeCodesByRun,
      note: toolResultPayloadsAvailable ? 'Every analyzed run has validated raw tool result payload sidecars linked from an evidence dossier.' : 'Transcripts may preserve tool calls/final answers, but raw tool result availability requires validated evidence dossiers with payload sidecars; product changes must wait for raw MCP output capture or rerun.',
    },
    stopConditions,
    comparisons,
    scorerRepairDesign: scorerRepairDesign(),
  };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Answer Diagnostic Comparison', '');
  lines.push(`Schema: ${report.schemaName}`);
  lines.push(`Claim boundary: ${report.claimBoundary}`);
  lines.push(`Run directory: ${report.runDir}`, '');
  lines.push('## Raw Output Availability', '');
  lines.push(report.rawOutputAvailability.toolResultPayloadsAvailable ? 'Raw tool result payloads available.' : 'Raw tool outputs unavailable in captured transcripts.');
  lines.push(report.rawOutputAvailability.note, '');
  lines.push('## Stop Conditions', '');
  lines.push(report.stopConditions.length > 0 ? report.stopConditions.map((condition) => `- ${condition}`).join('\n') : '- none');
  lines.push('', '## Scenario Comparisons', '');
  lines.push('| Block | Scenario | SolidKG classes | Baseline classes |');
  lines.push('|---|---|---|---|');
  for (const comparison of report.comparisons) {
    const solidkgClasses = comparison.solidkgRun?.classifications.join(', ') || 'n/a';
    const baselineClasses = comparison.baselineRuns.map((run) => `${run.armId}: ${run.classifications.join(', ') || 'none'}`).join('<br>');
    lines.push(`| ${comparison.blockId} | ${comparison.scenarioId} | ${solidkgClasses} | ${baselineClasses} |`);
  }
  lines.push('', '## Scorer Repair Design', '');
  lines.push(`Metric order: ${report.scorerRepairDesign.metricOrder.join(' -> ')}`);
  lines.push('Required adversarial fixtures:');
  for (const fixture of report.scorerRepairDesign.requiredAdversarialFixtures) lines.push(`- ${fixture}`);
  return `${lines.join('\n')}\n`;
}

export function writeDiagnosticComparisonReport({ runDir, out }) {
  if (!out) throw new Error('--out is required');
  mkdirSync(out, { recursive: true });
  const report = buildDiagnosticComparisonReport({ runDir });
  const jsonPath = join(out, `${REPORT_BASENAME}.json`);
  const mdPath = join(out, `${REPORT_BASENAME}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));
  return { report, artifacts: { jsonPath, mdPath } };
}

function parseArgs(argv) {
  const args = { fromRunDir: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-run-dir') args.fromRunDir = argv[++i] ?? '';
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.fromRunDir || !args.out) return { status: 1, stdout: '', stderr: 'usage: compare-answer-diagnostics.mjs --from-run-dir <dir> --out <dir>\n' };
  const { report, artifacts } = writeDiagnosticComparisonReport({ runDir: args.fromRunDir, out: args.out });
  return { status: 0, stdout: `${JSON.stringify({ ok: true, schemaName: report.schemaName, stopConditions: report.stopConditions, artifacts }, null, 2)}\n`, stderr: '' };
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

