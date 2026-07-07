#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIAGNOSTIC_FREEZE_SCHEMA = 'solidkg.llm-answer-quality.diagnostic-freeze.v1';
export const REPORT_BASENAME = 'llm-answer-diagnostic-freeze';
export const CLAIM_BOUNDARY = 'Diagnostic-only failure-analysis evidence. Do not use this artifact as a scoreboard or public superiority claim.';

const REQUIRED_ARTIFACTS = [
  'run-plan.json',
  'custom-scenarios.json',
  'live-results.json',
  'llm-answer-quality.json',
  'llm-answer-quality.md',
  'opencode-capabilities.json',
  'runs',
  'setup',
];

const OPTIONAL_ARTIFACTS = [
  'calibration-success.json',
  'smoke-success.json',
  'dry-run-results.json',
  'live-results.partial.json',
  'llm-answer-quality.html',
  'llm-answer-cost-estimate.json',
  'llm-answer-cost-estimate.md',
  'opencode-dry-runs',
];

function parseJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function directoryDigestEntries(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)))) {
    const entryPath = join(current, name);
    const stat = statSync(entryPath);
    const entryName = relative(root, entryPath).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      entries.push(`dir\t${entryName}`);
      entries.push(...directoryDigestEntries(root, entryPath));
    } else if (stat.isFile()) {
      entries.push(`file\t${entryName}\t${stat.size}\t${hashFile(entryPath)}`);
    } else {
      entries.push(`other\t${entryName}\t${stat.size}`);
    }
  }
  return entries;
}

function hashDirectory(directoryPath) {
  return createHash('sha256').update(`${directoryDigestEntries(directoryPath).join('\n')}\n`).digest('hex');
}

function artifactRecord(runDir, relativePath) {
  const artifactPath = join(runDir, relativePath);
  if (!existsSync(artifactPath)) return { relativePath, exists: false, type: 'missing', sizeBytes: 0, sha256: null, childCount: null };
  const stat = statSync(artifactPath);
  const isDirectory = stat.isDirectory();
  return {
    relativePath,
    exists: true,
    type: isDirectory ? 'directory' : 'file',
    sizeBytes: isDirectory ? 0 : stat.size,
    sha256: isDirectory ? hashDirectory(artifactPath) : hashFile(artifactPath),
    childCount: isDirectory ? readdirSync(artifactPath).length : null,
  };
}

function runSummary(runDir) {
  const runPlan = parseJsonIfExists(join(runDir, 'run-plan.json')) ?? {};
  const results = parseJsonIfExists(join(runDir, 'live-results.json')) ?? {};
  const scenarios = parseJsonIfExists(join(runDir, 'custom-scenarios.json')) ?? {};
  const qualityReport = parseJsonIfExists(join(runDir, 'llm-answer-quality.json')) ?? {};
  return {
    profile: results.profile ?? runPlan.profile ?? null,
    plannedRunCount: runPlan.plannedRunCount ?? results.plannedRunOrder?.length ?? null,
    resultRunCount: Array.isArray(results.runs) ? results.runs.length : null,
    scenarioCount: Array.isArray(scenarios.scenarios) ? scenarios.scenarios.length : null,
    repoCount: Array.isArray(scenarios.repoMatrix) ? scenarios.repoMatrix.length : null,
    model: results.model ?? runPlan.model ?? null,
    variant: results.variant ?? runPlan.variant ?? null,
    repoCache: runPlan.repoCache ?? null,
    benchmarkCoverageDecisionReady: qualityReport.benchmarkCoverage?.decisionReady ?? null,
  };
}

export function buildDiagnosticFreezeReport({ runDir }) {
  if (!runDir) throw new Error('runDir is required');
  const resolvedRunDir = resolve(runDir);
  if (!existsSync(resolvedRunDir)) throw new Error(`run directory not found: ${resolvedRunDir}`);
  const requiredArtifacts = REQUIRED_ARTIFACTS.map((artifact) => artifactRecord(resolvedRunDir, artifact));
  const optionalArtifacts = OPTIONAL_ARTIFACTS.map((artifact) => artifactRecord(resolvedRunDir, artifact));
  const requiredArtifactsMissing = requiredArtifacts.filter((artifact) => !artifact.exists).map((artifact) => artifact.relativePath);
  const optionalArtifactsMissing = optionalArtifacts.filter((artifact) => !artifact.exists).map((artifact) => artifact.relativePath);
  return {
    schemaName: DIAGNOSTIC_FREEZE_SCHEMA,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    claimBoundary: CLAIM_BOUNDARY,
    runDir: resolvedRunDir,
    validationStatus: requiredArtifactsMissing.length === 0 ? 'complete_required_artifacts' : 'missing_required_artifacts',
    requiredArtifactsMissing,
    optionalArtifactsMissing,
    runSummary: runSummary(resolvedRunDir),
    requiredArtifacts,
    optionalArtifacts,
  };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Diagnostic-only artifact freeze', '');
  lines.push(`Schema: ${report.schemaName}`);
  lines.push(`Run directory: ${report.runDir}`);
  lines.push(`Validation status: ${report.validationStatus}`);
  lines.push(`Claim boundary: ${report.claimBoundary}`, '');
  lines.push('## Run Summary', '');
  lines.push(`- Profile: ${report.runSummary.profile ?? 'n/a'}`);
  lines.push(`- Planned runs: ${report.runSummary.plannedRunCount ?? 'n/a'}`);
  lines.push(`- Result runs: ${report.runSummary.resultRunCount ?? 'n/a'}`);
  lines.push(`- Scenarios: ${report.runSummary.scenarioCount ?? 'n/a'}`);
  lines.push(`- Repos: ${report.runSummary.repoCount ?? 'n/a'}`);
  lines.push(`- Model: ${report.runSummary.model ?? 'n/a'}`);
  lines.push(`- Variant: ${report.runSummary.variant ?? 'default'}`);
  lines.push(`- Repo cache: ${report.runSummary.repoCache ?? 'n/a'}`, '');
  lines.push('## Required Artifacts', '');
  lines.push('| Artifact | Status | Type | Size bytes | SHA-256 | Children |');
  lines.push('|---|---|---|---:|---|---:|');
  for (const artifact of report.requiredArtifacts) lines.push(`| ${artifact.relativePath} | ${artifact.exists ? 'present' : 'missing'} | ${artifact.type} | ${artifact.sizeBytes} | ${artifact.sha256 ?? 'n/a'} | ${artifact.childCount ?? 'n/a'} |`);
  lines.push('', '## Optional Artifacts', '');
  lines.push(`Missing optional artifacts: ${report.optionalArtifactsMissing.join(', ') || 'none'}`, '');
  return `${lines.join('\n')}\n`;
}

export function writeDiagnosticFreezeReport({ runDir, out }) {
  if (!out) throw new Error('--out is required');
  mkdirSync(out, { recursive: true });
  const report = buildDiagnosticFreezeReport({ runDir });
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
  if (!args.fromRunDir || !args.out) return { status: 1, stdout: '', stderr: 'usage: freeze-answer-diagnostics.mjs --from-run-dir <dir> --out <dir>\n' };
  const { report, artifacts } = writeDiagnosticFreezeReport({ runDir: args.fromRunDir, out: args.out });
  return { status: report.requiredArtifactsMissing.length === 0 ? 0 : 2, stdout: `${JSON.stringify({ ok: report.requiredArtifactsMissing.length === 0, schemaName: report.schemaName, validationStatus: report.validationStatus, artifacts }, null, 2)}\n`, stderr: '' };
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
