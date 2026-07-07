import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'scripts', 'agent-eval', 'opencode-runner.mjs');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((entry) => String(entry).replace(/\\/g, '/')).sort();
}

describe('opencode answer-quality runner', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('generates isolated SolidKG MCP config for dry-run without touching global files', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-runner-'));
    const repoPath = 'D:/tmp/example';
    const result = runHelper(['--dry-run', '--arm', 'solidkg', '--repo', repoPath, '--question', 'How?', '--out', tempDir]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      opencodeConfigPath: string;
      instructionsPath: string;
      armId: string;
      repoPath: string;
      question: string;
      willInvokeModel: boolean;
      runPlan: { runDir: string; argv: string[]; stdoutPath: string; stderrPath: string; transcriptPath: string; timeoutMs: number };
    };
    expect(parsed).toMatchObject({ armId: 'solidkg', repoPath, question: 'How?', willInvokeModel: false });
    expect(path.resolve(parsed.opencodeConfigPath).startsWith(path.resolve(tempDir))).toBe(true);
    expect(path.resolve(parsed.instructionsPath).startsWith(path.resolve(tempDir))).toBe(true);
    expect(path.resolve(parsed.runPlan.runDir).startsWith(path.resolve(tempDir, 'runs'))).toBe(true);
    expect(path.resolve(parsed.runPlan.stdoutPath).startsWith(path.resolve(tempDir, 'runs'))).toBe(true);
    expect(path.resolve(parsed.runPlan.stderrPath).startsWith(path.resolve(tempDir, 'runs'))).toBe(true);
    expect(path.resolve(parsed.runPlan.transcriptPath).startsWith(path.resolve(tempDir, 'runs'))).toBe(true);

    const config = parseJsonc(fs.readFileSync(parsed.opencodeConfigPath, 'utf8')) as { mcp: { solidkg: { type: string; command: string[]; enabled: boolean } } };
    expect(config).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        solidkg: {
          type: 'local',
          command: ['solidkg', 'serve', '--mcp', '--path', repoPath],
          enabled: true,
        },
      },
    });
    const instructions = fs.readFileSync(parsed.instructionsPath, 'utf8');
    expect(instructions).toContain('## Allowed Tools');
    expect(instructions).toContain('## Forbidden Tools');
    expect(instructions).toContain('solidkg_mcp');
    expect(instructions).toContain('tilth_wrapper');
    expect(listFiles(tempDir)).toEqual(['AGENTS.md', 'opencode.jsonc']);
  });

  it('baseline config excludes peer tools and SolidKG MCP', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-baseline-'));
    const result = runHelper(['--dry-run', '--arm', 'grep_read', '--repo', 'D:/tmp/repo', '--question', 'Q', '--out', tempDir]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { opencodeConfigPath: string; instructionsPath: string; willInvokeModel: boolean };
    expect(parsed.willInvokeModel).toBe(false);
    const config = parseJsonc(fs.readFileSync(parsed.opencodeConfigPath, 'utf8')) as { mcp?: Record<string, unknown> };
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.mcp).toBeUndefined();
    const instructions = fs.readFileSync(parsed.instructionsPath, 'utf8');
    expect(instructions).toContain('## Allowed Tools');
    expect(instructions).toContain('read, rg, grep');
    expect(instructions).toContain('Do not use these capabilities: solidkg_mcp, tilth_wrapper, cartog_wrapper, sverklo_wrapper.');
  });

  it('peer arm config exposes exactly the selected peer wrapper', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-peer-'));
    const result = runHelper(['--dry-run', '--arm', 'tilth', '--repo', 'D:/tmp/repo', '--question', 'Q', '--out', tempDir]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { opencodeConfigPath: string; instructionsPath: string };
    const config = parseJsonc(fs.readFileSync(parsed.opencodeConfigPath, 'utf8')) as { mcp: { tilth_wrapper: { command: string[] } } };
    expect(Object.keys(config.mcp)).toEqual(['tilth_wrapper']);
    expect(config.mcp).not.toHaveProperty('solidkg');
    expect(config.mcp).not.toHaveProperty('cartog_wrapper');
    expect(config.mcp).not.toHaveProperty('sverklo_wrapper');
    expect(config.mcp.tilth_wrapper.command[0]).toBe(process.execPath);
    expect(config.mcp.tilth_wrapper.command.join(' ')).toContain('tilth_wrapper.mjs');
    expect(config.mcp.tilth_wrapper.command).not.toContain('--help');
    expect(fs.existsSync(config.mcp.tilth_wrapper.command[1])).toBe(true);
    const wrapperScript = fs.readFileSync(config.mcp.tilth_wrapper.command[1], 'utf8');
    expect(wrapperScript).toContain('tilth');
    expect(wrapperScript).toContain('D:/tmp/repo');
    expect(wrapperScript).toContain('Q');
    const instructions = fs.readFileSync(parsed.instructionsPath, 'utf8');
    expect(instructions).toContain('tilth_wrapper');
    expect(instructions).toContain('Disallowed: SolidKG MCP, Cartog, and Sverklo');
    expect(instructions).toContain('## Peer Wrapper Command');
    expect(instructions).toContain('tilth_wrapper.mjs');
  });

  it('passes isolated arm instructions in the actual OpenCode run prompt', async () => {
    const runner = await import(new URL(`file://${runnerPath.replace(/\\/g, '/')}`).href);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-run-plan-'));

    const plan = runner.buildRunPlan({ armId: 'tilth', repoPath: 'D:/tmp/repo', question: 'How?', out: tempDir, env: { OPENCODE_MODEL: 'stub-model', OPENCODE_VARIANT: 'medium' }, runId: 'r1' });

    expect(plan.argv[0]).toBe('run');
    expect(plan.argv[1]).toContain('OpenCode Answer Quality Benchmark Arm');
    expect(plan.argv).toContain('--variant');
    expect(plan.argv).toContain('medium');
    expect(plan.argv[1]).toContain('Arm: tilth');
    expect(plan.argv[1]).toContain('## User Question');
    expect(plan.argv[1]).toContain('How?');
    expect(plan.argv).toContain('--dir');
    expect(plan.argv).toContain('D:/tmp/repo');
  });

  it('includes the configured SolidKG data directory in the actual OpenCode run prompt', async () => {
    const runner = await import(new URL(`file://${runnerPath.replace(/\\/g, '/')}`).href);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-run-solidkg-scope-'));
    const dataDir = path.join(tempDir, 'setup', 'solidkg', 'ky');

    const plan = runner.buildRunPlan({ armId: 'solidkg', repoPath: 'D:/tmp/repo', question: 'How?', out: tempDir, env: { OPENCODE_MODEL: 'stub-model' }, runId: 'r1', solidkgDataDir: dataDir });

    expect(plan.argv[1]).toContain('## SolidKG MCP Scope');
    expect(plan.argv[1]).toContain('Do not invent or override SolidKG data directories.');
    expect(plan.argv[1]).toContain(`projectPath=D:/tmp/repo and dataDir=${dataDir}`);
  });
  it('includes the peer wrapper command in the actual OpenCode run prompt', async () => {
    const runner = await import(new URL(`file://${runnerPath.replace(/\\/g, '/')}`).href);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-run-peer-plan-'));
    const peerWrapper = { name: 'tilth_wrapper', path: path.join(tempDir, 'tilth_wrapper.mjs'), command: [process.execPath, path.join(tempDir, 'tilth_wrapper.mjs')] };

    const plan = runner.buildRunPlan({ armId: 'tilth', repoPath: 'D:/tmp/repo', question: 'How?', out: tempDir, env: { OPENCODE_MODEL: 'stub-model' }, runId: 'r1', peerWrapper });

    expect(plan.argv[1]).toContain('## Peer Wrapper Command');
    expect(plan.argv[1]).toContain('tilth_wrapper.mjs');
    expect(plan.argv[1]).toContain('Run this exact wrapper command once before local fallback');
  });

  it('uses the orchestrator-rendered peer command verbatim for wrapper targets', async () => {
    const runner = await import(new URL(`file://${runnerPath.replace(/\\/g, '/')}`).href);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-peer-command-'));
    const peerCommand = ['cartog', '--db', path.join(tempDir, 'setup', 'cartog', 'gin.db'), 'ask', 'D:/tmp/repo', '--question', 'How?', '--json'];

    const paths = runner.writeIsolatedConfig({ armId: 'cartog', repoPath: 'D:/tmp/repo', question: 'How?', out: tempDir, peerCommand });
    const config = parseJsonc(fs.readFileSync(paths.opencodeConfigPath, 'utf8')) as { mcp: { cartog_wrapper: { command: string[] } } };
    const wrapperScript = fs.readFileSync(config.mcp.cartog_wrapper.command[1], 'utf8');

    expect(wrapperScript).toContain(JSON.stringify(peerCommand));
    expect(wrapperScript).toContain('gin.db');
    expect(wrapperScript).not.toContain('scenario.db');
  });

  it('records live command metadata from fixture-safe preflight and classifies missing binaries', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-preflight-'));
    const result = runHelper(['--preflight', '--out', tempDir], { OPENCODE_BIN: 'definitely-missing-opencode-bin' });

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      reason: string;
      bin: string;
      model: string;
      argvTemplate: string[];
      checkedCommands: Array<{ argv: string[]; errorCode?: string }>;
      commandCapability: { status: string; reason: string };
      transcriptCapability: { status: string; finalAnswerExtracted: boolean; toolCallCount: number };
      artifact: string;
    };
    expect(parsed.status).toBe('runner_failed');
    expect(parsed.reason).toBe('opencode_binary_not_found');
    expect(parsed.bin).toBe('definitely-missing-opencode-bin');
    expect(parsed.model).toBe('openai/gpt-5.5');
    expect(parsed.argvTemplate).toEqual(['opencode', 'run', '<message>', '--model', 'openai/gpt-5.5', '--format', 'json', '--dir', '<repoPath>', '--pure']);
    expect(parsed.checkedCommands[0].argv).toEqual(['definitely-missing-opencode-bin', '--help']);
    expect(parsed.commandCapability).toMatchObject({ status: 'unavailable', reason: 'opencode_binary_not_found' });
    expect(parsed.transcriptCapability).toMatchObject({ status: 'available', finalAnswerExtracted: true, toolCallCount: 1 });
    expect(fs.existsSync(path.join(tempDir, 'opencode-capabilities.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(parsed.artifact, 'utf8')).reason).toBe('opencode_binary_not_found');
  });

  it('passes preflight with a fake OpenCode executable that exposes noninteractive help', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-preflight-pass-'));
    const fakeBin = path.join(tempDir, process.platform === 'win32' ? 'fake-opencode.cmd' : 'fake-opencode');
    const script = process.platform === 'win32'
      ? '@echo off\r\necho Usage: opencode run [message] --format json --model model --dir repo\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho "Usage: opencode run [message] --format json --model model --dir repo"\nexit 0\n';
    fs.writeFileSync(fakeBin, script);
    if (process.platform !== 'win32') fs.chmodSync(fakeBin, 0o755);

    const result = runHelper(['--preflight', '--out', tempDir], { OPENCODE_BIN: fakeBin });

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; commandCapability: { status: string }; transcriptCapability: { status: string } };
    expect(parsed.status).toBe('pass');
    expect(parsed.commandCapability.status).toBe('available');
    expect(parsed.transcriptCapability.status).toBe('available');
  });
});
