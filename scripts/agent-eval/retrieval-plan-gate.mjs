#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

export const SCHEMA_NAME = 'solidkg.retrieval-improvement-candidate.v1';

const FAILURE_CLASSES = new Set([
  'dynamic_path_gap',
  'trace_explore_insufficiency',
  'scip_fidelity_gap',
  'ranking_wrong_symbol',
  'missing_relation_family',
  'sync_freshness_gap',
  'benchmark_claim_drift',
]);

const WORKSTREAMS = new Set([
  'deterministic_dynamic_connectivity_bridges',
  'trace_explore_sufficiency',
  'additive_scip_precision',
  'deterministic_explainable_ranking',
  'narrow_relation_family',
  'sync_freshness_correctness',
]);

const NUMERIC_METRICS = [
  'readCount',
  'grepCount',
  'toolCalls',
  'solidkgToolCalls',
  'wallClockMs',
  'payloadBytes',
  'graphGrowthPercent',
];

const FIDELITY_METRICS = ['answerCompleteness', 'sourceReferenceFidelity'];
const VERIFICATION_COMMANDS = ['red', 'green', 'surface', 'evaluation', 'regression'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addRequiredText(errors, record, key, path) {
  if (!hasText(record[key])) errors.push(`${path}.${key} is required`);
}

function validateMetrics(errors, candidate, key) {
  const metrics = candidate[key];
  if (!isRecord(metrics)) {
    errors.push(`${key} is required`);
    return;
  }

  for (const metric of NUMERIC_METRICS) {
    const value = metrics[metric];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`${key}.${metric} must be a non-negative number`);
    }
  }

  for (const metric of FIDELITY_METRICS) addRequiredText(errors, metrics, metric, key);
}

function validateControls(errors, candidate) {
  if (!Array.isArray(candidate.controls) || candidate.controls.length === 0) {
    errors.push('controls must include at least one item');
    return;
  }

  candidate.controls.forEach((control, index) => {
    if (!isRecord(control)) {
      errors.push(`controls[${index}] must be an object`);
      return;
    }
    addRequiredText(errors, control, 'repo', `controls[${index}]`);
    addRequiredText(errors, control, 'prompt', `controls[${index}]`);
    addRequiredText(errors, control, 'expected', `controls[${index}]`);
  });
}

function validateVerificationCommands(errors, candidate) {
  const commands = candidate.verificationCommands;
  if (!isRecord(commands)) {
    errors.push('verificationCommands is required');
    return;
  }
  for (const command of VERIFICATION_COMMANDS) addRequiredText(errors, commands, command, 'verificationCommands');
}

function validateImprovementDirection(errors, candidate) {
  const baseline = candidate.baselineMetrics;
  const target = candidate.targetMetrics;
  if (!isRecord(baseline) || !isRecord(target)) return;

  for (const metric of ['readCount', 'grepCount', 'toolCalls', 'wallClockMs', 'payloadBytes']) {
    if (typeof baseline[metric] === 'number' && typeof target[metric] === 'number' && target[metric] > baseline[metric]) {
      errors.push(`targetMetrics.${metric} must not exceed baselineMetrics.${metric}`);
    }
  }

  if (typeof target.graphGrowthPercent === 'number' && target.graphGrowthPercent > 10) {
    errors.push('targetMetrics.graphGrowthPercent must be 10 or less');
  }
}

function validateAdaptivePolicy(errors, candidate) {
  if (candidate.adaptivePolicy === undefined) return;
  const policy = candidate.adaptivePolicy;
  if (!isRecord(policy)) {
    errors.push('adaptivePolicy must be an object');
    return;
  }
  if (policy.enabledByDefault !== false) errors.push('adaptivePolicy.enabledByDefault must be false');
  if (policy.canSuppressFallbackMetrics !== false) errors.push('adaptivePolicy.canSuppressFallbackMetrics must be false');
  if (!Array.isArray(policy.allowedStrategies) || policy.allowedStrategies.length === 0) {
    errors.push('adaptivePolicy.allowedStrategies must include at least one item');
  } else {
    policy.allowedStrategies.forEach((strategy, index) => {
      if (!hasText(strategy)) errors.push(`adaptivePolicy.allowedStrategies[${index}] is required`);
    });
  }
  addRequiredText(errors, policy, 'provenance', 'adaptivePolicy');
  if (typeof policy.maxPayloadBytes !== 'number' || !Number.isFinite(policy.maxPayloadBytes) || policy.maxPayloadBytes < 0) {
    errors.push('adaptivePolicy.maxPayloadBytes must be a non-negative number');
  } else if (isRecord(candidate.targetMetrics) && typeof candidate.targetMetrics.payloadBytes === 'number' && policy.maxPayloadBytes > candidate.targetMetrics.payloadBytes) {
    errors.push('adaptivePolicy.maxPayloadBytes must not exceed targetMetrics.payloadBytes');
  }
}

