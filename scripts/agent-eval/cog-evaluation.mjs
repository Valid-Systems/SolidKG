#!/usr/bin/env node
// Offline schema helper for Code-on-Graph adoption experiments.
// It emits and validates deterministic evaluation metadata only; it never launches agents.
import { existsSync, readFileSync, writeFileSync } from 'fs';

export const SCHEMA_NAME = 'solidkg.cog-adoption-evaluation.v1';
export const LOCAL_SCHEMA_NAME = 'solidkg.cog-local-evaluation.v1';

export const SURVIVING_CANDIDATES = [
  'deterministic-typed-summaries',
  'evidence-utility-diagnostic',
  'deterministic-failure-hints',
  'offline-semantic-negative-control',
  'offline-query-plan-harness',
];

export const FORBIDDEN_MECHANISMS = [
  'runtime-llm-planning',
  'llm-generated-user-facing-code',
  'sandbox-self-correction',
  'tur-primary-metric',
  'semantic-traversal-replacement',
  'kgqa-direct-evidence',
];

const PRIMARY_METRICS = [
  'readCount',
  'grepCount',
  'answerCompleteness',
  'wallClockMs',
  'mcpCalls',
  'payloadBytes',
  'sourceFidelity',
];

const ABSOLUTE_KILL_CONDITIONS = [
  'fabricated_source_path',
  'unsupported_inferred_edge',
  'stale_file_regression',
  'ambiguity_regression',
];

const LOCAL_MEASUREMENTS = [
  'failure-situations',
  'stability-overlap',
  'raw-count-baseline',
  'high-fanout-payload-pain',
  'tool-call-latency-gate',
  'semantic-negative-controls',
  'candidate-gates',
];

const EXTERNAL_AB_PLACEHOLDERS = [
  'real-agent-read-grep-reduction',
  'wall-clock-delta',
  'answer-completeness-human-score',
];

function overlapAcrossRuns(runs, field) {
  const sets = runs.map((run) => new Set(run[field]));
  const union = new Set(sets.flatMap((set) => [...set]));
  if (union.size === 0) return 1;
  const intersection = [...union].filter((item) => sets.every((set) => set.has(item)));
  return Number((intersection.length / union.size).toFixed(3));
}

function candidate(id, description, simplerAlternative) {
  return {
    id,
    status: 'experiment_only',
    description,
    compareAgainst: ['current-main', simplerAlternative],
    primaryMetrics: PRIMARY_METRICS,
    passGate: 'Adopt only if median of at least 4 runs/arm improves Read/Grep avoidance and answer completeness versus current main and the simpler deterministic alternative without triggering absolute kill conditions.',
    killGate: 'Kill if it increases Read/Grep, loses source fidelity, invents unsupported graph facts, or requires runtime LLM planning or user-facing generated executable code.',
  };
}

export function sampleReport() {
  return {
    schemaName: SCHEMA_NAME,
    generatedAt: '2026-06-04T00:00:00.000Z',
    scope: 'Full deterministic Code-on-Graph adoption evaluation for SolidKG. Runtime CoG mechanisms are explicitly excluded.',
    exclusions: FORBIDDEN_MECHANISMS,
    globalProofGate: {
      baselineArms: ['current-main', 'simpler-deterministic-alternative', 'candidate'],
      runs: {
        minimumRunsPerArm: 4,
        summaryStatistic: 'median_with_range',
      },
      primaryMetrics: PRIMARY_METRICS,
      secondaryDiagnostics: ['tokens', 'costUsd', 'evidenceUtilityScore', 'failureHintSpecificity'],
      absoluteKillConditions: ABSOLUTE_KILL_CONDITIONS,
    },
    candidates: [
      candidate(
        'deterministic-typed-summaries',
        'Schema-compressed views over existing AST graph facts for high-fanout source and relation output.',
        'larger existing solidkg_explore/context payloads with no typed compression',
      ),
      candidate(
        'evidence-utility-diagnostic',
        'SolidKG-native utility score for evidence sufficiency, used only as a secondary diagnostic.',
        'existing Read/Grep/tool-call metrics only',
      ),
      candidate(
        'deterministic-failure-hints',
        'Rule-derived explanations for ambiguity, stale files, skipped source, truncation, or heuristic-only edges.',
        'existing terse source-completeness labels',
      ),
      candidate(
        'offline-semantic-negative-control',
        'Offline semantic retrieval/ranking trial used as a negative control and never as production graph traversal replacement.',
        'current lexical/structural ranking',
      ),
      candidate(
        'offline-query-plan-harness',
        'Offline generated query-plan/script harness for deterministic evaluation probes only; outputs are never user-facing executable code.',
        'hand-authored deterministic probe scripts',
      ),
    ],
    artifacts: {
      planPath: 'docs/design/cog-adoption-evaluation-plan.md',
      sampleEvidencePath: '.omo/evidence/cog-adoption-evaluation-sample.json',
      corpusManifest: 'fixtures/evaluation-corpus/manifest.json',
    },
  };
}

