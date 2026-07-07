#!/usr/bin/env node
import { normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ARM_SCHEMA = 'solidkg.llm-answer-quality.arms.v1';
export const ARM_IDS = ['solidkg', 'grep_read', 'tilth', 'cartog', 'sverklo'];
export const LOCAL_FALLBACK_TOOLS = ['read', 'rg', 'grep'];
export const PEER_WRAPPERS = ['tilth_wrapper', 'cartog_wrapper', 'sverklo_wrapper'];

function quote(value) {
  return JSON.stringify(String(value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function scenarioQuestion(scenario) {
  return hasText(scenario?.question) ? scenario.question : '';
}

function publicScenarioQuery(scenario) {
  return scenarioQuestion(scenario);
}

export function getAnswerArms() {
  return [
    {
      id: 'solidkg',
      name: 'SolidKG MCP',
      setupStatus: 'required',
      setupCommandTemplate: ['solidkg', 'init', '-i', '{repoPath}', '--data-dir', '{out}/setup/solidkg/{repoId}'],
      allowedTools: ['solidkg_mcp', ...LOCAL_FALLBACK_TOOLS],
      disallowedTools: PEER_WRAPPERS,
      policy: 'Use SolidKG MCP as the repository-intelligence surface. Local read/search fallback is allowed and must be counted separately.',
      instructionSurface: 'Allowed: SolidKG MCP plus local read/search fallback. Disallowed: Tilth, Cartog, and Sverklo wrappers.'
    },
    {
      id: 'grep_read',
      name: 'Grep/Read Baseline',
      setupStatus: 'not_required',
      setupCommandTemplate: [],
      allowedTools: LOCAL_FALLBACK_TOOLS,
      disallowedTools: ['solidkg_mcp', ...PEER_WRAPPERS],
      policy: 'Use only local file reads and literal search. Do not use graph MCPs or peer repository-intelligence wrappers.',
      instructionSurface: 'Allowed: local read/search fallback only. Disallowed: SolidKG MCP, Tilth, Cartog, and Sverklo wrappers.'
    },
    {
      id: 'tilth',
      name: 'Tilth',
      setupStatus: 'preflight_required',
      setupCommandTemplate: ['npx', '--yes', 'tilth', '--version'],
      commandTemplate: ['npx', '--yes', 'tilth', '{scenario.question}', '--scope', '{repoPath}', '--expand=8', '--budget', '5000'],
      allowedTools: ['tilth_wrapper', ...LOCAL_FALLBACK_TOOLS],
      disallowedTools: ['solidkg_mcp', 'cartog_wrapper', 'sverklo_wrapper'],
      policy: 'Expose only Tilth plus local read/search fallback. The public scenario question must be passed to Tilth; rubric expectedEvidence symbols/files must never be used as hidden query hints.',
      instructionSurface: 'Allowed: Tilth wrapper plus local read/search fallback. Disallowed: SolidKG MCP, Cartog, and Sverklo.'
    },
    {
      id: 'cartog',
      name: 'Cartog',
      setupStatus: 'required',
      setupCommandTemplate: ['cartog', 'index', '{repoPath}', '--db', '{out}/setup/cartog/{repoId}.db', '--no-lsp', '--json'],
      commandTemplate: ['cartog', '--db', '{out}/setup/cartog/{repoId}.db', 'context', '{scenario.question}', '--tokens', '5000'],
      allowedTools: ['cartog_wrapper', ...LOCAL_FALLBACK_TOOLS],
      disallowedTools: ['solidkg_mcp', 'tilth_wrapper', 'sverklo_wrapper'],
      policy: 'Expose only Cartog plus local read/search fallback. Scenario retrieval uses Cartog context with the public scenario question. Missing Cartog setup is setup_failed, not answer-quality failure.',
      instructionSurface: 'Allowed: Cartog wrapper plus local read/search fallback. Disallowed: SolidKG MCP, Tilth, and Sverklo.'
    },
    {
      id: 'sverklo',
      name: 'Sverklo',
      setupStatus: 'preflight_required',
      setupCommandTemplate: ['npm', 'exec', '--yes', '--package=sverklo@latest', '--', 'sverklo', '--help'],
      commandTemplate: ['npm', 'exec', '--yes', '--package=sverklo@latest', '--', 'sverklo', 'prove', '{repoPath}', '--markdown'],
      allowedTools: ['sverklo_wrapper', ...LOCAL_FALLBACK_TOOLS],
      disallowedTools: ['solidkg_mcp', 'tilth_wrapper', 'cartog_wrapper'],
      scenarioTargeting: { status: 'repo_context_only', reason: 'current Sverklo CLI prove surface does not expose a scenario query argument' },
      policy: 'Expose Sverklo prove as repository context plus local read/search fallback. The OpenCode prompt carries the scenario question.',
      instructionSurface: 'Allowed: Sverklo prove wrapper plus local read/search fallback. Disallowed: SolidKG MCP, Tilth, and Cartog.'
    }
  ];
}

function renderValue(token, context) {
  return token
    .replaceAll('{repoPath}', context.repoPath)
    .replaceAll('{repoId}', context.scenario.repoId ?? 'unknown')
    .replaceAll('{scenario.question}', scenarioQuestion(context.scenario))
    .replaceAll('{structural.query}', publicScenarioQuery(context.scenario))
    .replaceAll('{out}', context.out ?? 'answer-quality-out');
}

export function renderCommandTemplate(template, context) {
  return template.map((token) => renderValue(token, context));
}

export function buildArmCommand(armId, { repoPath, scenario, out = 'answer-quality-out', sverkloSupportsScenarioQuery = false }) {
  const arm = getAnswerArms().find((candidate) => candidate.id === armId);
  if (!arm) throw new Error(`unknown arm: ${armId}`);
  if (armId === 'sverklo' && !sverkloSupportsScenarioQuery) {
    return {
      armId,
      status: 'unsupported',
      reason: 'scenario_query_not_supported',
      score: null,
      command: []
    };
  }
  if (!arm.commandTemplate) {
    return { armId, status: 'not_required', reason: 'agent_uses_builtin_tool_surface', score: null, command: [] };
  }
  const command = renderCommandTemplate(arm.commandTemplate, { repoPath, scenario, out });
  return { armId, status: 'ready', command, commandText: command.map(quote).join(' '), ...(arm.scenarioTargeting ? { scenarioTargeting: arm.scenarioTargeting } : {}) };
}

export function buildSetupContract(armId, { repoPath, repoId, out = 'answer-quality-out', now = null, solidkgBin = 'solidkg' } = {}) {
  const arm = getAnswerArms().find((candidate) => candidate.id === armId);
  if (!arm) throw new Error(`unknown arm: ${armId}`);
  const setupCommand = renderCommandTemplate(arm.setupCommandTemplate ?? [], { repoPath: repoPath ?? '{repoPath}', scenario: { repoId: repoId ?? '{repoId}', question: '' }, out });
  if (armId === 'solidkg' && setupCommand.length > 0) {
    setupCommand[0] = solidkgBin;
    const dataDirIndex = setupCommand.indexOf('--data-dir');
    if (dataDirIndex >= 0 && setupCommand[dataDirIndex + 1]) setupCommand[dataDirIndex + 1] = normalize(setupCommand[dataDirIndex + 1]);
  }
  return {
    armId,
    setupStatus: arm.setupStatus,
    setupCommand,
    setupStartedAt: now,
    setupEndedAt: now,
    setupDurationMs: 0
  };
}

export function classifySetupResult(armId, commandResult) {
  if (armId === 'grep_read') return { armId, status: 'not_required', score: null };
  if (!isRecord(commandResult) || commandResult.statusCode !== 0) {
    return { armId, status: 'setup_failed', reason: `${armId}_setup_unavailable`, score: null };
  }
  return { armId, status: 'setup_passed', score: null };
}

export function validateAnswerArms(arms = getAnswerArms()) {
  const errors = [];
  const ids = arms.map((arm) => arm.id);
  if (ids.length !== ARM_IDS.length || !ARM_IDS.every((id) => ids.includes(id))) errors.push(`arm ids must be exactly ${ARM_IDS.join(', ')}`);
  for (const arm of arms) {
    if (!Array.isArray(arm.allowedTools) || arm.allowedTools.length === 0) errors.push(`${arm.id}.allowedTools must be non-empty`);
    if (!Array.isArray(arm.disallowedTools)) errors.push(`${arm.id}.disallowedTools must be an array`);
    if (!hasText(arm.policy)) errors.push(`${arm.id}.policy is required`);
    if (!hasText(arm.instructionSurface)) errors.push(`${arm.id}.instructionSurface is required`);
    const exposedPeers = PEER_WRAPPERS.filter((wrapper) => arm.allowedTools.includes(wrapper));
    if (arm.id === 'grep_read' && (arm.allowedTools.includes('solidkg_mcp') || exposedPeers.length > 0)) errors.push('grep_read must not expose SolidKG or peer wrappers');
    if (arm.id === 'solidkg' && !arm.allowedTools.includes('solidkg_mcp')) errors.push('solidkg arm must expose SolidKG MCP');
    if (PEER_WRAPPERS.includes(`${arm.id}_wrapper`) && exposedPeers.length !== 1) errors.push(`${arm.id} must expose exactly its own peer wrapper`);
    if (exposedPeers.length > 1) errors.push(`${arm.id} must not expose multiple peer wrappers`);
  }
  const sverklo = arms.find((arm) => arm.id === 'sverklo');
  if (!sverklo?.scenarioTargeting && !sverklo?.unsupportedReason) errors.push('sverklo must be scenario-targeted or explicitly unsupported');
  return errors;
}

function parseArgs(argv) {
  const args = { validate: false };
  for (const arg of argv) if (arg === '--validate') args.validate = true;
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  parseArgs(argv);
  const arms = getAnswerArms();
  const errors = validateAnswerArms(arms);
  if (errors.length > 0) return { status: 1, stdout: '', stderr: `${errors.join('\n')}\n` };
  return { status: 0, stdout: `${JSON.stringify({ ok: true, schemaName: ARM_SCHEMA, armIds: arms.map((arm) => arm.id), arms }, null, 2)}\n`, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCli();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
}
