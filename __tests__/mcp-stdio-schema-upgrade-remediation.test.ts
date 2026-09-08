import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import SolidKG, { getDatabasePath } from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/solidkg.js');
const REMEDIATION = 'SolidKG schema 10 must be upgraded to 11 before architecture health or snapshot drift can be read. Run "solidkg sync <project>" once with write access, then retry.';

type PendingResponse = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getResultText(result: unknown): string {
  if (!isRecord(result) || result['isError'] !== true || !Array.isArray(result['content'])) {
    throw new Error(`Expected an MCP tool error result, received ${JSON.stringify(result)}`);
  }
  const content = result['content'][0];
  if (!isRecord(content) || typeof content['text'] !== 'string') {
    throw new Error(`Expected MCP text content, received ${JSON.stringify(result)}`);
  }
  return content['text'];
}

function spawnServer(cwd: string, fullProfile: boolean): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLIDKG_NO_DAEMON: '1',
    SOLIDKG_NO_RELAUNCH: '1',
    SOLIDKG_NO_WATCH: '1',
  };
  if (fullProfile) env.SOLIDKG_MCP_TOOLS = 'all';
  else delete env.SOLIDKG_MCP_TOOLS;

  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch'], { cwd, env, stdio: 'pipe' });
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stderr.on('data', () => undefined);
  return child;
}

async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  if (await waitForClose(child, 1_000)) return;
  child.kill('SIGTERM');
  if (await waitForClose(child, 1_000)) return;
  child.kill('SIGKILL');
  await waitForClose(child, 2_000);
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('close', close);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const close = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('close', close);
  });
}

function createClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, PendingResponse>();
  let nextId = 1;
  let buffered = '';

  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      const message: unknown = JSON.parse(buffered.slice(0, newlineIndex));
      buffered = buffered.slice(newlineIndex + 1);
      if (isRecord(message) && typeof message['id'] === 'number' && 'result' in message) {
        const response = pending.get(message['id']);
        if (response) {
          clearTimeout(response.timeout);
          pending.delete(message['id']);
          response.resolve(message['result']);
        }
      }
      newlineIndex = buffered.indexOf('\n');
    }
  });

  const rejectPending = (error: Error) => {
    for (const response of pending.values()) {
      clearTimeout(response.timeout);
      response.reject(error);
    }
    pending.clear();
  };
  child.once('error', rejectPending);
  child.once('close', () => rejectPending(new Error('MCP child closed before responding')));

  return {
    request(method: string, params: Record<string, unknown>): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}`));
        }, 10_000);
        timeout.unref();
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

describe('stdio MCP schema-upgrade remediation', () => {
  let projectDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-stdio-schema-v10-'));
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export const version = 10;\n');
    const graph = await SolidKG.init(projectDir, { index: true });
    graph.destroy();

    const connection = DatabaseConnection.open(getDatabasePath(projectDir));
    try {
      connection.getDb().exec('DELETE FROM schema_versions');
      connection.getDb().prepare(
        'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(10, Date.now(), 'schema v10 test fixture');
    } finally {
      connection.close();
    }
  });

  afterEach(async () => {
    await stopChild(child);
    child = null;
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns exact remediation through advanced actions and compact explore', async () => {
    child = spawnServer(projectDir, true);
    const advanced = createClient(child);
    const initialization = await advanced.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, rootUri: `file://${projectDir}`,
    });
    const tools = await advanced.request('tools/list', {});
    const health = await advanced.request('tools/call', {
      name: 'solidkg_architecture', arguments: { action: 'health', projectPath: projectDir },
    });
    const drift = await advanced.request('tools/call', {
      name: 'solidkg_snapshot', arguments: { action: 'drift', label: 'baseline', projectPath: projectDir },
    });

    expect(initialization).toEqual(expect.objectContaining({ serverInfo: expect.any(Object) }));
    expect(tools).toEqual(expect.objectContaining({ tools: expect.arrayContaining([
      expect.objectContaining({ name: 'solidkg_architecture' }),
      expect.objectContaining({ name: 'solidkg_snapshot' }),
    ]) }));
    expect(getResultText(health)).toBe(REMEDIATION);
    expect(getResultText(drift)).toBe(REMEDIATION);

    await stopChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    child = spawnServer(projectDir, false);
    const compact = createClient(child);
    await compact.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, rootUri: `file://${projectDir}`,
    });
    const exploreHealth = await compact.request('tools/call', {
      name: 'solidkg_explore', arguments: { query: 'Show repository architecture health', projectPath: projectDir },
    });
    const exploreDrift = await compact.request('tools/call', {
      name: 'solidkg_explore', arguments: { query: 'What architecture health drifted since baseline?', projectPath: projectDir },
    });

    expect(getResultText(exploreHealth)).toBe(REMEDIATION);
    expect(getResultText(exploreDrift)).toBe(REMEDIATION);
    await stopChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30_000);
});
