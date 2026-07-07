#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const JUDGE_SCHEMA = 'solidkg.llm-answer-quality.judge.v1';
export const BANNED_JUDGE_TERMS = ['solidkg', 'tilth', 'cartog', 'sverklo', 'grep_read', 'baseline'];
const REDACTION = '[redacted-tool]';
const DEFAULT_JUDGE_COST_USD = 0.05;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeForJudge(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  for (const term of BANNED_JUDGE_TERMS) text = text.replace(new RegExp(escapeRegex(term), 'gi'), REDACTION);
  return text;
}

export function buildJudgePacket({ run, scenario }) {
  const rubric = scenario?.rubric ?? {};
  return {
    schemaName: sanitizeForJudge(JUDGE_SCHEMA),
    scenarioId: sanitizeForJudge(run?.scenarioId ?? scenario?.id ?? 'unknown-scenario'),
    question: sanitizeForJudge(scenario?.question ?? ''),
    answerType: sanitizeForJudge(scenario?.answerType ?? rubric.answerType ?? ''),
    answer: sanitizeForJudge(run?.answer ?? run?.finalAnswer?.text ?? ''),
    rubric: {
      mustMention: asArray(rubric.mustMention).map(sanitizeForJudge),
      expectedEvidence: asArray(rubric.expectedEvidence).map((evidence) => ({ file: sanitizeForJudge(evidence.file ?? ''), symbolHint: sanitizeForJudge(evidence.symbolHint ?? ''), claim: sanitizeForJudge(evidence.claim ?? '') })),
      forbiddenClaims: asArray(rubric.forbiddenClaims).map(sanitizeForJudge),
      minEvidenceAnchors: rubric.minEvidenceAnchors ?? 1,
    },
    deterministicScore: typeof run?.score === 'number' ? run.score : null,
  };
}

export function buildJudgePrompt(packet) {
  const prompt = [
    'You are an independent blinded answer-quality judge.',
    'Do not infer which retrieval surface produced the answer.',
    'Score only the answer against the rubric for this measured scenario.',
    'Return strict JSON with keys: secondaryScore, confidence, comments.',
    '',
    JSON.stringify(packet, null, 2),
  ].join('\n');
  const lower = prompt.toLowerCase();
  const leaked = BANNED_JUDGE_TERMS.filter((term) => lower.includes(term));
  if (leaked.length > 0) throw new Error(`judge prompt leaked blinded labels: ${leaked.join(', ')}`);
  return prompt;
}

export function parseJudgeOutput(text) {
  try {
    const parsed = JSON.parse(String(text ?? '').trim());
    const rawScore = Number(parsed.secondaryScore ?? parsed.score);
    return { status: Number.isFinite(rawScore) ? 'pass' : 'parse_failed', secondaryScore: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null, confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null, comments: typeof parsed.comments === 'string' ? parsed.comments : '' };
  } catch (error) {
    return { status: 'parse_failed', secondaryScore: null, comments: `Judge output was not JSON: ${error.message}` };
  }
}

export function attachJudgeResult(run, judgeResult) {
  return { ...run, judge: { schemaName: sanitizeForJudge(JUDGE_SCHEMA), status: judgeResult.status, secondaryScore: judgeResult.secondaryScore ?? null, confidence: judgeResult.confidence ?? null, comments: judgeResult.comments ?? '', reason: judgeResult.reason } };
}

function judgeLiveGuard({ confirmLive, maxRuns, maxEstimatedCostUsd }) {
  if (!confirmLive) return { ok: false, reason: 'judge live execution requires --confirm-live' };
  if (!Number.isFinite(maxRuns) || maxRuns < 1) return { ok: false, reason: 'judge live execution requires finite --max-runs of at least 1' };
  if (!Number.isFinite(maxEstimatedCostUsd) || maxEstimatedCostUsd < DEFAULT_JUDGE_COST_USD) return { ok: false, reason: `judge live execution requires --max-estimated-cost-usd >= ${DEFAULT_JUDGE_COST_USD}` };
  return { ok: true };
}

export function judgeRun({ run, scenario, opencodeBin = process.env.OPENCODE_BIN || 'opencode', model = process.env.OPENCODE_MODEL || 'openai/gpt-5.5', timeoutMs = 900000, dryRun = true, confirmLive = false, maxRuns = null, maxEstimatedCostUsd = null }) {
  const packet = buildJudgePacket({ run, scenario });
  const prompt = buildJudgePrompt(packet);
  if (dryRun) return attachJudgeResult(run, { status: 'dry_run', secondaryScore: null, comments: 'Judge prompt built but not executed.', prompt });
  const guard = judgeLiveGuard({ confirmLive, maxRuns, maxEstimatedCostUsd });
  if (!guard.ok) return attachJudgeResult(run, { status: 'runner_failed', secondaryScore: null, reason: 'judge_live_guard_failed', comments: guard.reason });
  const help = spawnSync(opencodeBin, ['--help'], { encoding: 'utf8', timeout: Math.min(timeoutMs, 30000) });
  if (help.error || help.status !== 0) return attachJudgeResult(run, { status: 'runner_failed', secondaryScore: null, reason: 'judge_runner_unavailable', comments: help.error?.message ?? help.stderr ?? '' });
  const result = spawnSync(opencodeBin, ['run', prompt, '--model', model, '--format', 'json', '--pure'], { encoding: 'utf8', timeout: timeoutMs });
  if (result.error || result.status !== 0) return attachJudgeResult(run, { status: 'runner_failed', secondaryScore: null, reason: 'judge_runner_failed', comments: result.error?.message ?? result.stderr ?? '' });
  return attachJudgeResult(run, parseJudgeOutput(result.stdout));
}

function parseArgs(argv) {
  const args = { fromRun: '', fromScenario: '', dryRun: true, confirmLive: false, maxRuns: null, maxEstimatedCostUsd: null, opencodeBin: process.env.OPENCODE_BIN || 'opencode', model: process.env.OPENCODE_MODEL || 'openai/gpt-5.5', timeoutMs: 900000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-run') args.fromRun = argv[++i] ?? '';
    else if (arg === '--from-scenario') args.fromScenario = argv[++i] ?? '';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm-live') { args.confirmLive = true; args.dryRun = false; }
    else if (arg === '--max-runs') args.maxRuns = Number(argv[++i] ?? '');
    else if (arg === '--max-estimated-cost-usd') args.maxEstimatedCostUsd = Number(argv[++i] ?? '');
    else if (arg === '--opencode-bin') args.opencodeBin = argv[++i] ?? '';
    else if (arg === '--model') args.model = argv[++i] ?? '';
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] ?? args.timeoutMs);
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.fromRun || !args.fromScenario) return { status: 1, stdout: '', stderr: 'usage: judge-opencode-answer.mjs --from-run <run.json> --from-scenario <scenario.json> [--dry-run]\n' };
  if (!existsSync(args.fromRun) || !existsSync(args.fromScenario)) return { status: 1, stdout: '', stderr: 'run and scenario files must exist\n' };
  const run = JSON.parse(readFileSync(args.fromRun, 'utf8'));
  const scenario = JSON.parse(readFileSync(args.fromScenario, 'utf8'));
  const judged = judgeRun({ run, scenario, opencodeBin: args.opencodeBin, model: args.model, timeoutMs: args.timeoutMs, dryRun: args.dryRun, confirmLive: args.confirmLive, maxRuns: args.maxRuns, maxEstimatedCostUsd: args.maxEstimatedCostUsd });
  return { status: 0, stdout: `${JSON.stringify(judged, null, 2)}\n`, stderr: '' };
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

