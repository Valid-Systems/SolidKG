#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const COST_ESTIMATE_SCHEMA = 'solidkg.llm-answer-quality.cost-estimate.v1';
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_INPUT_USD_PER_MTOK = 1.25;
const DEFAULT_OUTPUT_USD_PER_MTOK = 10;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTextIfExists(filePath) {
  return typeof filePath === 'string' && existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function sizeIfExists(filePath) {
  return typeof filePath === 'string' && existsSync(filePath) ? statSync(filePath).size : 0;
}

function promptText(run) {
  const argv = Array.isArray(run?.opencode?.argv) ? run.opencode.argv : [];
  const runIndex = argv.indexOf('run');
  if (runIndex >= 0 && typeof argv[runIndex + 1] === 'string') return argv[runIndex + 1];
  return argv.filter((value) => typeof value === 'string').join(' ');
}

function estimateTokens(charCount, charsPerToken) {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / charsPerToken);
}

function estimateCostUsd(inputTokens, outputTokens, options) {
  return Number((((inputTokens * options.inputUsdPerMTok) + (outputTokens * options.outputUsdPerMTok)) / 1_000_000).toFixed(9));
}

function costOptions(options = {}) {
  return {
    charsPerToken: Number(options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN),
    inputUsdPerMTok: Number(options.inputUsdPerMTok ?? DEFAULT_INPUT_USD_PER_MTOK),
    outputUsdPerMTok: Number(options.outputUsdPerMTok ?? DEFAULT_OUTPUT_USD_PER_MTOK),
  };
}

function estimateRun(run, options) {
  const promptChars = promptText(run).length;
  const stderrChars = sizeIfExists(run.stderrPath);
  const transcriptChars = sizeIfExists(run.transcriptPath);
  const stdoutChars = sizeIfExists(run.stdoutPath);
  const outputChars = typeof run.answer === 'string' && run.answer.length > 0 ? run.answer.length : readTextIfExists(run.stdoutPath).length;
  const estimatedInputChars = promptChars + stderrChars + transcriptChars;
  const estimatedInputTokens = estimateTokens(estimatedInputChars, options.charsPerToken);
  const estimatedOutputTokens = estimateTokens(outputChars, options.charsPerToken);
  return {
    id: run.id,
    armId: run.armId,
    status: run.status,
    score: typeof run.score === 'number' ? run.score : null,
    promptChars,
    stderrChars,
    transcriptChars,
    stdoutChars,
    outputChars,
    estimatedInputChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    estimatedCostUsd: estimateCostUsd(estimatedInputTokens, estimatedOutputTokens, options),
    capturedProviderCostUsd: typeof run.costUsd === 'number' && run.costUsd > 0 ? run.costUsd : null,
    readCount: Number(run.readCount ?? 0),
    grepCount: Number(run.grepCount ?? 0),
    solidkgToolCalls: Number(run.solidkgToolCalls ?? 0),
    peerWrapperCalls: Number(run.peerWrapperCalls ?? 0),
    toolCallCount: Array.isArray(run.toolCalls) ? run.toolCalls.length : 0,
  };
}

function aggregateRows(rows) {
  const byArm = new Map();
  for (const row of rows) {
    if (!byArm.has(row.armId)) byArm.set(row.armId, []);
    byArm.get(row.armId).push(row);
  }
  return [...byArm.entries()].map(([armId, armRows]) => {
    const sum = (field) => armRows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
    return {
      armId,
      runs: armRows.length,
      estimatedInputTokens: sum('estimatedInputTokens'),
      estimatedOutputTokens: sum('estimatedOutputTokens'),
      estimatedTotalTokens: sum('estimatedTotalTokens'),
      estimatedCostUsd: Number(sum('estimatedCostUsd').toFixed(9)),
      capturedProviderCostUsd: armRows.every((row) => row.capturedProviderCostUsd === null) ? null : Number(sum('capturedProviderCostUsd').toFixed(9)),
      readCount: sum('readCount'),
      grepCount: sum('grepCount'),
      solidkgToolCalls: sum('solidkgToolCalls'),
      peerWrapperCalls: sum('peerWrapperCalls'),
      toolCallCount: sum('toolCallCount'),
    };
  }).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
}

