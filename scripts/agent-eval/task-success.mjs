#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const INPUT_SCHEMA = 'solidkg.task-success-results.v1';
const REPORT_SCHEMA = 'solidkg.task-success-eval.v1';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateResults(results) {
  const errors = [];
  if (!isRecord(results)) return ['results must be a JSON object'];
  if (results.schemaName !== INPUT_SCHEMA) errors.push(`schemaName must be ${INPUT_SCHEMA}`);
  if (!isRecord(results.repo)) errors.push('repo is required');
  if (!Array.isArray(results.scenarios) || results.scenarios.length === 0) errors.push('scenarios must include at least one scenario');
  if (Array.isArray(results.scenarios)) {
    results.scenarios.forEach((scenario, index) => {
      const path = `scenarios[${index}]`;
      if (!isRecord(scenario)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (typeof scenario.id !== 'string' || scenario.id.length === 0) errors.push(`${path}.id is required`);
      if (!Array.isArray(scenario.expectedEvidenceIds)) errors.push(`${path}.expectedEvidenceIds must be an array`);
      if (!isRecord(scenario.run)) errors.push(`${path}.run is required`);
    });
  }
  return errors;
}

function countTools(scenarios) {
  const allCalls = scenarios.flatMap((scenario) => Array.isArray(scenario.run?.toolCalls) ? scenario.run.toolCalls : []);
  const toolNames = allCalls.map((call) => String(call.tool ?? '').toLowerCase());
  const readCount = toolNames.filter((tool) => tool === 'read').length;
  const grepCount = toolNames.filter((tool) => tool === 'grep' || tool === 'rg' || tool === 'bash').length;
  const solidkgCalls = toolNames.filter((tool) => tool.startsWith('solidkg_')).length;
  const fallbackCount = readCount + grepCount;
  const totalCalls = allCalls.length;
  return {
    readCount,
    grepCount,
    solidkgCalls,
    fallbackRate: totalCalls === 0 ? 0 : Number((fallbackCount / totalCalls).toFixed(3)),
  };
}

function summarizeScenario(scenario) {
  const expected = scenario.expectedEvidenceIds.map(String);
  const returned = new Set((scenario.run?.answerPacket?.evidence ?? []).map((entry) => String(entry.evidenceId)));
  const missingEvidenceIds = expected.filter((id) => !returned.has(id));
  const evidenceCoverage = expected.length === 0 ? 1 : Number(((expected.length - missingEvidenceIds.length) / expected.length).toFixed(3));
  return {
    id: scenario.id,
    prompt: scenario.prompt ?? '',
    status: missingEvidenceIds.length === 0 ? 'pass' : 'fail',
    evidenceCoverage,
    expectedEvidenceIds: expected,
    missingEvidenceIds,
  };
}

function buildReport(results) {
  const scenarioSummaries = results.scenarios.map(summarizeScenario);
  const counts = countTools(results.scenarios);
  const thresholds = results.thresholds ?? {};
  const fallbackBreach = counts.readCount > (thresholds.maxReadCount ?? Infinity) || counts.grepCount > (thresholds.maxGrepCount ?? Infinity);
  const status = scenarioSummaries.every((scenario) => scenario.status === 'pass') && !fallbackBreach ? 'pass' : 'fail';
  return {
    schemaName: REPORT_SCHEMA,
    status,
    repo: results.repo,
    fallbackMetrics: {
      ...counts,
      fallbackBreach,
    },
    scenarioSummaries,
  };
}

function renderMarkdown(report) {
  const lines = ['# Task Success Evaluation', '', `Repository: ${report.repo.name ?? basename(report.repo.path ?? 'unknown')}`, '', `Status: ${report.status}`, '', '## Fallback Metrics', ''];
  lines.push(`- Read calls: ${report.fallbackMetrics.readCount}`);
  lines.push(`- Grep/Bash calls: ${report.fallbackMetrics.grepCount}`);
  lines.push(`- SolidKG calls: ${report.fallbackMetrics.solidkgCalls}`);
  lines.push(`- Fallback rate: ${report.fallbackMetrics.fallbackRate}`);
  lines.push(`- Fallback breach: ${report.fallbackMetrics.fallbackBreach}`);
  lines.push('', '## Scenarios', '');
  for (const scenario of report.scenarioSummaries) {
    lines.push(`- ${scenario.id}: ${scenario.status} (${scenario.evidenceCoverage})`);
    if (scenario.missingEvidenceIds.length > 0) lines.push(`  Missing: ${scenario.missingEvidenceIds.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { fromResults: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-results') args.fromResults = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.fromResults) {
  console.error('usage: task-success.mjs --from-results <results.json> [--out <dir>]');
  process.exit(1);
}
if (!existsSync(args.fromResults)) {
  console.error(`results file not found: ${args.fromResults}`);
  process.exit(1);
}

const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
const errors = validateResults(results);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const report = buildReport(results);
if (args.out) {
  mkdirSync(args.out, { recursive: true });
  const json = join(args.out, 'task-success-eval.json');
  const markdown = join(args.out, 'task-success-eval.md');
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  process.stdout.write(`${JSON.stringify({ ok: report.status === 'pass', artifacts: { json, markdown } }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
