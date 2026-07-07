#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARM_IDS, PROFILES, buildPlannedRuns, loadScenarioMatrix, validateScenarioMatrix, validationOptionsForScenarioFile } from './answer-scenarios.mjs';
import { getAnswerArms, buildSetupContract, buildArmCommand, classifySetupResult } from './answer-arms.mjs';
import { writeAnswerQualityReport } from './report-answer-quality.mjs';
import { buildRunPlan, runDryRun, runPreflight, writeIsolatedConfig } from './opencode-runner.mjs';
import { parseOpenCodeTranscriptFile, parseOpenCodeTranscriptText } from './parse-opencode-transcript.mjs';
import { scoreResults } from './score-answer-quality.mjs';
import { attachBenchmarkPassport, collectIndexMetadata } from './benchmark-passport.mjs';
import { persistEvidenceDossier } from './answer-evidence-contract.mjs';

export const ORCHESTRATOR_SCHEMA = 'solidkg.llm-answer-quality.orchestrator.v1';
const DEFAULT_SCENARIOS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'agent-eval', 'answer-quality', 'sample-scenarios.json');
const DEFAULT_COST_PER_RUN_USD = 0.05;
const PARTIAL_RESULTS_FILE = 'live-results.partial.json';

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseArgs(argv) {
  const args = { profile: 'smoke', repeats: null, dryRun: false, preflightOnly: false, fromResults: '', out: '', repoCache: resolve('tmp', 'solidkg-corpus'), opencodeBin: process.env.OPENCODE_BIN || 'opencode', solidkgBin: process.env.SOLIDKG_BIN || 'solidkg', model: process.env.OPENCODE_MODEL || 'openai/gpt-5.5', variant: process.env.OPENCODE_VARIANT || '', timeoutMs: 900000, skipJudge: false, arm: [], seed: 'answer-quality-default', confirmLive: false, maxRuns: null, maxEstimatedCostUsd: null, fromScenarios: DEFAULT_SCENARIOS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') args.profile = argv[++i] ?? '';
    else if (arg === '--repeats') args.repeats = Number(argv[++i] ?? '0');
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--preflight-only') args.preflightOnly = true;
    else if (arg === '--from-results') args.fromResults = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--repo-cache') args.repoCache = argv[++i] ?? '';
    else if (arg === '--opencode-bin') args.opencodeBin = argv[++i] ?? '';
    else if (arg === '--solidkg-bin') args.solidkgBin = argv[++i] ?? '';
    else if (arg === '--model') args.model = argv[++i] ?? '';
    else if (arg === '--variant') args.variant = argv[++i] ?? '';
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] ?? args.timeoutMs);
    else if (arg === '--skip-judge') args.skipJudge = true;
    else if (arg === '--arm') args.arm.push(argv[++i] ?? '');
    else if (arg === '--seed') args.seed = argv[++i] ?? '';
    else if (arg === '--confirm-live') args.confirmLive = true;
    else if (arg === '--max-runs') args.maxRuns = Number(argv[++i] ?? args.maxRuns);
    else if (arg === '--max-estimated-cost-usd') args.maxEstimatedCostUsd = Number(argv[++i] ?? args.maxEstimatedCostUsd);
    else if (arg === '--from-scenarios') args.fromScenarios = argv[++i] ?? '';
  }
  return args;
}

function hashSeed(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296);
  };
}

function shuffle(values, seed) {
  const random = rng(seed);
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectedArms(args) {
  const arms = args.arm.length > 0 ? args.arm : ARM_IDS;
  for (const arm of arms) if (!ARM_IDS.includes(arm)) throw new Error(`--arm must be one of ${ARM_IDS.join(', ')}`);
  return arms;
}

function applyRepeatOverride(baseRuns, repeats) {
  if (!Number.isFinite(repeats) || repeats <= 0) return baseRuns;
  const firstRepeat = baseRuns.filter((run) => run.repeat === 1);
  const runs = [];
  const byScenarioArm = firstRepeat.map((run) => ({ ...run }));
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const run of byScenarioArm) {
      const blockId = `${run.scenarioId}:r${repeat}`;
      runs.push({ ...run, repeat, blockId, id: `${blockId}:${run.armId}` });
    }
  }
  return runs;
}

export function planRuns({ matrix = loadScenarioMatrix(), profile = 'smoke', arms = ARM_IDS, repeats = null, seed = 'answer-quality-default' } = {}) {
  let runs = buildPlannedRuns(matrix, profile, arms);
  runs = applyRepeatOverride(runs, repeats);
  const byBlock = new Map();
  for (const run of runs) {
    if (!byBlock.has(run.blockId)) byBlock.set(run.blockId, []);
    byBlock.get(run.blockId).push(run);
  }
  const blockIds = shuffle([...byBlock.keys()], `${seed}:blocks`);
  return blockIds.flatMap((blockId) => shuffle(byBlock.get(blockId), `${seed}:${blockId}`));
}

function repoPathFor(matrix, repoCache, repoId) {
  const repo = matrix.repoMatrix.find((candidate) => candidate.id === repoId);
  return join(repoCache, repo?.id ?? repoId);
}