export function localEvaluationReport() {
  const stabilityRuns = [
    {
      runId: 'local-r1-current-main',
      citedFiles: ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'],
      citedSymbols: ['CheckoutService', 'PaymentGateway', 'chargeCard', 'ReceiptMailer', 'sendReceipt'],
    },
    {
      runId: 'local-r2-current-main',
      citedFiles: ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'],
      citedSymbols: ['CheckoutService', 'PaymentGateway', 'chargeCard', 'ReceiptMailer', 'sendReceipt'],
    },
    {
      runId: 'local-r3-simpler-alternative',
      citedFiles: ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'],
      citedSymbols: ['CheckoutService', 'PaymentGateway', 'chargeCard', 'ReceiptMailer', 'sendReceipt'],
    },
    {
      runId: 'local-r4-candidate-hints',
      citedFiles: ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'],
      citedSymbols: ['CheckoutService', 'PaymentGateway', 'chargeCard', 'ReceiptMailer', 'sendReceipt'],
    },
  ];
  const fileOverlap = overlapAcrossRuns(stabilityRuns, 'citedFiles');
  const symbolOverlap = overlapAcrossRuns(stabilityRuns, 'citedSymbols');

  return {
    schemaName: LOCAL_SCHEMA_NAME,
    reportKind: 'local-deterministic-evaluation',
    generatedAt: '2026-06-04T00:00:00.000Z',
    scope: 'Local deterministic CoG follow-up evaluation. This report measures offline fixture behavior only and does not claim real agent A/B wins.',
    measuredLocally: LOCAL_MEASUREMENTS,
    externalAbPlaceholders: EXTERNAL_AB_PLACEHOLDERS,
    forbiddenMechanisms: FORBIDDEN_MECHANISMS,
    failureSituations: [
      {
        id: 'fs-ambiguous-payment-gateway',
        ruleId: 'cog.failure.ambiguous-symbol',
        failureType: 'ambiguous-symbol',
        state: 'detected',
        detectedAt: '2026-06-04T00:00:00.000Z',
        validUntil: '2026-06-04T23:59:59.999Z',
        evidence: {
          files: ['src/payments.ts'],
          symbols: ['PaymentGateway', 'chargeCard'],
          sourceLinked: false,
          syntheticFixture: true,
        },
        deterministicNextAction: 'ask-for-qualified-symbol-or-run-focused-solidkg-search',
        transitions: [
          {
            from: null,
            to: 'detected',
            actor: 'local-eval-fixture',
            transitionedAt: '2026-06-04T00:00:00.000Z',
            reason: 'Synthetic ambiguity fixture creates a persistent failure situation instead of a transient label.',
          },
        ],
      },
      {
        id: 'fs-high-fanout-output-shape',
        ruleId: 'cog.failure.payload-shape',
        failureType: 'payload-shape-not-proven',
        state: 'detected',
        detectedAt: '2026-06-04T00:00:00.000Z',
        validUntil: '2026-06-04T23:59:59.999Z',
        evidence: {
          files: ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'],
          symbols: ['CheckoutService', 'PaymentGateway', 'ReceiptMailer'],
          sourceLinked: false,
          syntheticFixture: true,
        },
        deterministicNextAction: 'defer-typed-summaries-until-real-fallback-read-pain-is-measured',
        transitions: [
          {
            from: null,
            to: 'detected',
            actor: 'local-eval-fixture',
            transitionedAt: '2026-06-04T00:00:00.000Z',
            reason: 'Local fixture did not prove payload shape causes fallback reads.',
          },
        ],
      },
    ],
    stabilityOverlap: {
      metric: 'all-run-intersection-over-union',
      runs: stabilityRuns,
      fileOverlap,
      symbolOverlap,
      stable: fileOverlap === 1 && symbolOverlap === 1,
      interpretation: 'Local deterministic fixture is stable; this does not replace real multi-run agent A/B overlap checks.',
    },
    rawCountBaseline: {
      arms: [
        {
          arm: 'current-main',
          readCount: 0,
          grepCount: 0,
          mcpCalls: 1,
          payloadBytes: 720,
          answerCompleteness: 'fixture-complete',
          sourceFidelity: true,
        },
        {
          arm: 'simpler-deterministic-alternative',
          readCount: 0,
          grepCount: 0,
          mcpCalls: 1,
          payloadBytes: 640,
          answerCompleteness: 'fixture-complete',
          sourceFidelity: true,
        },
        {
          arm: 'candidate',
          readCount: 0,
          grepCount: 0,
          mcpCalls: 1,
          payloadBytes: 700,
          answerCompleteness: 'fixture-complete',
          sourceFidelity: true,
        },
      ],
      interpretation: 'Raw counts already explain this synthetic fixture; evidence utility must beat this baseline on harder held-out failures before it is useful.',
    },
    highFanoutPayloadPain: {
      decision: 'defer',
      reason: 'Local deterministic fixture does not show fallback reads caused by output verbosity. Token or byte shaving alone is not a win.',
      measuredPayloadBytes: 720,
      simplerAlternativePayloadBytes: 640,
      fallbackReadsCausedByPayload: false,
    },
    overheadGate: {
      gateKind: 'eval-only-overhead-budget',
      productionAdoptionClaim: false,
      predictedAdditionalAgentToolCalls: 0,
      fallbackReadGrepRisk: 0,
      creationUseAdditionalLatencyMs: 0,
      mcpCalls: {
        currentMain: 1,
        candidate: 1,
        maxAllowedCandidate: 1,
      },
      syntheticLatencyMs: {
        median: 4,
        p95: 8,
        maxMedian: 5,
        maxP95: 10,
      },
      interpretation: 'Eval-only failure hints must not predict extra LLM/agent tool calls, fallback reads/greps, or added SolidKG creation/use latency.',
    },
    semanticNegativeControls: [
      {
        id: 'semantic-only-ranking-control',
        mode: 'offline-only',
        sourceEvidence: false,
        productionTraversal: false,
        decision: 'safety-gate-only',
        reason: 'Semantic-only ranking is kept as an offline negative control so it cannot add runtime tool calls or replace source-linked graph traversal.',
      },
    ],
    candidateGates: [
      {
        candidate: 'deterministic-failure-hints',
        status: 'continue-eval-only',
        decision: 'test-first',
        reason: 'Persistent FailureSituation records and deterministic next actions directly target known fallback causes.',
        evidence: ['failure-situations'],
      },
      {
        candidate: 'deterministic-typed-summaries',
        status: 'defer',
        decision: 'do-not-implement-now',
        reason: 'No local evidence that high-fanout payload shape causes fallback reads; typed views must beat simpler ordering/budget alternatives first.',
        evidence: ['high-fanout-payload-pain', 'raw-count-baseline'],
      },
      {
        candidate: 'evidence-utility-diagnostic',
        status: 'defer',
        decision: 'offline-only-until-raw-counts-fail',
        reason: 'Raw counts explain this local fixture; a utility score must predict actionable failures better than raw counts before use.',
        evidence: ['raw-count-baseline'],
      },
      {
        candidate: 'offline-semantic-negative-control',
        status: 'continue-eval-only',
        decision: 'keep-as-safety-gate',
        reason: 'Useful as an adversarial source-fidelity check, not as production traversal.',
        evidence: ['failure-situations'],
      },
      {
        candidate: 'offline-query-plan-harness',
        status: 'defer',
        decision: 'wait-for-agent-ab-gap',
        reason: 'No local proof that deterministic replay predicts real agent behavior yet.',
        evidence: ['externalAbPlaceholders'],
      },
    ],
  };
}

