#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCENARIO_SCHEMA = 'solidkg.llm-answer-quality.scenarios.v1';
export const RESULTS_SCHEMA = 'solidkg.llm-answer-quality.results.v1';
export const REPORT_SCHEMA = 'solidkg.llm-answer-quality.report.v1';
export const PROFILES = ['calibration', 'smoke', 'full'];
export const REPO_IDS = ['ky', 'excalidraw', 'vscode', 'click', 'flask', 'django', 'cobra', 'gin', 'terraform'];
export const SCENARIO_KINDS = ['architecture_flow', 'entrypoint_to_core', 'failure_or_edge_path'];
export const ARM_IDS = ['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo'];
export const RELIABILITY_STATUSES = ['not_run', 'pass', 'fail', 'unsupported', 'setup_failed', 'runner_failed', 'parse_failed'];

export const DEFAULT_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'agent-eval', 'answer-quality', 'sample-scenarios.json');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

export function validationOptionsForScenarioFile(filePath = DEFAULT_FIXTURE) {
  const builtInFixture = resolve(filePath) === DEFAULT_FIXTURE;
  return { requireExactRepoIds: builtInFixture, requireExactProfileShape: builtInFixture };
}

function containsBannedPlaceholder(value) {
  return JSON.stringify(value).toLowerCase().match(/todo|draft_gold|placeholder/) !== null;
}

