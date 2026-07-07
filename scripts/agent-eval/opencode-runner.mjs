#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getAnswerArms, ARM_IDS, PEER_WRAPPERS } from './answer-arms.mjs';
import { parseOpenCodeTranscriptFile } from './parse-opencode-transcript.mjs';

export const RUNNER_SCHEMA = 'solidkg.opencode-runner.v1';
const DEFAULT_MODEL = 'openai/gpt-5.5';
const DEFAULT_TIMEOUT_MS = 900000;

function moduleDir() {
  const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
  return dirname(/^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname);
}

const DEFAULT_FIXTURE = resolve(moduleDir(), '..', '..', 'fixtures', 'agent-eval', 'answer-quality', 'transcripts', 'capability-probe.jsonl');

function getEnv(env = process.env) {
  return {
    bin: env.OPENCODE_BIN || 'opencode',
    solidkgBin: env.SOLIDKG_BIN || 'solidkg',
    model: env.OPENCODE_MODEL || DEFAULT_MODEL,
    variant: env.OPENCODE_VARIANT || '',
    timeoutMs: Number(env.OPENCODE_BENCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cmdArg(value) {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : shellQuote(text);
}

function resolveWindowsBin(bin, env = process.env) {
  if (process.platform !== 'win32' || extname(bin) || /[\\/]/.test(bin)) return bin;
  const pathValue = env.Path ?? env.PATH ?? '';
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of ['.cmd', '.exe', '.bat', '']) {
      const candidate = join(directory, `${bin}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

function spawnCli(bin, argv, { timeoutMs, env = process.env } = {}) {
  if (process.platform === 'win32') {
    if (!extname(bin) && !/[\\/]/.test(bin)) {
      const commandLine = [bin, ...argv.map(cmdArg)].join(' ');
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { encoding: 'utf8', timeout: timeoutMs, env });
    }
    const resolvedBin = resolveWindowsBin(bin, env);
    if (/\.(cmd|bat)$/i.test(resolvedBin)) {
      const commandLine = `call ${[resolvedBin, ...argv].map(cmdArg).join(' ')}`;
      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { encoding: 'utf8', timeout: timeoutMs, env });
    }
    return spawnSync(resolvedBin, argv, { encoding: 'utf8', timeout: timeoutMs, env });
  }
  return spawnSync(bin, argv, { encoding: 'utf8', timeout: timeoutMs, env });
}

function selectedArm(armId) {
  const arm = getAnswerArms().find((candidate) => candidate.id === armId);
  if (!arm) throw new Error(`unknown arm: ${armId}`);
  return arm;
}

function peerWrapperForArm(armId) {
  const wrapper = `${armId}_wrapper`;
  return PEER_WRAPPERS.includes(wrapper) ? wrapper : null;
}

function buildPeerWrapperScript(command) {
  return [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync } from 'node:fs';",
    "import { delimiter, extname, join } from 'node:path';",
    `const command = ${JSON.stringify(command)};`,
    'function shellQuote(value) { return `"${String(value).replace(/"/g, \'""\')}"`; }',
    'function cmdArg(value) { const text = String(value).replace(/\\\\/g, \'/\'); return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : shellQuote(text); }',
    'function resolveWindowsBin(bin) {',
    "  if (process.platform !== 'win32' || extname(bin) || /[\\\\/]/.test(bin)) return bin;",
    "  const pathValue = process.env.Path ?? process.env.PATH ?? '';",
    "  for (const directory of pathValue.split(delimiter).filter(Boolean)) for (const extension of ['.cmd', '.exe', '.bat', '']) {",
    '    const candidate = join(directory, `${bin}${extension}`);',
    '    if (existsSync(candidate)) return candidate;',
    '  }',
    '  return bin;',
    '}',
    'function runCommand() {',
    "  if (process.platform === 'win32') {",
    "    if (!extname(command[0]) && !/[\\\\/]/.test(command[0])) {",
    '      const commandLine = [command[0], ...command.slice(1).map(cmdArg)].join(\' \');',
    "      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    '    }',
    '    const resolvedBin = resolveWindowsBin(command[0]);',
    "    if (/\\.(cmd|bat)$/i.test(resolvedBin)) {",
    '      const commandLine = `call ${[resolvedBin, ...command.slice(1)].map(cmdArg).join(\' \')}`;',
    "      return spawnSync('cmd.exe', ['/d', '/c', commandLine], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    '    }',
    "    return spawnSync(resolvedBin, command.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    '  }',
    "  return spawnSync(command[0], command.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    '}',
    'const result = runCommand();',
    'if (result.stdout) process.stdout.write(result.stdout);',
    'if (result.stderr) process.stderr.write(result.stderr);',
    'process.exit(result.status ?? (result.error ? 1 : 0));',
    '',
  ].join('\n');
}

function writePeerWrapper({ armId, repoPath, question, outDir, peerCommand = null }) {
  const wrapper = peerWrapperForArm(armId);
  if (!wrapper) return null;
  const scenario = { repoId: 'scenario', question };
  const arm = selectedArm(armId);
  const command = Array.isArray(peerCommand) && peerCommand.length > 0 ? peerCommand : (arm.commandTemplate ? arm.commandTemplate.map((token) => token
    .replaceAll('{repoPath}', repoPath)
    .replaceAll('{repoId}', scenario.repoId)
    .replaceAll('{scenario.question}', question)
    .replaceAll('{out}', outDir)) : []);
  const wrapperDir = join(outDir, 'peer-wrappers');
  mkdirSync(wrapperDir, { recursive: true });
  const wrapperPath = join(wrapperDir, `${wrapper}.mjs`);
  writeFileSync(wrapperPath, buildPeerWrapperScript(command));
  try { chmodSync(wrapperPath, 0o755); } catch {}
  return { name: wrapper, path: wrapperPath, command: [process.execPath, wrapperPath], targetCommand: command };
}

export function buildOpenCodeConfig({ armId, repoPath, peerWrapper = null, solidkgDataDir = null, solidkgBin = 'solidkg' }) {
  const config = { '$schema': 'https://opencode.ai/config.json' };
  if (armId === 'solidkg') {
    config.mcp = {
      solidkg: {
        type: 'local',
        command: [solidkgBin, 'serve', '--mcp', '--path', repoPath, ...(solidkgDataDir ? ['--data-dir', solidkgDataDir] : [])],
        enabled: true,
      },
    };
  } else {
    const wrapper = peerWrapperForArm(armId);
    if (wrapper) {
      config.mcp = {
        [wrapper]: {
          type: 'local',
          command: peerWrapper?.command ?? [],
          enabled: true,
        },
      };
    }
  }
  return config;
}

function commandText(command) {
  return Array.isArray(command) ? command.map((part) => JSON.stringify(String(part))).join(' ') : '';
}

export function buildInstructions({ armId, repoPath, question, peerWrapper = null, solidkgDataDir = null }) {
  const arm = selectedArm(armId);
  const allowed = arm.allowedTools.join(', ');
  const forbidden = arm.disallowedTools.join(', ');
  const lines = [
    '# OpenCode Answer Quality Benchmark Arm',
    '',
    `Arm: ${arm.id} - ${arm.name}`,
    `Repository: ${repoPath}`,
    `Question: ${question}`,
    '',
    '## Allowed Tools',
    '',
    `Use only these repository-intelligence capabilities: ${allowed}.`,
    arm.policy,
    arm.instructionSurface,
    '',
  ];
  if (armId === 'solidkg') {
    lines.push(
      '## SolidKG MCP Scope',
      '',
      'Use the configured SolidKG MCP server for this repository. Do not invent or override SolidKG data directories.',
      solidkgDataDir
        ? `If a SolidKG tool exposes projectPath or dataDir parameters, use exactly projectPath=${repoPath} and dataDir=${solidkgDataDir}.`
        : 'If a SolidKG tool exposes projectPath or dataDir parameters, omit them unless the tool requires them; do not use a guessed .solidkg path.',
      '',
    );
  }
  if (peerWrapper) {
    lines.push(
      '## Peer Wrapper Command',
      '',
      `Run this exact wrapper command once before local fallback: ${commandText(peerWrapper.command)}.`,
      'Base the answer on the wrapper output when it is sufficient; use focused local read/search fallback only for missing evidence.',
      '',
    );
  }
  lines.push(
    '## Forbidden Tools',
    '',
    `Do not use these capabilities: ${forbidden || 'none'}.`,
    'Do not use global OpenCode configuration, project-root OpenCode configuration, or unlisted peer wrappers.',
    '',
    '## Answer Requirements',
    '',
    'Answer the user question directly from the allowed tool surface.',
    'If you fall back to local reads or search, keep it focused and mention the evidence used.',
    '',
  );
  return lines.join('\n');
}

function ensureOut(out) {
  if (!out) throw new Error('--out is required');
  mkdirSync(out, { recursive: true });
  return resolve(out);
}

export function writeIsolatedConfig({ armId, repoPath, question, out, peerCommand = null, solidkgDataDir = null, solidkgBin = 'solidkg' }) {
  if (!ARM_IDS.includes(armId)) throw new Error(`--arm must be one of ${ARM_IDS.join(', ')}`);
  if (!repoPath) throw new Error('--repo is required');
  if (!question) throw new Error('--question is required');
  const outDir = ensureOut(out);
  const opencodeConfigPath = join(outDir, 'opencode.jsonc');
  const instructionsPath = join(outDir, 'AGENTS.md');
  const peerWrapper = writePeerWrapper({ armId, repoPath, question, outDir, peerCommand });
  const instructions = buildInstructions({ armId, repoPath, question, peerWrapper, solidkgDataDir });
  writeFileSync(opencodeConfigPath, `${JSON.stringify(buildOpenCodeConfig({ armId, repoPath, peerWrapper, solidkgDataDir, solidkgBin }), null, 2)}\n`);
  writeFileSync(instructionsPath, instructions);
  return { opencodeConfigPath, instructionsPath, peerWrapper };
}

export function buildRunPlan({ armId, repoPath, question, out, env = process.env, runId = null, peerWrapper = null, solidkgDataDir = null }) {
  const envConfig = getEnv(env);
  const outDir = resolve(out);
  const id = runId ?? `${Date.now()}-${armId}`;
  const runDir = join(outDir, 'runs', id);
  const message = `${buildInstructions({ armId, repoPath, question, peerWrapper, solidkgDataDir })}\n## User Question\n\n${question}`;
  const variantArgs = envConfig.variant ? ['--variant', envConfig.variant] : [];
  const title = `cgaq-${id}`.slice(0, 80);
  const argv = ['run', message, '--model', envConfig.model, ...variantArgs, '--format', 'json', '--print-logs', '--dir', repoPath, '--title', title, '--pure'];
  return {
    runId: id,
    runDir,
    argv,
    title,
    argvTemplate: ['run', '<arm instructions + message>', '--model', envConfig.model, ...variantArgs, '--format', 'json', '--print-logs', '--dir', '<repoPath>', '--pure'],
    stdoutPath: join(runDir, 'stdout.jsonl'),
    stderrPath: join(runDir, 'stderr.txt'),
    transcriptPath: join(runDir, 'transcript.jsonl'),
    sessionExportPath: join(runDir, 'session-export.json'),
    timeoutMs: envConfig.timeoutMs,
  };
}

function parseArgs(argv) {
  const args = { dryRun: false, preflight: false, arm: 'grep_read', repo: '', question: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--preflight') args.preflight = true;
    else if (arg === '--arm') args.arm = argv[++i] ?? '';
    else if (arg === '--repo') args.repo = argv[++i] ?? '';
    else if (arg === '--question') args.question = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

function commandAvailable(result) {
  return !result.errorCode && result.statusCode === 0;
}

function commandNotFound(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return result.errorCode === 'ENOENT' || result.errorCode === 'ENOTDIR' || (result.statusCode !== 0 && /(not recognized|not found|could not find|cannot find)/i.test(text));
}

function hasNoninteractiveRun(helpText) {
  return /opencode\s+run|Usage:\s*opencode\s+run|run \[message/.test(helpText) && /--format/.test(helpText) && /--model/.test(helpText) && /--dir/.test(helpText);
}

function runHelp(bin, args, timeoutMs) {
  const result = spawnCli(bin, args, { timeoutMs });
  return {
    argv: [bin, ...args],
    statusCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    errorCode: result.error?.code,
  };
}

export function runPreflight({ out, env = process.env, fixturePath = DEFAULT_FIXTURE } = {}) {
  const outDir = ensureOut(out);
  const envConfig = getEnv(env);
  const checkedCommands = [];
  const rootHelp = runHelp(envConfig.bin, ['--help'], envConfig.timeoutMs);
  checkedCommands.push(rootHelp);
  let commandCapability;
  if (commandNotFound(rootHelp)) {
    commandCapability = { status: 'unavailable', reason: 'opencode_binary_not_found' };
  } else {
    const runHelpResult = runHelp(envConfig.bin, ['run', '--help'], envConfig.timeoutMs);
    checkedCommands.push(runHelpResult);
    const helpText = `${runHelpResult.stdout}\n${runHelpResult.stderr}`;
    commandCapability = commandAvailable(rootHelp) && commandAvailable(runHelpResult) && hasNoninteractiveRun(helpText)
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'opencode_noninteractive_mode_unavailable' };
  }

  let transcriptCapability;
  try {
    const parsed = parseOpenCodeTranscriptFile(fixturePath);
    transcriptCapability = parsed.status === 'pass' && parsed.finalAnswer.text && parsed.toolCalls.length > 0
      ? { status: 'available', fixturePath, finalAnswerExtracted: true, toolCallCount: parsed.toolCalls.length }
      : { status: 'unavailable', reason: parsed.reason ?? 'fixture_probe_failed', fixturePath };
  } catch (error) {
    transcriptCapability = { status: 'unavailable', reason: 'fixture_probe_failed', message: error.message, fixturePath };
  }

  const variantArgs = envConfig.variant ? ['--variant', envConfig.variant] : [];
  const argvTemplate = ['opencode', 'run', '<message>', '--model', envConfig.model, ...variantArgs, '--format', 'json', '--dir', '<repoPath>', '--pure'];
  const status = commandCapability.status === 'available' && transcriptCapability.status === 'available' ? 'pass' : 'runner_failed';
  const reason = commandCapability.reason ?? transcriptCapability.reason;
  const report = {
    schemaName: RUNNER_SCHEMA,
    status,
    ...(reason ? { reason } : {}),
    bin: envConfig.bin,
    model: envConfig.model,
    argvTemplate,
    checkedCommands: checkedCommands.map((command) => ({ argv: command.argv, statusCode: command.statusCode, errorCode: command.errorCode })),
    commandCapability,
    transcriptCapability,
  };
  const artifact = join(outDir, 'opencode-capabilities.json');
  writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, artifact };
}

export function runDryRun({ armId, repoPath, question, out, env = process.env, peerCommand = null, solidkgDataDir = null }) {
  const envConfig = getEnv(env);
  const paths = writeIsolatedConfig({ armId, repoPath, question, out, peerCommand, solidkgDataDir, solidkgBin: envConfig.solidkgBin });
  const plan = buildRunPlan({ armId, repoPath, question, out, env, peerWrapper: paths.peerWrapper, solidkgDataDir });
  return {
    schemaName: RUNNER_SCHEMA,
    status: 'dry_run',
    armId,
    repoPath,
    question,
    willInvokeModel: false,
    opencodeConfigPath: paths.opencodeConfigPath,
    instructionsPath: paths.instructionsPath,
    runPlan: {
      runId: plan.runId,
      runDir: plan.runDir,
      argv: plan.argv,
      stdoutPath: plan.stdoutPath,
      stderrPath: plan.stderrPath,
      transcriptPath: plan.transcriptPath,
      timeoutMs: plan.timeoutMs,
    },
  };
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.preflight) {
    const result = runPreflight({ out: args.out, env });
    return { status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  }
  if (args.dryRun) {
    const result = runDryRun({ armId: args.arm, repoPath: args.repo, question: args.question, out: args.out, env });
    return { status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  }
  return { status: 1, stdout: '', stderr: 'usage: opencode-runner.mjs --dry-run --arm <arm> --repo <repo> --question <question> --out <out> | --preflight --out <out>\n' };
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