function safeRunId(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function resultStatusCode(result) {
  if (!result || typeof result !== 'object') return 1;
  if (typeof result.statusCode === 'number') return result.statusCode;
  if (typeof result.status === 'number') return result.status;
  return result.error ? 1 : 0;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cmdArg(value) {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : shellQuote(text);
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeConfiguredBin(bin) {
  const text = String(bin ?? '');
  if (!text) return 'solidkg';
  return /[\\/]/.test(text) || text.startsWith('.') ? resolve(text) : text;
}
function resolveWindowsBin(bin, env = process.env) {
  if (process.platform !== 'win32' || extname(bin) || /[\\/]/.test(bin)) return bin;
  const pathValue = env.Path ?? env.PATH ?? '';
  const extensions = ['.cmd', '.exe', '.bat', ''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${bin}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

function spawnCli(bin, argv, { cwd, timeoutMs, env = process.env }) {
  if (process.platform === 'win32') {
    if (!extname(bin) && !/[\\/]/.test(bin)) {
      const commandLine = [bin, ...argv.map(cmdArg)].join(' ');
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { cwd, encoding: 'utf8', timeout: timeoutMs, env });
    }
    const resolvedBin = resolveWindowsBin(bin, env);
    if (/\.(cmd|bat)$/i.test(resolvedBin)) {
      const commandLine = `call ${[resolvedBin, ...argv].map(cmdArg).join(' ')}`;
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { cwd, encoding: 'utf8', timeout: timeoutMs, env });
    }
    return spawnSync(resolvedBin, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env });
  }
  return spawnSync(bin, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env });
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return events;
}

function stderrToolEvents(stderr) {
  const events = [];
  for (const rawLine of String(stderr ?? '').split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    const mcpMatch = line.match(/^[⚙→]\s*([A-Za-z_][\w.-]*)\s*(\{.*\})?$/u);
    if (mcpMatch) {
      let input = null;
      if (mcpMatch[2]) {
        try { input = JSON.parse(mcpMatch[2]); } catch { input = mcpMatch[2]; }
      }
      events.push({ type: 'tool_call', tool: mcpMatch[1], input });
      continue;
    }
    const shellMatch = line.match(/^\$\s+(.+)$/);
    if (shellMatch) {
      const command = shellMatch[1];
      const peerMatch = command.match(/\b(tilth|cartog|sverklo)_wrapper\.mjs\b/i) ?? command.match(/\b(tilth|cartog|sverklo)\b/i);
      if (peerMatch) events.push({ type: 'tool_call', tool: `${peerMatch[1].toLowerCase()}_wrapper`, input: { command } });
      else events.push({ type: 'tool_call', tool: 'bash', input: { command } });
      continue;
    }
    const readMatch = line.match(/^(?:→\s*)?(Read)\s+(.+?)(?:\s+failed)?(?:\s+\[|$)/i);
    if (readMatch) events.push({ type: 'tool_call', tool: 'read', input: { path: readMatch[2] } });
  }
  return events;
}

export function transcriptTextFromOpenCode({ stdout, stderr }) {
  const stdoutEvents = parseJsonLines(stdout);
  const events = stdoutEvents ?? (String(stdout ?? '').trim() ? [{ type: 'final', content: String(stdout).trim() }] : []);
  events.push(...stderrToolEvents(stderr));
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export function defaultRunCommand({ command, cwd, timeoutMs }) {
  const [bin, ...argv] = command;
  const result = spawnCli(bin, argv, { cwd, timeoutMs });
  return { argv: command, statusCode: result.status ?? (result.error ? 1 : 0), stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function findSessionIdInText(text) {
  return String(text ?? '').match(/\bsession(?:\.id)?=?(ses_[A-Za-z0-9]+)\b/)?.[1]
    ?? String(text ?? '').match(/\bid=(ses_[A-Za-z0-9]+)\b/)?.[1]
    ?? null;
}

function sessionIdsFromText(text) {
  return new Set([...String(text ?? '').matchAll(/\b(ses_[A-Za-z0-9]+)\b/g)].map((match) => match[1]));
}

function listSessionIds({ bin, cwd, timeoutMs, env }) {
  const result = spawnCli(bin, ['session', 'list'], { cwd, encoding: 'utf8', timeout: timeoutMs, env });
  if ((result.status ?? (result.error ? 1 : 0)) !== 0) return new Set();
  return sessionIdsFromText(result.stdout ?? '');
}

function findSessionIdByTitle({ bin, title, cwd, timeoutMs, env }) {
  if (!title) return null;
  const result = spawnCli(bin, ['session', 'list'], { cwd, encoding: 'utf8', timeout: timeoutMs, env });
  if ((result.status ?? (result.error ? 1 : 0)) !== 0) return null;
  const line = String(result.stdout ?? '').split(/\r?\n/).find((candidate) => candidate.includes(title));
  return line?.match(/\b(ses_[A-Za-z0-9]+)\b/)?.[1] ?? null;
}

function findNewSessionId({ before, after }) {
  const added = [...after].filter((sessionId) => !before.has(sessionId));
  return added.length === 1 ? added[0] : null;
}

function exportSession({ bin, sessionId, cwd, timeoutMs, env }) {
  if (!sessionId) return null;
  const result = spawnCli(bin, ['export', sessionId], { cwd, encoding: 'utf8', timeout: timeoutMs, env });
  if ((result.status ?? (result.error ? 1 : 0)) !== 0) return null;
  return result.stdout ?? '';
}

export function defaultRunOpenCode({ bin, argv, cwd, timeoutMs, env }) {
  const mergedEnv = { ...process.env, ...env };
  const beforeSessionIds = listSessionIds({ bin, cwd, timeoutMs, env: mergedEnv });
  const result = spawnCli(bin, argv, { cwd, timeoutMs, env: mergedEnv });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const title = argValue(argv, '--title');
  const mergedOutput = `${stdout}\n${stderr}`;
  const sessionId = findSessionIdInText(mergedOutput)
    ?? findSessionIdByTitle({ bin, title, cwd, timeoutMs, env: mergedEnv })
    ?? findNewSessionId({ before: beforeSessionIds, after: listSessionIds({ bin, cwd, timeoutMs, env: mergedEnv }) });
  const sessionExportText = exportSession({ bin, sessionId, cwd, timeoutMs, env: mergedEnv });
  return { argv: [bin, ...argv], statusCode: result.status ?? (result.error ? 1 : 0), stdout, stderr, transcriptText: sessionExportText ?? transcriptTextFromOpenCode({ stdout, stderr }), sessionId, sessionExportText, errorCode: result.error?.code };
}

function defaultAdapters() {
  return { nowMs: Date.now, runSetupCommand: defaultRunCommand, runOpenCode: defaultRunOpenCode, parseTranscript: parseOpenCodeTranscriptFile, writeReport: writeAnswerQualityReport, runPreflight };
}

function liveResultsSkeleton({ args, plannedRuns }) {
  return {
    schemaName: 'solidkg.llm-answer-quality.results.v1',
    reportSchemaName: 'solidkg.llm-answer-quality.report.v1',
    profile: args.profile,
    seed: args.seed,
    maxRuns: Number.isFinite(args.maxRuns) ? args.maxRuns : plannedRuns.length,
    maxEstimatedCostUsd: Number.isFinite(args.maxEstimatedCostUsd) ? args.maxEstimatedCostUsd : plannedRuns.length * DEFAULT_COST_PER_RUN_USD,
    estimatedCostUsd: Number((plannedRuns.length * DEFAULT_COST_PER_RUN_USD).toFixed(2)),
    confirmLive: args.confirmLive,
    model: args.model,
    variant: args.variant,
    solidkgBin: args.solidkgBin,
    calibrationStatus: calibrationEvidenceOk(args) ? 'successful' : 'not_successful',
    smokeStatus: smokeEvidenceOk(args) ? 'successful' : 'not_successful',
    transcriptCapability: { status: 'available', reason: 'live_execution_parser' },
    plannedRunOrder: plannedRuns.map((run) => run.id),
    runs: [],
    arms: getAnswerArms(),
  };
}

function setupFailedRun({ run, setup, reason, repoPath, command, setupStartedMs = null, setupEndedMs = null }) {
  return {
    ...run,
    status: 'setup_failed',
    reliabilityStatus: 'setup_failed',
    setupStartedAt: isoFromMs(setupStartedMs),
    setupEndedAt: isoFromMs(setupEndedMs),
    setupDurationMs: Math.max(0, (setupEndedMs ?? 0) - (setupStartedMs ?? 0)),
    queryStartedAt: null,
    queryEndedAt: null,
    queryDurationMs: 0,
    costUsd: 0,
    answer: '',
    toolCalls: [],
    reason,
    repoPath,
    setup,
    command,
  };
}

function skippedRun({ run, status, reason, repoPath, setup, command }) {
  return {
    ...run,
    status,
    reliabilityStatus: status,
    setupStartedAt: null,
    setupEndedAt: null,
    setupDurationMs: 0,
    queryStartedAt: null,
    queryEndedAt: null,
    queryDurationMs: 0,
    costUsd: 0,
    answer: '',
    toolCalls: [],
    reason,
    repoPath,
    setup,
    command,
  };
}

function loadPriorCompletedRuns({ args, plannedRuns }) {
  const plannedIds = new Set(plannedRuns.map((run) => run.id));
  const candidates = [join(args.out, 'live-results.json'), join(args.out, PARTIAL_RESULTS_FILE)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed.profile !== args.profile || parsed.seed !== args.seed || !Array.isArray(parsed.runs)) continue;
      return parsed.runs.filter((run) => plannedIds.has(run.id) && run.status && run.status !== 'not_run');
    } catch {}
  }
  return [];
}

function writePartialResults({ args, matrix, results }) {
  writeFileSync(join(args.out, PARTIAL_RESULTS_FILE), `${JSON.stringify(scoreResults(results, matrix), null, 2)}\n`);
}

function collectSolidKGIndexes({ args, results }) {
  const rows = [];
  const seen = new Set();
  for (const run of results.runs ?? []) {
    if (run.armId !== 'solidkg') continue;
    const repoId = run.repoId;
    const dataDir = join(args.out, 'setup', 'solidkg', repoId);
    const key = `${repoId}:${dataDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(collectIndexMetadata({ repoId, repoPath: run.repoPath ?? repoPathFor({ repoMatrix: [{ id: repoId }] }, args.repoCache, repoId), dataDir, setupStartedAt: run.setupStartedAt ?? null, setupEndedAt: run.setupEndedAt ?? null }));
  }
  return rows;
}

function attachPassport({ args, matrix, results, diagnosticOnly = false }) {
  return attachBenchmarkPassport(results, {
    matrix,
    scenarioFile: args.fromScenarios,
    benchmarkScriptPath: fileURLToPath(import.meta.url),
    solidkgBin: args.solidkgBin,
    indexes: collectSolidKGIndexes({ args, results }),
    diagnosticOnly,
  });
}


async function callAdapter(fn, value) {
  return await fn(value);
}

function setupCacheKey(setup) {
  return JSON.stringify(setup.setupCommand ?? []);
}

function setupFailureReason(armId, setupResult, commandResult, timeoutMs) {
  const errorCode = commandResult?.errorCode;
  if (errorCode === 'ETIMEDOUT') return `${armId}_setup_timeout: ${errorCode} after ${timeoutMs}ms`;
  const stderr = stripAnsi(commandResult?.stderr ?? '').trim().split(/\r?\n/).find(Boolean);
  if (stderr) return `${setupResult.reason ?? `${armId}_setup_failed`}: ${stderr}`;
  return setupResult.reason ?? `${armId}_setup_failed`;
}

function reusedSetupContract(setup, cached) {
  return {
    ...setup,
    setupStatus: 'reused',
    setupStartedAt: null,
    setupEndedAt: null,
    setupDurationMs: 0,
    reusedFromRunId: cached.runId,
    reusedSetupStartedAt: cached.setup?.setupStartedAt ?? null,
    reusedSetupEndedAt: cached.setup?.setupEndedAt ?? null,
  };
}

export async function executeLiveBenchmark({ args, matrix, plannedRuns, adapters: suppliedAdapters = {} }) {
  args = { ...args, out: resolve(args.out), repoCache: resolve(args.repoCache), solidkgBin: normalizeConfiguredBin(args.solidkgBin) };
  const guard = liveGuard(args, plannedRuns);
  if (!guard.ok) return { status: 1, stdout: '', stderr: `${guard.reason}\n` };

  const adapters = { ...defaultAdapters(), ...suppliedAdapters };
  mkdirSync(args.out, { recursive: true });
  const livePlan = { ...buildDryRunPlan({ args, matrix, plannedRuns }), willInvokeModel: true, dryRun: false };
  writeFileSync(join(args.out, 'run-plan.json'), `${JSON.stringify(livePlan, null, 2)}\n`);
  const env = { OPENCODE_BIN: args.opencodeBin, SOLIDKG_BIN: args.solidkgBin, OPENCODE_MODEL: args.model, OPENCODE_VARIANT: args.variant, OPENCODE_BENCH_TIMEOUT_MS: String(args.timeoutMs) };
  const preflight = await callAdapter(adapters.runPreflight, { out: args.out, env });
  if (preflight.status !== 'pass') return { status: 1, stdout: '', stderr: `OpenCode preflight failed: ${preflight.reason ?? preflight.status}\n`, preflight };
  const results = liveResultsSkeleton({ args, plannedRuns });
  results.transcriptCapability = preflight.transcriptCapability ?? results.transcriptCapability;
  results.preflight = preflight;
  const priorRuns = loadPriorCompletedRuns({ args, plannedRuns });
  const completedRunIds = new Set(priorRuns.map((run) => run.id));
  results.runs.push(...priorRuns);
  const setupCache = new Map();

  for (const run of plannedRuns) {
    if (completedRunIds.has(run.id)) continue;
    const scenario = matrix.scenarios.find((candidate) => candidate.id === run.scenarioId);
    const repoPath = repoPathFor(matrix, args.repoCache, run.repoId);
    let setup = buildSetupContract(run.armId, { repoPath, repoId: run.repoId, out: args.out, solidkgBin: args.solidkgBin });
    const command = buildArmCommand(run.armId, { repoPath, scenario, out: args.out });
    const runId = safeRunId(run.id);
    const runDir = join(args.out, 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    if (command.status === 'unsupported') {
      results.runs.push(skippedRun({ run, status: 'unsupported', reason: command.reason ?? 'unsupported_arm_command', repoPath, setup, command }));
      writePartialResults({ args, matrix, results });
      continue;
    }

    if (!existsSync(repoPath)) {
      results.runs.push(setupFailedRun({ run, setup, reason: `repo cache path missing for ${run.repoId}: ${repoPath}`, repoPath, command }));
      writePartialResults({ args, matrix, results });
      continue;
    }

    let setupStartedMs = null;
    let setupEndedMs = null;
    if (setup.setupCommand.length > 0) {
      const key = setupCacheKey(setup);
      const cached = setupCache.get(key);
      if (cached) {
        setup = reusedSetupContract(setup, cached);
        if (cached.status === 'setup_failed') {
          results.runs.push(setupFailedRun({ run, setup, reason: `reused_${cached.reason}`, repoPath, command }));
          writePartialResults({ args, matrix, results });
          continue;
        }
      } else {
        setupStartedMs = adapters.nowMs();
        const commandResult = await callAdapter(adapters.runSetupCommand, { command: setup.setupCommand, cwd: repoPath, timeoutMs: args.timeoutMs, run, scenario, repoPath, runDir });
        setupEndedMs = adapters.nowMs();
        const setupResult = classifySetupResult(run.armId, { ...commandResult, statusCode: resultStatusCode(commandResult) });
        setup.setupStartedAt = isoFromMs(setupStartedMs);
        setup.setupEndedAt = isoFromMs(setupEndedMs);
        setup.setupDurationMs = Math.max(0, setupEndedMs - setupStartedMs);
        setup.commandResult = commandResult;
        if (setupResult.status === 'setup_failed') {
          const reason = setupFailureReason(run.armId, setupResult, commandResult, args.timeoutMs);
          setupCache.set(key, { status: 'setup_failed', reason, setup, runId: run.id });
          results.runs.push(setupFailedRun({ run, setup, reason, repoPath, command, setupStartedMs, setupEndedMs }));
          writePartialResults({ args, matrix, results });
          continue;
        }
        setupCache.set(key, { status: 'setup_passed', setup, runId: run.id });
      }
    }

    const configPaths = writeIsolatedConfig({ armId: run.armId, repoPath, question: scenario.question, out: runDir, peerCommand: command.command, solidkgDataDir: run.armId === 'solidkg' ? join(args.out, 'setup', 'solidkg', run.repoId) : null, solidkgBin: args.solidkgBin });
    const solidkgDataDir = run.armId === 'solidkg' ? join(args.out, 'setup', 'solidkg', run.repoId) : null;
    const runPlan = buildRunPlan({ armId: run.armId, repoPath, question: scenario.question, out: args.out, env, runId, peerWrapper: configPaths.peerWrapper, solidkgDataDir });
    const queryStartedMs = adapters.nowMs();
    const opencodeResult = await callAdapter(adapters.runOpenCode, { bin: args.opencodeBin, argv: runPlan.argv, cwd: runDir, timeoutMs: runPlan.timeoutMs, env: { OPENCODE_CONFIG: configPaths.opencodeConfigPath }, run, scenario, repoPath, runDir, runPlan, configPaths });
    const queryEndedMs = adapters.nowMs();
    writeFileSync(runPlan.stdoutPath, opencodeResult?.stdout ?? '');
    writeFileSync(runPlan.stderrPath, opencodeResult?.stderr ?? '');
    writeFileSync(runPlan.transcriptPath, opencodeResult?.transcriptText ?? opencodeResult?.stdout ?? '');
    if (opencodeResult?.sessionExportText && runPlan.sessionExportPath) writeFileSync(runPlan.sessionExportPath, opencodeResult.sessionExportText);

    const common = {
      ...run,
      repoPath,
      setup,
      command,
      opencode: { ...opencodeResult, stdout: undefined, stderr: undefined, transcriptText: undefined },
      opencodeConfigPath: configPaths.opencodeConfigPath,
      instructionsPath: configPaths.instructionsPath,
      stdoutPath: runPlan.stdoutPath,
      stderrPath: runPlan.stderrPath,
      transcriptPath: runPlan.transcriptPath,
      setupStartedAt: setup.setupStartedAt ?? null,
      setupEndedAt: setup.setupEndedAt ?? null,
      setupDurationMs: setup.setupDurationMs ?? 0,
      queryStartedAt: isoFromMs(queryStartedMs),
      queryEndedAt: isoFromMs(queryEndedMs),
      queryDurationMs: Math.max(0, queryEndedMs - queryStartedMs),
    };

    if (resultStatusCode(opencodeResult) !== 0) {
      results.runs.push({ ...common, status: 'runner_failed', reliabilityStatus: 'runner_failed', costUsd: 0, answer: '', toolCalls: [], reason: opencodeResult?.errorCode ?? 'opencode_runner_failed' });
      writePartialResults({ args, matrix, results });
      continue;
    }

    let parsed;
    try {
      parsed = await callAdapter(adapters.parseTranscript, runPlan.transcriptPath);
    } catch (error) {
      results.runs.push({ ...common, status: 'parse_failed', reliabilityStatus: 'parse_failed', costUsd: 0, answer: '', toolCalls: [], reason: error.message });
      writePartialResults({ args, matrix, results });
      continue;
    }

    const evidenceParsed = opencodeResult?.sessionExportText ? { ...parsed, toolResults: parseOpenCodeTranscriptText(opencodeResult.sessionExportText).toolResults ?? [] } : parsed;
    const parsedStatus = parsed.status === 'pass' || parsed.status === 'parse_failed' ? parsed.status : 'runner_failed';
    const evidence = persistEvidenceDossier({
      run,
      runDir,
      rawEventsText: opencodeResult?.sessionExportText ?? opencodeResult?.stdout ?? '',
      transcriptPath: runPlan.transcriptPath,
      parsed: evidenceParsed,
      cohort: { profile: args.profile, seed: args.seed, model: args.model, variant: args.variant, repoId: run.repoId, repoPath },
      metricsLedger: {
        toolCallCount: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.length : 0,
        readCount: Number(parsed.readCount ?? 0),
        grepCount: Number(parsed.grepCount ?? 0),
        bashCount: Number(parsed.bashCount ?? 0),
        solidkgToolCalls: Number(parsed.solidkgToolCalls ?? 0),
        peerWrapperCalls: Number(parsed.peerWrapperCalls ?? 0),
        fallbackLoopCount: Number(parsed.fallbackLoopCount ?? 0),
        durationMs: Number(parsed.durationMs ?? 0),
        costUsd: Number(parsed.costUsd ?? 0),
        rawToolResultPayloadBytes: Number(parsed.rawToolResultPayloadBytes ?? 0),
        truncatedToolResultCount: Number(parsed.truncatedToolResultCount ?? 0),
      },
    });
    const rawMetrics = evidence.dossier?.metricsLedger ?? {};
    results.runs.push({
      ...common,
      status: parsedStatus,
      reliabilityStatus: parsedStatus,
      costUsd: Number(parsed.costUsd ?? 0),
      answer: parsed.finalAnswer?.text ?? '',
      toolCalls: parsed.toolCalls ?? [],
      readCount: Number(parsed.readCount ?? 0),
      grepCount: Number(parsed.grepCount ?? 0),
      bashCount: Number(parsed.bashCount ?? 0),
      solidkgToolCalls: Number(parsed.solidkgToolCalls ?? 0),
      peerWrapperCalls: Number(parsed.peerWrapperCalls ?? 0),
      fallbackLoopCount: Number(parsed.fallbackLoopCount ?? 0),
      rawToolResultPayloadBytes: Number(rawMetrics.rawToolResultPayloadBytes ?? parsed.rawToolResultPayloadBytes ?? 0),
      truncatedToolResultCount: Number(rawMetrics.truncatedToolResultCount ?? parsed.truncatedToolResultCount ?? 0),
      evidenceDossierPath: evidence.evidenceDossierPath,
      rawEventsPath: evidence.rawEventsPath,
      toolResultPayloads: evidence.toolResultPayloads,
      rawToolResultPayloadsAvailable: evidence.validation.toolResultPayloadsAvailable,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    });
    writePartialResults({ args, matrix, results });
  }

  const scoredResults = attachPassport({ args, matrix, results: scoreResults(results, matrix) });
  const resultsPath = join(args.out, 'live-results.json');
  const smokeSuccessful = args.profile === 'smoke' && smokeRunSuccessful(scoredResults);
  if (smokeSuccessful) scoredResults.smokeStatus = 'successful';
  writeFileSync(resultsPath, `${JSON.stringify(scoredResults, null, 2)}\n`);
  const { artifacts, report } = await callAdapter(adapters.writeReport, {
    results: scoredResults,
    matrix,
    out: args.out,
    currentBenchmarkScriptPath: fileURLToPath(import.meta.url),
    currentScenarioFile: args.fromScenarios,
    expectedSolidKGBin: scoredResults.solidkgBin ?? scoredResults.benchmarkPassport?.solidkg?.configuredBin ?? args.solidkgBin,
  });
  const solidkgReliability = scoredResults.reliability?.find((row) => row.armId === 'solidkg');
  if (args.profile === 'calibration' && solidkgReliability?.successRate > 0) writeCalibrationSuccess({ args, plannedRuns, scoredResults, resultsPath, artifacts, preflight });
  if (smokeSuccessful) writeSmokeSuccess({ args, plannedRuns, scoredResults, resultsPath, artifacts, preflight });
  return { status: 0, stdout: `${JSON.stringify({ ok: true, route: 'live', schemaName: report.schemaName, resultsPath, artifacts }, null, 2)}\n`, stderr: '', results: scoredResults, report, artifacts };
}

function dryRunResults({ args, matrix, plannedRuns }) {
  const arms = getAnswerArms();
  const runs = plannedRuns.map((run) => {
    const scenario = matrix.scenarios.find((candidate) => candidate.id === run.scenarioId);
    const repoPath = repoPathFor(matrix, args.repoCache, run.repoId);
    const setup = buildSetupContract(run.armId, { repoPath, repoId: run.repoId, out: args.out, solidkgBin: args.solidkgBin });
    const command = buildArmCommand(run.armId, { repoPath, scenario, out: args.out });
    const safeRunId = run.id.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const opencodePlan = runDryRun({ armId: run.armId, repoPath, question: scenario.question, out: join(args.out, 'opencode-dry-runs', safeRunId), env: { OPENCODE_BIN: args.opencodeBin, SOLIDKG_BIN: args.solidkgBin, OPENCODE_MODEL: args.model, OPENCODE_VARIANT: args.variant, OPENCODE_BENCH_TIMEOUT_MS: String(args.timeoutMs) }, peerCommand: command.command, solidkgDataDir: run.armId === 'solidkg' ? join(args.out, 'setup', 'solidkg', run.repoId) : null });
    return { ...run, status: 'not_run', reliabilityStatus: 'not_run', setupDurationMs: setup.setupDurationMs, queryDurationMs: 0, costUsd: 0, answer: '', toolCalls: [], setup, command, opencodePlan };
  });
  return {
    schemaName: 'solidkg.llm-answer-quality.results.v1',
    reportSchemaName: 'solidkg.llm-answer-quality.report.v1',
    profile: args.profile,
    seed: args.seed,
    maxRuns: Number.isFinite(args.maxRuns) ? args.maxRuns : plannedRuns.length,
    maxEstimatedCostUsd: Number.isFinite(args.maxEstimatedCostUsd) ? args.maxEstimatedCostUsd : plannedRuns.length * DEFAULT_COST_PER_RUN_USD,
    estimatedCostUsd: Number((plannedRuns.length * DEFAULT_COST_PER_RUN_USD).toFixed(2)),
    confirmLive: args.confirmLive,
    model: args.model,
    variant: args.variant,
    solidkgBin: args.solidkgBin,
    transcriptCapability: { status: 'not_checked', reason: 'dry_run' },
    plannedRunOrder: plannedRuns.map((run) => run.id),
    runs,
    arms,
  };
}

function calibrationEvidenceOk(args) {
  const candidates = [join(args.out || '.', 'calibration-success.json'), join(args.repoCache || '.', 'calibration-success.json')];
  return candidates.some((file) => {
    if (!existsSync(file)) return false;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed.status === 'successful' || parsed.status === 'pass';
    } catch {
      return false;
    }
  });
}

function smokeEvidenceOk(args) {
  const candidates = [join(args.out || '.', 'smoke-success.json'), join(args.repoCache || '.', 'smoke-success.json')];
  return candidates.some((file) => {
    if (!existsSync(file)) return false;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed.status === 'successful' || parsed.status === 'pass';
    } catch {
      return false;
    }
  });
}

function liveGuard(args, plannedRuns) {
  const estimatedCostUsd = Number((plannedRuns.length * DEFAULT_COST_PER_RUN_USD).toFixed(2));
  if (!args.confirmLive) return { ok: false, reason: 'live execution requires --confirm-live before any model invocation' };
  if (!Number.isFinite(args.maxRuns) || args.maxRuns <= 0) return { ok: false, reason: 'live execution requires finite positive --max-runs' };
  if (!Number.isFinite(args.maxEstimatedCostUsd) || args.maxEstimatedCostUsd < 0) return { ok: false, reason: 'live execution requires finite non-negative --max-estimated-cost-usd' };
  if (plannedRuns.length > args.maxRuns) return { ok: false, reason: `planned runs ${plannedRuns.length} exceed --max-runs ${args.maxRuns}` };
  if (estimatedCostUsd > args.maxEstimatedCostUsd) return { ok: false, reason: `estimated cost ${estimatedCostUsd} exceeds --max-estimated-cost-usd ${args.maxEstimatedCostUsd}` };
  if (['smoke', 'full'].includes(args.profile) && !calibrationEvidenceOk(args)) return { ok: false, reason: 'smoke/full live run requires successful calibration evidence' };
  if (args.profile === 'full' && !smokeEvidenceOk(args)) return { ok: false, reason: 'full live run requires successful smoke evidence' };
  return { ok: true };
}

function smokeRunSuccessful(scoredResults) {
  return ARM_IDS.every((armId) => {
    const armRuns = scoredResults.runs.filter((run) => run.armId === armId);
    return armRuns.filter((run) => typeof run.score === 'number').length > 1 && armRuns.some((run) => run.status === 'pass');
  });
}

function writeCalibrationSuccess({ args, plannedRuns, scoredResults, resultsPath, artifacts, preflight }) {
  const passCount = scoredResults.runs.filter((run) => run.status === 'pass').length;
  const evidence = {
    schemaName: 'solidkg.llm-answer-quality.calibration-success.v1',
    status: 'successful',
    profile: args.profile,
    seed: args.seed,
    generatedAt: new Date().toISOString(),
    plannedRunCount: plannedRuns.length,
    passCount,
    model: args.model,
    variant: args.variant,
    solidkgBin: args.solidkgBin,
    maxRuns: args.maxRuns,
    maxEstimatedCostUsd: args.maxEstimatedCostUsd,
    resultsPath,
    reportArtifacts: artifacts,
    preflight: { status: preflight.status, artifact: preflight.artifact, transcriptCapability: preflight.transcriptCapability },
  };
  writeFileSync(join(args.out, 'calibration-success.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function writeSmokeSuccess({ args, plannedRuns, scoredResults, resultsPath, artifacts, preflight }) {
  const passCount = scoredResults.runs.filter((run) => run.status === 'pass').length;
  const evidence = {
    schemaName: 'solidkg.llm-answer-quality.smoke-success.v1',
    status: 'successful',
    profile: args.profile,
    seed: args.seed,
    generatedAt: new Date().toISOString(),
    plannedRunCount: plannedRuns.length,
    passCount,
    model: args.model,
    variant: args.variant,
    solidkgBin: args.solidkgBin,
    maxRuns: args.maxRuns,
    maxEstimatedCostUsd: args.maxEstimatedCostUsd,
    resultsPath,
    reportArtifacts: artifacts,
    preflight: { status: preflight.status, artifact: preflight.artifact, transcriptCapability: preflight.transcriptCapability },
  };
  writeFileSync(join(args.out, 'smoke-success.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

export function buildDryRunPlan({ args, matrix, plannedRuns }) {
  const estimatedCostUsd = Number((plannedRuns.length * DEFAULT_COST_PER_RUN_USD).toFixed(2));
  const warnings = [];
  if (Number.isFinite(args.maxRuns) && plannedRuns.length > args.maxRuns) warnings.push(`planned runs ${plannedRuns.length} exceed --max-runs ${args.maxRuns}`);
  if (Number.isFinite(args.maxEstimatedCostUsd) && estimatedCostUsd > args.maxEstimatedCostUsd) warnings.push(`estimated cost ${estimatedCostUsd} exceeds --max-estimated-cost-usd ${args.maxEstimatedCostUsd}`);
  return { schemaName: ORCHESTRATOR_SCHEMA, profile: args.profile, seed: args.seed, willInvokeModel: false, dryRun: true, plannedRunCount: plannedRuns.length, estimatedCostUsd, plannedRunOrder: plannedRuns.map((run) => run.id), plannedRuns, warnings, repoCache: args.repoCache, out: args.out, model: args.model, variant: args.variant, solidkgBin: args.solidkgBin, skipJudge: args.skipJudge };
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  args.solidkgBin = normalizeConfiguredBin(args.solidkgBin);
  if (!args.out) return { status: 1, stdout: '', stderr: '--out is required\n' };
  mkdirSync(args.out, { recursive: true });
  if (args.fromResults) {
    const results = JSON.parse(readFileSync(args.fromResults, 'utf8'));
    const matrix = loadScenarioMatrix(args.fromScenarios);
    const { artifacts, report } = writeAnswerQualityReport({
      results,
      matrix,
      out: args.out,
      currentBenchmarkScriptPath: fileURLToPath(import.meta.url),
      currentScenarioFile: args.fromScenarios,
      expectedSolidKGBin: results.solidkgBin ?? results.benchmarkPassport?.solidkg?.configuredBin ?? args.solidkgBin,
    });
    return { status: 0, stdout: JSON.stringify({ ok: true, route: 'from-results', schemaName: report.schemaName, artifacts }, null, 2) + '\n', stderr: '' };
  }
  if (!PROFILES.includes(args.profile)) return { status: 1, stdout: '', stderr: `--profile must be one of ${PROFILES.join(', ')}\n` };
  const matrix = loadScenarioMatrix(args.fromScenarios);
  const errors = validateScenarioMatrix(matrix, { profile: args.profile, ...validationOptionsForScenarioFile(args.fromScenarios) });
  if (errors.length > 0) return { status: 1, stdout: '', stderr: `${errors.join('\n')}\n` };
  const plannedRuns = planRuns({ matrix, profile: args.profile, arms: selectedArms(args), repeats: args.repeats, seed: args.seed });
  if (args.preflightOnly) {
    const preflight = runPreflight({ out: args.out, env: { OPENCODE_BIN: args.opencodeBin, SOLIDKG_BIN: args.solidkgBin, OPENCODE_MODEL: args.model, OPENCODE_VARIANT: args.variant, OPENCODE_BENCH_TIMEOUT_MS: String(args.timeoutMs) } });
    return { status: preflight.status === 'pass' ? 0 : 1, stdout: `${JSON.stringify(preflight, null, 2)}\n`, stderr: '' };
  }
  if (args.dryRun) {
    const plan = buildDryRunPlan({ args, matrix, plannedRuns });
    const results = attachPassport({ args, matrix, results: dryRunResults({ args, matrix, plannedRuns }), diagnosticOnly: true });
    writeFileSync(join(args.out, 'run-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(args.out, 'dry-run-results.json'), `${JSON.stringify(results, null, 2)}\n`);
    return { status: 0, stdout: `${JSON.stringify({ ok: true, profile: args.profile, seed: args.seed, plannedRunCount: plannedRuns.length, willInvokeModel: false, warnings: plan.warnings }, null, 2)}\n`, stderr: '' };
  }
  return await executeLiveBenchmark({ args, matrix, plannedRuns, adapters: options.adapters ?? {} });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCli();
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}



