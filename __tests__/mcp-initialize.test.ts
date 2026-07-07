/**
 * MCP `initialize` handshake regression tests.
 *
 * Issue #172: on slow filesystems (Docker Desktop VirtioFS on macOS, WSL2),
 * the MCP server was blocking the initialize response on SolidKG.open() and
 * Parser.init() (web-tree-sitter WASM bootstrap), which could take longer than
 * Claude Code's ~30s handshake timeout. The child process stayed alive and
 * had received the request, but never sent a response, so tools never
 * appeared in the client. The fix sends the initialize response before
 * kicking off the heavy init in the background. These tests guard the
 * contract that initialize is fast regardless of how much work init does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SolidKG } from '../src';
import { MCPSession } from '../src/mcp/session';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse, JsonRpcTransport, MessageHandler } from '../src/mcp/transport';

const BIN = path.resolve(__dirname, '../dist/bin/solidkg.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Pin to direct (in-process) mode. #172 is a contract about the in-process
    // server's init ordering — the "File watcher active" log this test observes
    // is emitted in-process. In daemon mode the watcher runs in the detached
    // daemon (logging to .solidkg/daemon.log, not the child's stderr); the
    // same response-before-init guarantee lives in the shared session code and
    // is covered by mcp-daemon.test.ts. Direct mode also avoids leaking a
    // detached daemon from this suite.
    env: { ...process.env, SOLIDKG_NO_DAEMON: '1', SOLIDKG_NO_RELAUNCH: '1' },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', (err) => { void err; });
  child.stdin.on('error', (err) => { void err; });
  return child;
}

async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.end(); } catch (err) { void err; }
  if (await waitForChildClose(child, 1000)) return;
  child.kill('SIGTERM');
  if (await waitForChildClose(child, 1000)) return;
  child.kill('SIGKILL');
  await waitForChildClose(child, 2000);
}

function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function sendInitialize(child: ChildProcessWithoutNullStreams, projectPath: string) {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${projectPath}`,
    },
  });
  child.stdin.write(msg + '\n');
}

/**
 * Collect stdout lines and stderr text from the child, tagging each piece
 * with a monotonic sequence number. Lets us assert ordering between the
 * JSON-RPC response (stdout) and side-effect logs (stderr).
 */
function tagStreams(child: ChildProcessWithoutNullStreams) {
  const events: Array<{ seq: number; stream: 'stdout' | 'stderr'; text: string }> = [];
  let seq = 0;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stdout', text: line });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stderr', text: line });
    }
  });
  return events;
}

function waitFor<T>(
  events: ReadonlyArray<{ seq: number; stream: string; text: string }>,
  predicate: (e: { seq: number; stream: string; text: string }) => boolean,
  timeoutMs: number,
): Promise<{ seq: number; stream: string; text: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for predicate. Events: ${JSON.stringify(events)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('MCP initialize handshake (issue #172)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-init-'));
  });

  afterEach(async () => {
    await stopChild(child);
    child = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('responds to initialize quickly when no .solidkg exists in cwd', async () => {
    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);
    const response = await waitFor(events, (e) => e.stream === 'stdout', 5000);
    const json = JSON.parse(response.text);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(0);
    expect(json.result.protocolVersion).toBeDefined();
    expect(json.result.capabilities.tools).toBeDefined();
  }, 10000);

  it('sends initialize response BEFORE tryInitializeDefault finishes', async () => {
    // Seed a real .solidkg so the server's tryInitializeDefault path runs
    // its full body: SolidKG.open() and then startWatching() (which logs
    // "File watcher active" to stderr). On any
    // platform, that stderr log is observable evidence that tryInitializeDefault
    // has completed. The contract we're protecting: the JSON-RPC response on
    // stdout must arrive BEFORE that stderr log. If a future change re-awaits
    // tryInitializeDefault before sendResult, this ordering inverts and the
    // test fails — regardless of how fast the local filesystem is.
    const cg = await SolidKG.init(tempDir);
    cg.close();

    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);

    const response = await waitFor(events, (e) => e.stream === 'stdout', 10000);
    const watcherLog = await waitFor(
      events,
      (e) => e.stream === 'stderr' && e.text.includes('File watcher active'),
      10000,
    );
    expect(response.seq).toBeLessThan(watcherLog.seq);
    const json = JSON.parse(response.text);
    expect(json.id).toBe(0);
    expect(json.result.serverInfo.name).toBe('solidkg');
  }, 20000);
});