export function validateCandidate(candidate) {
  const errors = [];
  if (!isRecord(candidate)) return ['candidate must be a JSON object'];

  if (candidate.schemaName !== SCHEMA_NAME) errors.push(`schemaName must be ${SCHEMA_NAME}`);
  addRequiredText(errors, candidate, 'id', 'candidate');
  addRequiredText(errors, candidate, 'title', 'candidate');
  addRequiredText(errors, candidate, 'scopeBoundary', 'candidate');

  if (!FAILURE_CLASSES.has(candidate.failureClass)) errors.push(`failureClass must be one of ${Array.from(FAILURE_CLASSES).join(', ')}`);
  if (!WORKSTREAMS.has(candidate.workstream)) errors.push(`workstream must be one of ${Array.from(WORKSTREAMS).join(', ')}`);

  const failure = candidate.reproducibleFailure;
  if (!isRecord(failure)) {
    errors.push('reproducibleFailure is required');
  } else {
    addRequiredText(errors, failure, 'repo', 'reproducibleFailure');
    addRequiredText(errors, failure, 'repoRevision', 'reproducibleFailure');
    addRequiredText(errors, failure, 'prompt', 'reproducibleFailure');
    addRequiredText(errors, failure, 'observedFailure', 'reproducibleFailure');
    addRequiredText(errors, failure, 'currentMainCommand', 'reproducibleFailure');
  }

  validateMetrics(errors, candidate, 'baselineMetrics');
  validateMetrics(errors, candidate, 'targetMetrics');
  validateControls(errors, candidate);

  if (!Array.isArray(candidate.killCriteria) || candidate.killCriteria.length === 0) {
    errors.push('killCriteria must include at least one item');
  } else {
    candidate.killCriteria.forEach((criterion, index) => {
      if (!hasText(criterion)) errors.push(`killCriteria[${index}] is required`);
    });
  }

  validateVerificationCommands(errors, candidate);
  validateImprovementDirection(errors, candidate);
  validateAdaptivePolicy(errors, candidate);

  return errors;
}

function loadCandidate(filePath) {
  if (!hasText(filePath)) throw new Error('usage: node scripts/agent-eval/retrieval-plan-gate.mjs <candidate.json>');
  if (!existsSync(filePath)) throw new Error(`candidate file does not exist: ${filePath}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function printSummary(candidate, errors) {
  if (errors.length > 0) {
    console.log('status: fail');
    if (hasText(candidate?.id)) console.log(`candidate: ${candidate.id}`);
    return;
  }

  console.log('status: pass');
  console.log(`candidate: ${candidate.id}`);
  console.log(`failureClass: ${candidate.failureClass}`);
  console.log(`workstream: ${candidate.workstream}`);
  console.log(`readCount: ${candidate.baselineMetrics.readCount} -> ${candidate.targetMetrics.readCount}`);
  console.log(`toolCalls: ${candidate.baselineMetrics.toolCalls} -> ${candidate.targetMetrics.toolCalls}`);
  console.log(`wallClockMs: ${candidate.baselineMetrics.wallClockMs} -> ${candidate.targetMetrics.wallClockMs}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('retrieval-plan-gate.mjs')) {
  let candidate;
  try {
    candidate = loadCandidate(process.argv[2]);
  } catch (error) {
    console.log('status: fail');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const errors = validateCandidate(candidate);
  printSummary(candidate, errors);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}