export function buildCostEstimateReport(results, options = {}) {
  if (!isRecord(results) || !Array.isArray(results.runs)) throw new Error('results.runs must be an array');
  const normalizedOptions = costOptions(options);
  const perRunRows = results.runs.map((run) => estimateRun(run, normalizedOptions));
  return {
    schemaName: COST_ESTIMATE_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceSchemaName: results.schemaName ?? null,
    model: results.model ?? null,
    variant: results.variant ?? null,
    pricing: {
      charsPerToken: normalizedOptions.charsPerToken,
      inputUsdPerMTok: normalizedOptions.inputUsdPerMTok,
      outputUsdPerMTok: normalizedOptions.outputUsdPerMTok,
      caveat: 'Offline estimate from captured artifact character counts. It is not provider billing and may overcount or undercount actual model context.'
    },
    aggregateByArm: aggregateRows(perRunRows),
    perRunRows,
  };
}

function money(value) {
  return value === null || value === undefined ? 'n/a' : `$${Number(value).toFixed(6)}`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Estimated Cost Report');
  lines.push('');
  lines.push(`Schema: ${report.schemaName}`);
  lines.push(`Model: ${report.model ?? 'n/a'}`);
  lines.push(`Variant: ${report.variant ?? 'default'}`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(report.pricing.caveat);
  lines.push(`Assumption: ${report.pricing.charsPerToken} characters/token, $${report.pricing.inputUsdPerMTok}/1M input tokens, $${report.pricing.outputUsdPerMTok}/1M output tokens.`);
  lines.push('');
  lines.push('## Aggregate By Arm');
  lines.push('');
  lines.push('| Arm | Estimated Cost | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Reads | Greps | SolidKG MCP | Peer Wrapper |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.aggregateByArm) {
    lines.push(`| ${row.armId} | ${money(row.estimatedCostUsd)} | ${row.estimatedInputTokens} | ${row.estimatedOutputTokens} | ${row.estimatedTotalTokens} | ${row.toolCallCount} | ${row.readCount} | ${row.grepCount} | ${row.solidkgToolCalls} | ${row.peerWrapperCalls} |`);
  }
  lines.push('');
  lines.push('## Per Run');
  lines.push('');
  lines.push('| Run | Arm | Status | Estimated Cost | Input Tokens | Output Tokens | Prompt Chars | stderr Chars | Transcript Chars | Output Chars |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.perRunRows) {
    lines.push(`| ${row.id} | ${row.armId} | ${row.status} | ${money(row.estimatedCostUsd)} | ${row.estimatedInputTokens} | ${row.estimatedOutputTokens} | ${row.promptChars} | ${row.stderrChars} | ${row.transcriptChars} | ${row.outputChars} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function writeCostEstimateReport({ results, out, options = {} }) {
  mkdirSync(out, { recursive: true });
  const report = buildCostEstimateReport(results, options);
  const jsonPath = join(out, 'llm-answer-cost-estimate.json');
  const mdPath = join(out, 'llm-answer-cost-estimate.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));
  return { report, artifacts: { jsonPath, mdPath } };
}

function parseArgs(argv) {
  const args = { fromResults: '', out: '', charsPerToken: DEFAULT_CHARS_PER_TOKEN, inputUsdPerMTok: DEFAULT_INPUT_USD_PER_MTOK, outputUsdPerMTok: DEFAULT_OUTPUT_USD_PER_MTOK };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-results') args.fromResults = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--chars-per-token') args.charsPerToken = Number(argv[++i] ?? args.charsPerToken);
    else if (arg === '--input-usd-per-mtok') args.inputUsdPerMTok = Number(argv[++i] ?? args.inputUsdPerMTok);
    else if (arg === '--output-usd-per-mtok') args.outputUsdPerMTok = Number(argv[++i] ?? args.outputUsdPerMTok);
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.fromResults || !args.out) return { status: 1, stdout: '', stderr: 'usage: estimate-answer-costs.mjs --from-results <results.json> --out <dir> [--chars-per-token <n>] [--input-usd-per-mtok <n>] [--output-usd-per-mtok <n>]\n' };
  const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
  const { report, artifacts } = writeCostEstimateReport({ results, out: args.out, options: args });
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