describe('MCP initialize instructions', () => {
  it('documents provider-neutral Code Context query precision', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Make Code Context queries precise');
    expect(SERVER_INSTRUCTIONS).toContain('concrete symbols, classes');
    expect(SERVER_INSTRUCTIONS).toContain('annotations, framework keywords');
    expect(SERVER_INSTRUCTIONS).toContain('EventPublisher Consumer DomainEvent StreamBridge @Async');
    expect(SERVER_INSTRUCTIONS).not.toContain('Claude Code');
  });

  it('documents raw tool names without encouraging double prefixes', () => {
    expect(SERVER_INSTRUCTIONS).toContain('raw MCP server tool names');
    expect(SERVER_INSTRUCTIONS).toContain('solidkg_*');
    expect(SERVER_INSTRUCTIONS).toContain('host-specific server prefix');
    expect(SERVER_INSTRUCTIONS).toContain('do not add another');
    expect(SERVER_INSTRUCTIONS).not.toContain('solidkg_solidkg_context');
  });

  it('keeps flow, precise refs, and already-read source guidance together', () => {
    expect(SERVER_INSTRUCTIONS).toContain('solidkg_trace');
    expect(SERVER_INSTRUCTIONS).toContain('solidkg_precise_refs');
    expect(SERVER_INSTRUCTIONS).toContain('Treat it as already read');
  });

  it('documents source chunk evidence and disabled hybrid defaults', () => {
    expect(SERVER_INSTRUCTIONS).toContain('source_body_chunk');
    expect(SERVER_INSTRUCTIONS).toContain('persisted source-body/code-token chunks');
    expect(SERVER_INSTRUCTIONS).toContain('External dense/vector embeddings');
    expect(SERVER_INSTRUCTIONS).toContain('not enabled by default');
    expect(SERVER_INSTRUCTIONS).toContain('do not assume LanceDB, API keys, network calls, or telemetry are active');
  });

  it('documents overview repository orientation guidance', () => {
    expect(SERVER_INSTRUCTIONS).toContain('solidkg_files');
    expect(SERVER_INSTRUCTIONS).toContain('format: "overview"');
    expect(SERVER_INSTRUCTIONS).toContain('Repository orientation');
    expect(SERVER_INSTRUCTIONS).toContain('derived from the index');
  });
});

class CapturingTransport implements JsonRpcTransport {
  handler: MessageHandler | null = null;
  responses: JsonRpcResponse[] = [];

  start(handler: MessageHandler): void {
    this.handler = handler;
  }

  stop(): void {}

  send(response: JsonRpcResponse): void {
    this.responses.push(response);
  }

  notify(_method: string, _params?: unknown): void {}

  request(_method: string, _params?: unknown, _timeoutMs?: number): Promise<unknown> {
    return Promise.resolve({ roots: [] });
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  receive(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.handler) throw new Error('transport not started');
    return this.handler(message);
  }
}

async function waitForResponse(
  transport: CapturingTransport,
  id: string | number,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const response = transport.responses.find((item) => item.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for response ${id}`);
}

describe('MCP tool call timeout', () => {
  const originalTimeout = process.env.SOLIDKG_MCP_TOOL_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.SOLIDKG_MCP_TOOL_TIMEOUT_MS;
    else process.env.SOLIDKG_MCP_TOOL_TIMEOUT_MS = originalTimeout;
  });

  it('returns a bounded tool error when solidkg_context does not finish', async () => {
    process.env.SOLIDKG_MCP_TOOL_TIMEOUT_MS = '25';
    const transport = new CapturingTransport();
    const engine = {
      getToolHandler: () => ({
        execute: () => new Promise(() => {}),
        getTools: () => [],
      }),
      hasDefaultSolidKG: () => true,
      getProjectPath: () => null,
      retryInitializeSync: () => {},
    };
    const session = new MCPSession(transport, engine as any);
    session.start();

    await transport.receive({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'solidkg_context', arguments: { task: 'review context output' } },
    });

    const response = await waitForResponse(transport, 13, 500);
    const result = response.result as { isError?: boolean; content?: Array<{ text: string }> };
    expect(response.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('Tool solidkg_context timed out after 25ms');
  });
});