export function loadScenarioMatrix(filePath = DEFAULT_FIXTURE) {
  if (!existsSync(filePath)) throw new Error(`scenario file not found: ${filePath}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function validateScenarioMatrix(matrix, options = {}) {
  const errors = [];
  const profile = options.profile;
  const requireExactRepoIds = options.requireExactRepoIds ?? true;
  const requireExactProfileShape = options.requireExactProfileShape ?? true;
  if (!isRecord(matrix)) return ['scenario matrix must be a JSON object'];
  if (matrix.schemaName !== SCENARIO_SCHEMA) errors.push(`schemaName must be ${SCENARIO_SCHEMA}`);
  if (!Array.isArray(matrix.repoMatrix)) errors.push('repoMatrix must be an array');
  if (!Array.isArray(matrix.scenarios)) errors.push('scenarios must be an array');

  const matrixRepoIds = Array.isArray(matrix.repoMatrix) ? matrix.repoMatrix.map((repo) => repo?.id).filter(Boolean) : [];

  if (Array.isArray(matrix.repoMatrix)) {
    if (requireExactRepoIds) {
      if (!sameSet(matrixRepoIds, REPO_IDS)) errors.push(`repoMatrix repo ids must be exactly ${REPO_IDS.join(', ')}`);
    } else {
      if (matrixRepoIds.length === 0) errors.push('repoMatrix must include at least one repo id');
      if (unique(matrixRepoIds).length !== matrixRepoIds.length) errors.push('repoMatrix repo ids must be unique');
    }
  }

  if (Array.isArray(matrix.scenarios)) {
    const ids = new Set();
    matrix.scenarios.forEach((scenario, index) => {
      const path = `scenarios[${index}]`;
      if (!isRecord(scenario)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!hasText(scenario.id)) errors.push(`${path}.id is required`);
      else if (ids.has(scenario.id)) errors.push(`${path}.id must be unique`);
      else ids.add(scenario.id);
      const allowedRepoIds = requireExactRepoIds ? REPO_IDS : matrixRepoIds;
      if (!allowedRepoIds.includes(scenario.repoId)) errors.push(`${path}.repoId must be one of ${allowedRepoIds.join(', ')}`);
      if (!SCENARIO_KINDS.includes(scenario.kind)) errors.push(`${path}.kind must be one of ${SCENARIO_KINDS.join(', ')}`);
      if (hasText(scenario.id) && hasText(scenario.repoId) && hasText(scenario.kind) && scenario.id !== `${scenario.repoId}-${scenario.kind}`) errors.push(`${path}.id must be <repo>-<scenario-kind>`);
      if (!hasText(scenario.question)) errors.push(`${path}.question is required`);
      if (!isRecord(scenario.rubric)) {
        errors.push(`${path}.rubric is required`);
        return;
      }
      const rubric = scenario.rubric;
      if (!Array.isArray(rubric.mustMention) || rubric.mustMention.length === 0) errors.push(`${path}.rubric.mustMention must be non-empty`);
      if (!Array.isArray(rubric.expectedEvidence) || rubric.expectedEvidence.length === 0) errors.push(`${path}.rubric.expectedEvidence must be non-empty`);
      if (!Array.isArray(rubric.forbiddenClaims)) errors.push(`${path}.rubric.forbiddenClaims must be an array`);
      if (!hasText(scenario.answerType) && !hasText(rubric.answerType)) errors.push(`${path}.answerType or rubric.answerType is required`);
      if (typeof rubric.minEvidenceAnchors !== 'number' || rubric.minEvidenceAnchors < 1) errors.push(`${path}.rubric.minEvidenceAnchors must be a positive number`);
      if (!hasText(rubric.evidenceProvenance)) errors.push(`${path}.rubric.evidenceProvenance is required`);
      if (!hasText(rubric.goldEvidenceProvenance)) errors.push(`${path}.rubric.goldEvidenceProvenance is required`);
      if (!isRecord(rubric.goldSecondReview)) errors.push(`${path}.rubric.goldSecondReview is required`);
      if (!hasText(rubric.secondReviewedBy)) errors.push(`${path}.rubric.secondReviewedBy is required`);
      if (rubric.secondReviewStatus !== 'approved') errors.push(`${path}.rubric.secondReviewStatus must be approved`);
      if (isRecord(rubric.goldSecondReview) && rubric.goldSecondReview.status !== 'approved') errors.push(`${path}.rubric.goldSecondReview.status must be approved`);
      if (profile === 'full' && containsBannedPlaceholder(rubric)) errors.push(`${path}.rubric must not contain TODO, draft_gold, or placeholder text`);
    });
  }

  const selected = errors.length === 0 && profile ? selectScenarios(matrix, profile) : [];
  if (profile === 'calibration') {
    if (requireExactProfileShape && selected.length !== 1) errors.push('calibration profile must select exactly 1 scenario');
    if (!requireExactProfileShape && selected.length === 0) errors.push('calibration profile must select at least 1 scenario');
  }
  if (profile === 'smoke') {
    if (requireExactProfileShape && selected.length !== 9) errors.push('smoke profile must select exactly 9 scenarios');
    if (!requireExactProfileShape && selected.length === 0) errors.push('smoke profile must select at least 1 scenario');
    const kinds = unique(selected.map((scenario) => scenario.kind));
    if (!sameSet(kinds, ['architecture_flow'])) errors.push('smoke profile must use only architecture_flow scenarios');
  }
  if (profile === 'full') {
    if (requireExactProfileShape && selected.length !== 27) errors.push('full profile must select exactly 27 scenarios');
    if (!requireExactProfileShape && selected.length === 0) errors.push('full profile must select at least 1 scenario');
    const kinds = unique(selected.map((scenario) => scenario.kind));
    if (requireExactProfileShape && !sameSet(kinds, SCENARIO_KINDS)) errors.push(`full profile scenario kinds must be exactly ${SCENARIO_KINDS.join(', ')}`);
  }
  return errors;
}

export function selectScenarios(matrix, profile) {
  if (!PROFILES.includes(profile)) throw new Error(`profile must be one of ${PROFILES.join(', ')}`);
  if (profile === 'calibration') {
    const ids = matrix.profiles?.calibration?.scenarioIds ?? [];
    return matrix.scenarios.filter((scenario) => ids.includes(scenario.id));
  }
  if (profile === 'smoke') return matrix.scenarios.filter((scenario) => scenario.kind === 'architecture_flow');
  return matrix.scenarios.filter((scenario) => SCENARIO_KINDS.includes(scenario.kind));
}

export function buildPlannedRuns(matrix, profile, arms = ARM_IDS) {
  const selected = selectScenarios(matrix, profile);
  const repeats = profile === 'full' ? 2 : 1;
  const plannedRuns = [];
  for (const scenario of selected) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const blockId = `${scenario.id}:r${repeat}`;
      for (const armId of arms) plannedRuns.push({ id: `${blockId}:${armId}`, blockId, scenarioId: scenario.id, repoId: scenario.repoId, scenarioKind: scenario.kind, repeat, armId });
    }
  }
  return plannedRuns;
}

export function buildProfileSummary(matrix, profile) {
  const selected = selectScenarios(matrix, profile);
  const plannedRuns = buildPlannedRuns(matrix, profile);
  return {
    ok: true,
    schemaName: SCENARIO_SCHEMA,
    reportSchemaName: REPORT_SCHEMA,
    profile,
    scenarioCount: selected.length,
    plannedRunCount: plannedRuns.length,
    repoIds: unique(selected.map((scenario) => scenario.repoId)),
    scenarioKinds: unique(selected.map((scenario) => scenario.kind)),
    plannedRunOrder: plannedRuns.map((run) => run.id),
    scenarios: selected
  };
}

export function validateAnswerQualityResults(results) {
  const errors = [];
  if (!isRecord(results)) return ['results must be a JSON object'];
  if (results.schemaName !== RESULTS_SCHEMA) errors.push(`schemaName must be ${RESULTS_SCHEMA}`);
  if (results.reportSchemaName !== REPORT_SCHEMA) errors.push(`reportSchemaName must be ${REPORT_SCHEMA}`);
  if (!PROFILES.includes(results.profile)) errors.push(`profile must be one of ${PROFILES.join(', ')}`);
  if (!hasText(results.seed)) errors.push('seed is required');
  if (!Array.isArray(results.plannedRunOrder)) errors.push('plannedRunOrder must be an array');
  if (!Array.isArray(results.runs)) errors.push('runs must be an array');
  if (typeof results.maxRuns !== 'number') errors.push('maxRuns must be a number');
  if (typeof results.maxEstimatedCostUsd !== 'number') errors.push('maxEstimatedCostUsd must be a number');
  if (typeof results.estimatedCostUsd !== 'number') errors.push('estimatedCostUsd must be a number');
  if (typeof results.confirmLive !== 'boolean') errors.push('confirmLive must be a boolean');
  if (!isRecord(results.transcriptCapability)) errors.push('transcriptCapability is required');
  if (!Array.isArray(results.arms) || results.arms.length === 0) errors.push('arms must include at least one arm');
  if (Array.isArray(results.runs)) {
    results.runs.forEach((run, index) => {
      const path = `runs[${index}]`;
      if (!isRecord(run)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!hasText(run.blockId)) errors.push(`${path}.blockId is required`);
      if (!ARM_IDS.includes(run.armId)) errors.push(`${path}.armId must match a benchmark arm id`);
      if (!RELIABILITY_STATUSES.includes(run.status)) errors.push(`${path}.status must be a reliability status`);
      for (const field of ['setupDurationMs', 'queryDurationMs', 'costUsd']) {
        if (typeof run[field] !== 'number' || run[field] < 0) errors.push(`${path}.${field} must be a non-negative number`);
      }
    });
  }
  if (Array.isArray(results.arms)) {
    const armIds = results.arms.map((arm) => arm?.id).filter(Boolean);
    if (!sameSet(armIds, ARM_IDS)) errors.push(`arms must include exactly ${ARM_IDS.join(', ')}`);
    results.arms.forEach((arm, index) => {
      if (!Array.isArray(arm?.allowedTools)) errors.push(`arms[${index}].allowedTools must be an array`);
      if (!Array.isArray(arm?.disallowedTools)) errors.push(`arms[${index}].disallowedTools must be an array`);
      if (!hasText(arm?.instructionSurface)) errors.push(`arms[${index}].instructionSurface is required`);
    });
  }
  return errors;
}

function parseArgs(argv) {
  const args = { profile: 'smoke', validate: false, fromScenarios: DEFAULT_FIXTURE, fromResults: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') args.profile = argv[++i] ?? '';
    else if (arg === '--validate') args.validate = true;
    else if (arg === '--from-scenarios') args.fromScenarios = argv[++i] ?? '';
    else if (arg === '--from-results') args.fromResults = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.fromResults) {
    if (!existsSync(args.fromResults)) throw new Error(`results file not found: ${args.fromResults}`);
    const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
    const errors = validateAnswerQualityResults(results);
    if (errors.length > 0) return { status: 1, stdout: '', stderr: `${errors.join('\n')}\n` };
    if (args.out) {
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, 'answer-quality-results.validated.json'), `${JSON.stringify(results, null, 2)}\n`);
    }
    return { status: 0, stdout: `${JSON.stringify({ ok: true, schemaName: RESULTS_SCHEMA, reportSchemaName: REPORT_SCHEMA }, null, 2)}\n`, stderr: '' };
  }
  const matrix = loadScenarioMatrix(args.fromScenarios);
  const errors = validateScenarioMatrix(matrix, { profile: args.profile, ...validationOptionsForScenarioFile(args.fromScenarios) });
  if (errors.length > 0) return { status: 1, stdout: '', stderr: `${errors.join('\n')}\n` };
  const summary = buildProfileSummary(matrix, args.profile);
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, `answer-quality-${args.profile}-plan.json`), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return { status: 0, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };
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