function validateReport(report) {
  const errors = [];

  if (!report || typeof report !== 'object') return ['report must be a JSON object'];
  if (report.schemaName === LOCAL_SCHEMA_NAME) return validateLocalReport(report);
  if (report.schemaName !== SCHEMA_NAME) errors.push(`schemaName must be ${SCHEMA_NAME}`);

  if (!Array.isArray(report.exclusions)) {
    errors.push('exclusions must be an array');
  } else {
    for (const mechanism of FORBIDDEN_MECHANISMS) {
      if (!report.exclusions.includes(mechanism)) errors.push(`exclusions must include ${mechanism}`);
    }
  }

  if (!Array.isArray(report.candidates)) {
    errors.push('candidates must be an array');
  } else {
    const ids = report.candidates.map((candidate) => candidate.id);
    for (const id of SURVIVING_CANDIDATES) {
      if (!ids.includes(id)) errors.push(`candidates must include ${id}`);
    }
    for (const candidate of report.candidates) {
      if (!SURVIVING_CANDIDATES.includes(candidate.id)) errors.push(`candidate ${candidate.id} is not in the surviving candidate set`);
      if (FORBIDDEN_MECHANISMS.includes(candidate.id)) errors.push(`candidate ${candidate.id} is forbidden`);
      if (candidate.status !== 'experiment_only') errors.push(`candidate ${candidate.id} status must be experiment_only`);
      if (!Array.isArray(candidate.primaryMetrics) || candidate.primaryMetrics.length === 0) errors.push(`candidate ${candidate.id} must define primaryMetrics`);
      if (typeof candidate.passGate !== 'string' || candidate.passGate.length === 0) errors.push(`candidate ${candidate.id} must define passGate`);
      if (typeof candidate.killGate !== 'string' || candidate.killGate.length === 0) errors.push(`candidate ${candidate.id} must define killGate`);
    }
  }

  if (!report.globalProofGate || typeof report.globalProofGate !== 'object') {
    errors.push('globalProofGate must be an object');
  } else {
    if (report.globalProofGate.runs?.minimumRunsPerArm < 4) errors.push('globalProofGate.runs.minimumRunsPerArm must be at least 4');
    for (const metric of PRIMARY_METRICS) {
      if (!report.globalProofGate.primaryMetrics?.includes(metric)) errors.push(`globalProofGate.primaryMetrics must include ${metric}`);
    }
    for (const condition of ABSOLUTE_KILL_CONDITIONS) {
      if (!report.globalProofGate.absoluteKillConditions?.includes(condition)) errors.push(`globalProofGate.absoluteKillConditions must include ${condition}`);
    }
  }

  return errors;
}

function validateLocalReport(report) {
  const errors = [];

  if (report.reportKind !== 'local-deterministic-evaluation') errors.push('reportKind must be local-deterministic-evaluation');
  for (const section of LOCAL_MEASUREMENTS) {
    if (!report.measuredLocally?.includes(section)) errors.push(`measuredLocally must include ${section}`);
  }
  for (const placeholder of EXTERNAL_AB_PLACEHOLDERS) {
    if (!report.externalAbPlaceholders?.includes(placeholder)) errors.push(`externalAbPlaceholders must include ${placeholder}`);
  }
  for (const mechanism of FORBIDDEN_MECHANISMS) {
    if (!report.forbiddenMechanisms?.includes(mechanism)) errors.push(`forbiddenMechanisms must include ${mechanism}`);
  }
  if (!Array.isArray(report.failureSituations) || report.failureSituations.length === 0) errors.push('failureSituations must be a non-empty array');
  for (const [index, situation] of (report.failureSituations ?? []).entries()) {
    if (typeof situation.id !== 'string' || situation.id.length === 0) errors.push(`failureSituations[${index}].id must be a non-empty string`);
    if (typeof situation.failureType !== 'string' || situation.failureType.length === 0) errors.push(`failureSituations[${index}].failureType must be a non-empty string`);
    if (typeof situation.state !== 'string' || situation.state.length === 0) errors.push(`failureSituations[${index}].state must be a non-empty string`);
    if (!Array.isArray(situation.evidence?.files) || situation.evidence.files.length === 0) errors.push(`failureSituations[${index}].evidence.files must be non-empty`);
    if (!Array.isArray(situation.evidence?.symbols) || situation.evidence.symbols.length === 0) errors.push(`failureSituations[${index}].evidence.symbols must be non-empty`);
    if (situation.evidence?.sourceLinked !== false) errors.push(`failureSituations[${index}].evidence.sourceLinked must be false for synthetic local fixtures`);
    if (situation.evidence?.syntheticFixture !== true) errors.push(`failureSituations[${index}].evidence.syntheticFixture must be true`);
    if (!Array.isArray(situation.transitions) || situation.transitions.length === 0) errors.push(`failureSituations[${index}].transitions must be non-empty`);
  }
  if (!Array.isArray(report.stabilityOverlap?.runs) || report.stabilityOverlap.runs.length < 2) errors.push('stabilityOverlap.runs must contain at least two runs');
  for (const metric of ['fileOverlap', 'symbolOverlap']) {
    if (typeof report.stabilityOverlap?.[metric] !== 'number' || report.stabilityOverlap[metric] < 0 || report.stabilityOverlap[metric] > 1) {
      errors.push(`stabilityOverlap.${metric} must be between 0 and 1`);
    }
  }
  const rawArms = report.rawCountBaseline?.arms?.map((arm) => arm.arm).sort() ?? [];
  for (const arm of ['candidate', 'current-main', 'simpler-deterministic-alternative']) {
    if (!rawArms.includes(arm)) errors.push(`rawCountBaseline.arms must include ${arm}`);
  }
  if (report.overheadGate?.productionAdoptionClaim !== false) errors.push('overheadGate.productionAdoptionClaim must be false');
  if (report.overheadGate?.predictedAdditionalAgentToolCalls !== 0) errors.push('overheadGate.predictedAdditionalAgentToolCalls must be 0');
  if (report.overheadGate?.fallbackReadGrepRisk !== 0) errors.push('overheadGate.fallbackReadGrepRisk must be 0');
  if (report.overheadGate?.creationUseAdditionalLatencyMs !== 0) errors.push('overheadGate.creationUseAdditionalLatencyMs must be 0');
  if (typeof report.overheadGate?.mcpCalls?.candidate !== 'number') {
    errors.push('overheadGate.mcpCalls.candidate must be a number');
  } else {
    if (report.overheadGate.mcpCalls.candidate > report.overheadGate.mcpCalls.maxAllowedCandidate) errors.push('overheadGate.mcpCalls.candidate must not exceed maxAllowedCandidate');
    if (report.overheadGate.mcpCalls.candidate > report.overheadGate.mcpCalls.currentMain) errors.push('overheadGate.mcpCalls.candidate must not exceed currentMain');
  }
  if (typeof report.overheadGate?.syntheticLatencyMs?.median !== 'number') {
    errors.push('overheadGate.syntheticLatencyMs.median must be a number');
  } else if (report.overheadGate.syntheticLatencyMs.median > report.overheadGate.syntheticLatencyMs.maxMedian) {
    errors.push('overheadGate.syntheticLatencyMs.median must not exceed maxMedian');
  }
  if (typeof report.overheadGate?.syntheticLatencyMs?.p95 !== 'number') {
    errors.push('overheadGate.syntheticLatencyMs.p95 must be a number');
  } else if (report.overheadGate.syntheticLatencyMs.p95 > report.overheadGate.syntheticLatencyMs.maxP95) {
    errors.push('overheadGate.syntheticLatencyMs.p95 must not exceed maxP95');
  }
  if (!Array.isArray(report.semanticNegativeControls) || report.semanticNegativeControls.length === 0) errors.push('semanticNegativeControls must be a non-empty array');
  for (const [index, control] of (report.semanticNegativeControls ?? []).entries()) {
    if (control.mode !== 'offline-only') errors.push(`semanticNegativeControls[${index}].mode must be offline-only`);
    if (control.sourceEvidence !== false) errors.push(`semanticNegativeControls[${index}].sourceEvidence must be false`);
    if (control.productionTraversal !== false) errors.push(`semanticNegativeControls[${index}].productionTraversal must be false`);
  }
  const gateCandidates = report.candidateGates?.map((gate) => gate.candidate) ?? [];
  for (const candidateId of SURVIVING_CANDIDATES) {
    if (!gateCandidates.includes(candidateId)) errors.push(`candidateGates must include ${candidateId}`);
  }
  for (const gate of report.candidateGates ?? []) {
    if (!SURVIVING_CANDIDATES.includes(gate.candidate)) errors.push(`candidate gate ${gate.candidate} is not in the surviving candidate set`);
    if (FORBIDDEN_MECHANISMS.includes(gate.candidate)) errors.push(`candidate gate ${gate.candidate} is forbidden`);
    if (gate.status === 'adoption-ready') errors.push(`candidate ${gate.candidate} must not be adoption-ready in local deterministic report`);
  }

  return errors;
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  console.error('usage: node scripts/agent-eval/cog-evaluation.mjs --sample [--out <path>]');
  console.error('   or: node scripts/agent-eval/cog-evaluation.mjs --run-local [--out <path>]');
  console.error('   or: node scripts/agent-eval/cog-evaluation.mjs --validate <report.json> [--out <path>]');
}

const args = process.argv.slice(2);
const outputPath = takeFlag(args, '--out');
const validatePath = takeFlag(args, '--validate');
const wantsSample = args.includes('--sample');
const wantsRunLocal = args.includes('--run-local');

if ((!wantsSample && !wantsRunLocal && !validatePath) || [wantsSample, wantsRunLocal, Boolean(validatePath)].filter(Boolean).length !== 1) {
  usage();
  process.exit(2);
}

if (validatePath && !existsSync(validatePath)) {
  usage();
  process.exit(2);
}

const report = wantsSample ? sampleReport() : wantsRunLocal ? localEvaluationReport() : JSON.parse(readFileSync(validatePath, 'utf8'));
const errors = validateReport(report);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

if ((wantsSample || wantsRunLocal) && !outputPath) {
  printJson(report);
} else {
  printJson({
    ok: true,
    schemaName: report.schemaName,
    validatedCandidates: report.candidates?.length ?? report.candidateGates?.length ?? 0,
    outputPath,
  });
}
