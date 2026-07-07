/**
 * MCP project-resolution regression tests (issue #196).
 *
 * When an MCP client launches the server outside the project directory AND
 * doesn't pass a `rootUri`/`workspaceFolders` in `initialize`, the server used
 * to fall straight back to `process.cwd()` — which for many IDE clients is the
 * wrong directory. Every tool call without an explicit `projectPath` then
 * failed with a misleading "SolidKG not initialized. Run 'solidkg init'."
 *
 * The fix: when no explicit path is provided, the server asks the client for
 * its workspace root via the spec-blessed `roots/list` request (if the client
 * advertised the `roots` capability), and only falls back to cwd otherwise.
 * When it still can't resolve, the error now says exactly how to fix it.
 *
 * These tests drive the real stdio transport via a spawned subprocess — no
 * mocking — so they also exercise the new bidirectional request/response path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SolidKG } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/solidkg.js');

function spawnServer(cwd: string, args: string[] = []): ChildProcessWithoutNullStreams {
  // --no-watch keeps the test deterministic and avoids watcher startup noise.
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch', ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
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

/** Parse every JSON-RPC message the server writes to stdout into an array. */
function collectMessages(child: ChildProcessWithoutNullStreams): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });
  return messages;
}

function waitForMessage(
  messages: ReadonlyArray<Record<string, any>>,
  predicate: (m: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out. Messages so far: ${JSON.stringify(messages)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function send(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const CLIENT_INFO = { name: 'test', version: '0.0.0' };

describe('MCP project resolution via roots/list (issue #196)', () => {
  let cwdDir: string;     // where the server is launched — has NO .solidkg
  let projectDir: string; // the real indexed project the client reports
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-cwd-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-proj-'));
  });

  afterEach(async () => {
    await stopChild(child);
    child = null;
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('resolves the project from the client roots/list when no rootUri is sent', async () => {
    const cg = await SolidKG.init(projectDir);
    cg.close();

    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    // Advertise the roots capability but pass NO rootUri/workspaceFolders.
    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: CLIENT_INFO },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // First tool call (no projectPath) drives the server to ask us for roots.
    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'solidkg_status', arguments: {} } });

    const rootsReq = await waitForMessage(messages, (m) => m.method === 'roots/list', 5000);
    expect(typeof rootsReq.id).toBe('string'); // server-initiated id
    send(child, {
      jsonrpc: '2.0', id: rootsReq.id,
      result: { roots: [{ uri: `file://${projectDir}`, name: 'proj' }] },
    });

    // The status call now succeeds against the resolved project.
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;
    expect(text).toContain('SolidKG Status');
    expect(text).not.toContain('No SolidKG project is loaded');
  }, 20000);

  it('returns an actionable error when there is no rootUri and no roots capability', async () => {
    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'solidkg_status', arguments: {} } });
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;

    expect(text).toContain('No SolidKG project is loaded');
    expect(text).toContain('projectPath');
    expect(text).toContain('--path');
    // Names the directory it actually searched (the wrong cwd) so the user can
    // see why detection missed. basename survives any symlink realpath-ing.
    expect(text).toContain(path.basename(cwdDir));
    // It must not have hung waiting on roots/list — the client never offered it.
    expect(messages.some((m) => m.method === 'roots/list')).toBe(false);
  }, 20000);

  it('honors an explicit rootUri without asking the client for roots', async () => {
    const cg = await SolidKG.init(projectDir);
    cg.close();

    child = spawnServer(cwdDir);
    const messages = collectMessages(child);

    send(child, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { roots: {} },
        clientInfo: CLIENT_INFO,
        rootUri: `file://${projectDir}`,
      },
    });
    await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'solidkg_status', arguments: {} } });
    const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
    const text = resp.result.content[0].text as string;

    expect(text).toContain('SolidKG Status');
    // rootUri is a stronger signal than roots — we never needed to ask.
    expect(messages.some((m) => m.method === 'roots/list')).toBe(false);
  }, 20000);

  it('keeps same relative paths distinct across project and extra roots in MCP responses', async () => {
    const extraRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-extra-'));
    const projectSharedPath = path.join(projectDir, 'src', 'shared.ts');
    const extraSharedPath = path.join(extraRootDir, 'src', 'shared.ts');
    const projectScipPath = path.join(projectDir, 'src', 'scip', 'index.ts');
    const extraScipPath = path.join(extraRootDir, 'src', 'scip', 'index.ts');
    const projectComponentPath = path.join(projectDir, 'src', 'components', 'button.ts');
    const extraComponentPath = path.join(extraRootDir, 'src', 'components', 'button.ts');
    const projectLabel = path.basename(projectDir);
    const extraLabel = path.basename(extraRootDir);
    const projectIndexedPath = `@${projectLabel}/src/shared.ts`;
    const extraIndexedPath = `@${extraLabel}/src/shared.ts`;
    const projectScipIndexedPath = `@${projectLabel}/src/scip/index.ts`;
    const extraScipIndexedPath = `@${extraLabel}/src/scip/index.ts`;
    const projectComponentIndexedPath = `@${projectLabel}/src/components/button.ts`;
    const extraComponentIndexedPath = `@${extraLabel}/src/components/button.ts`;

    try {
      fs.mkdirSync(path.dirname(projectSharedPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraSharedPath), { recursive: true });
      fs.mkdirSync(path.dirname(projectScipPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraScipPath), { recursive: true });
      fs.mkdirSync(path.dirname(projectComponentPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraComponentPath), { recursive: true });
      fs.writeFileSync(
        projectSharedPath,
        'export function sameRelativeShared() { return "project-root-marker"; }\n',
      );
      fs.writeFileSync(
        extraSharedPath,
        'export function sameRelativeShared() { return "extra-root-marker"; }\n',
      );
      fs.writeFileSync(
        projectScipPath,
        'export function projectScipIndex() { return "project-scip-marker"; }\n',
      );
      fs.writeFileSync(
        extraScipPath,
        'export function extraScipIndex() { return "extra-scip-marker"; }\n',
      );
      fs.writeFileSync(
        projectComponentPath,
        'export function projectComponentButton() { return "project-component-marker"; }\n',
      );
      fs.writeFileSync(
        extraComponentPath,
        'export function extraComponentButton() { return "extra-component-marker"; }\n',
      );

      const cg = await SolidKG.init(projectDir, { index: true, extraRoots: [extraRootDir] });
      const indexedFiles = cg.getFiles().map((file) => file.path);
      expect(indexedFiles).toContain(projectIndexedPath);
      expect(indexedFiles).toContain(extraIndexedPath);
      expect(indexedFiles).toContain(projectScipIndexedPath);
      expect(indexedFiles).toContain(extraScipIndexedPath);
      expect(indexedFiles).toContain(projectComponentIndexedPath);
      expect(indexedFiles).toContain(extraComponentIndexedPath);
      cg.close();

      child = spawnServer(cwdDir);
      const messages = collectMessages(child);

      send(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: CLIENT_INFO,
          rootUri: `file://${projectDir}`,
        },
      });
      await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const callFiles = async (id: number, args: Record<string, unknown>) => {
        send(child!, {
          jsonrpc: '2.0', id, method: 'tools/call',
          params: { name: 'solidkg_files', arguments: { format: 'flat', includeMetadata: false, ...args } },
        });
        const response = await waitForMessage(messages, (m) => m.id === id, 8000);
        return response.result.content[0].text as string;
      };

      const filesText = await callFiles(1, {});
      expect(filesText).toContain(projectIndexedPath);
      expect(filesText).toContain(extraIndexedPath);
      expect(filesText).toContain(projectScipIndexedPath);
      expect(filesText).toContain(extraScipIndexedPath);
      expect(filesText).toContain(projectComponentIndexedPath);
      expect(filesText).toContain(extraComponentIndexedPath);

      for (const [index, rootFilter] of ['', '.', './', '/', '\\'].entries()) {
        const rootFilteredText = await callFiles(10 + index, { path: rootFilter });
        expect(rootFilteredText).toContain(projectIndexedPath);
        expect(rootFilteredText).toContain(extraIndexedPath);
        expect(rootFilteredText).toContain(projectScipIndexedPath);
        expect(rootFilteredText).toContain(extraScipIndexedPath);
        expect(rootFilteredText).toContain(projectComponentIndexedPath);
        expect(rootFilteredText).toContain(extraComponentIndexedPath);
      }

      const filteredFilesText = await callFiles(5, { path: 'src/scip' });
      expect(filteredFilesText).toContain(projectScipIndexedPath);
      expect(filteredFilesText).toContain(extraScipIndexedPath);
      expect(filteredFilesText).not.toMatch(/^## Project Structure \(1 files\)\s+└── src\s*$/m);

      for (const [index, srcFilter] of ['/src', './src'].entries()) {
        const srcFilteredText = await callFiles(20 + index, { path: srcFilter });
        expect(srcFilteredText).toContain(projectIndexedPath);
        expect(srcFilteredText).toContain(extraIndexedPath);
        expect(srcFilteredText).toContain(projectScipIndexedPath);
        expect(srcFilteredText).toContain(extraScipIndexedPath);
        expect(srcFilteredText).toContain(projectComponentIndexedPath);
        expect(srcFilteredText).toContain(extraComponentIndexedPath);
      }

      const componentFilteredText = await callFiles(22, { path: 'src\\components' });
      expect(componentFilteredText).toContain(projectComponentIndexedPath);
      expect(componentFilteredText).toContain(extraComponentIndexedPath);
      expect(componentFilteredText).not.toContain(projectIndexedPath);
      expect(componentFilteredText).not.toContain(extraIndexedPath);
      expect(componentFilteredText).not.toContain(projectScipIndexedPath);
      expect(componentFilteredText).not.toContain(extraScipIndexedPath);

      send(child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'solidkg_search', arguments: { query: 'sameRelativeShared', limit: 10 } },
      });
      const searchResp = await waitForMessage(messages, (m) => m.id === 2, 8000);
      const searchText = searchResp.result.content[0].text as string;
      expect(searchText).toContain(projectIndexedPath);
      expect(searchText).toContain(extraIndexedPath);

      send(child, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'solidkg_node',
          arguments: { symbol: `@${projectLabel}/src/shared/sameRelativeShared`, includeCode: true },
        },
      });
      const projectNodeResp = await waitForMessage(messages, (m) => m.id === 3, 8000);
      const projectNodeText = projectNodeResp.result.content[0].text as string;
      expect(projectNodeText).toContain(projectIndexedPath);
      expect(projectNodeText).toContain('project-root-marker');
      expect(projectNodeText).not.toContain('extra-root-marker');

      send(child, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'solidkg_node',
          arguments: { symbol: `@${extraLabel}/src/shared/sameRelativeShared`, includeCode: true },
        },
      });
      const extraNodeResp = await waitForMessage(messages, (m) => m.id === 4, 8000);
      const extraNodeText = extraNodeResp.result.content[0].text as string;
      expect(extraNodeText).toContain(extraIndexedPath);
      expect(extraNodeText).toContain('extra-root-marker');
      expect(extraNodeText).not.toContain('project-root-marker');
    } finally {
      await stopChild(child);
      child = null;
      fs.rmSync(extraRootDir, { recursive: true, force: true });
    }
  }, 20000);

  it('abstains from ambiguous unqualified same-relative source lookup across project and extra roots', async () => {
    const extraRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-extra-'));
    const projectSharedPath = path.join(projectDir, 'src', 'shared.ts');
    const extraSharedPath = path.join(extraRootDir, 'src', 'shared.ts');
    const projectLabel = path.basename(projectDir);
    const extraLabel = path.basename(extraRootDir);
    const projectIndexedPath = `@${projectLabel}/src/shared.ts`;
    const extraIndexedPath = `@${extraLabel}/src/shared.ts`;

    try {
      fs.mkdirSync(path.dirname(projectSharedPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraSharedPath), { recursive: true });
      fs.writeFileSync(
        projectSharedPath,
        'export function ambiguousRelativeShared() { return "ambiguous-project-root-marker"; }\n',
      );
      fs.writeFileSync(
        extraSharedPath,
        'export function ambiguousRelativeShared() { return "ambiguous-extra-root-marker"; }\n',
      );

      const cg = await SolidKG.init(projectDir, { index: true, extraRoots: [extraRootDir] });
      const indexedFiles = cg.getFiles().map((file) => file.path);
      expect(indexedFiles).toContain(projectIndexedPath);
      expect(indexedFiles).toContain(extraIndexedPath);
      cg.close();

      child = spawnServer(cwdDir);
      const messages = collectMessages(child);

      send(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: CLIENT_INFO,
          rootUri: `file://${projectDir}`,
        },
      });
      await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      send(child, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'solidkg_files', arguments: { format: 'flat', includeMetadata: false } },
      });
      const filesResp = await waitForMessage(messages, (m) => m.id === 1, 8000);
      const filesText = filesResp.result.content[0].text as string;
      expect(filesText).toContain(projectIndexedPath);
      expect(filesText).toContain(extraIndexedPath);

      send(child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'solidkg_node',
          arguments: { symbol: 'src/shared/ambiguousRelativeShared', includeCode: true },
        },
      });
      const nodeResp = await waitForMessage(messages, (m) => m.id === 2, 8000);
      const nodeText = nodeResp.result.content[0].text as string;
      const abstainedOrAskedForQualification = /ambiguous|disambiguat|qualif|not found|no matching symbol/i.test(nodeText);
      const returnedNeitherRootMarker = !nodeText.includes('ambiguous-project-root-marker')
        && !nodeText.includes('ambiguous-extra-root-marker');

      expect(abstainedOrAskedForQualification || returnedNeitherRootMarker).toBe(true);
    } finally {
      await stopChild(child);
      child = null;
      fs.rmSync(extraRootDir, { recursive: true, force: true });
    }
  }, 20000);

  it('keeps duplicate-root context source-bearing output root-qualified and fail-closed for unlabeled ambiguity', async () => {
    const extraRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-extra-'));
    const projectSharedPath = path.join(projectDir, 'src', 'context-shared.ts');
    const extraSharedPath = path.join(extraRootDir, 'src', 'context-shared.ts');
    const projectLabel = path.basename(projectDir);
    const extraLabel = path.basename(extraRootDir);

    try {
      fs.mkdirSync(path.dirname(projectSharedPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraSharedPath), { recursive: true });
      fs.writeFileSync(
        projectSharedPath,
        'export function contextDuplicateShared() { return "context-project-root-marker"; }\n',
      );
      fs.writeFileSync(
        extraSharedPath,
        'export function contextDuplicateShared() { return "context-extra-root-marker"; }\n',
      );

      const cg = await SolidKG.init(projectDir, { index: true, extraRoots: [extraRootDir] });
      cg.close();

      child = spawnServer(cwdDir);
      const messages = collectMessages(child);

      send(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: CLIENT_INFO,
          rootUri: `file://${projectDir}`,
        },
      });
      await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      send(child, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'solidkg_context',
          arguments: {
            task: `@${projectLabel}/src/context-shared/contextDuplicateShared`,
            includeCode: true,
            maxCodeBlocks: 2,
          },
        },
      });
      const qualifiedResp = await waitForMessage(messages, (m) => m.id === 1, 8000);
      const qualifiedText = qualifiedResp.result.content[0].text as string;
      expect(qualifiedText).toContain('context-project-root-marker');
      expect(qualifiedText).not.toContain('context-extra-root-marker');

      send(child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'solidkg_context',
          arguments: {
            task: 'src/context-shared/contextDuplicateShared',
            includeCode: true,
            maxCodeBlocks: 2,
          },
        },
      });
      const unlabeledResp = await waitForMessage(messages, (m) => m.id === 2, 8000);
      const unlabeledText = unlabeledResp.result.content[0].text as string;
      const abstainedOrMarkedUnreadable = /ambiguous|disambiguat|qualif|unreadable|not found|no matching symbol|omitted/i.test(unlabeledText);
      const returnedNeitherRootMarker = !unlabeledText.includes('context-project-root-marker')
        && !unlabeledText.includes('context-extra-root-marker');

      expect(abstainedOrMarkedUnreadable || returnedNeitherRootMarker).toBe(true);
    } finally {
      await stopChild(child);
      child = null;
      fs.rmSync(extraRootDir, { recursive: true, force: true });
    }
  }, 20000);

  it('keeps duplicate-root explore source-bearing output root-qualified and fail-closed for unlabeled ambiguity', async () => {
    const extraRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-extra-'));
    const projectSharedPath = path.join(projectDir, 'src', 'explore-shared.ts');
    const extraSharedPath = path.join(extraRootDir, 'src', 'explore-shared.ts');
    const projectLabel = path.basename(projectDir);

    try {
      fs.mkdirSync(path.dirname(projectSharedPath), { recursive: true });
      fs.mkdirSync(path.dirname(extraSharedPath), { recursive: true });
      fs.writeFileSync(
        projectSharedPath,
        'export function exploreDuplicateShared() { return "explore-project-root-marker"; }\n',
      );
      fs.writeFileSync(
        extraSharedPath,
        'export function exploreDuplicateShared() { return "explore-extra-root-marker"; }\n',
      );

      const cg = await SolidKG.init(projectDir, { index: true, extraRoots: [extraRootDir] });
      cg.close();

      child = spawnServer(cwdDir);
      const messages = collectMessages(child);

      send(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: CLIENT_INFO,
          rootUri: `file://${projectDir}`,
        },
      });
      await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      send(child, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'solidkg_explore',
          arguments: { query: `@${projectLabel}/src/explore-shared/exploreDuplicateShared`, maxFiles: 2 },
        },
      });
      const qualifiedResp = await waitForMessage(messages, (m) => m.id === 1, 8000);
      const qualifiedText = qualifiedResp.result.content[0].text as string;
      expect(qualifiedText).toContain('explore-project-root-marker');
      expect(qualifiedText).not.toContain('explore-extra-root-marker');

      send(child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'solidkg_explore',
          arguments: { query: 'src/explore-shared/exploreDuplicateShared', maxFiles: 2 },
        },
      });
      const unlabeledResp = await waitForMessage(messages, (m) => m.id === 2, 8000);
      const unlabeledText = unlabeledResp.result.content[0].text as string;
      const abstainedOrMarkedUnreadable = /ambiguous|disambiguat|qualif|unreadable|not found|no matching symbol|omitted/i.test(unlabeledText);
      const returnedNeitherRootMarker = !unlabeledText.includes('explore-project-root-marker')
        && !unlabeledText.includes('explore-extra-root-marker');

      expect(abstainedOrMarkedUnreadable || returnedNeitherRootMarker).toBe(true);
    } finally {
      await stopChild(child);
      child = null;
      fs.rmSync(extraRootDir, { recursive: true, force: true });
    }
  }, 20000);

  it('honors --data-dir when resolving rootUri projects', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-data-'));
    try {
      const cg = await SolidKG.init(projectDir, { dataDir });
      cg.close();

      child = spawnServer(cwdDir, ['--data-dir', dataDir]);
      const messages = collectMessages(child);

      send(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: CLIENT_INFO,
          rootUri: `file://${projectDir}`,
        },
      });
      await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'solidkg_status', arguments: {} } });
      const resp = await waitForMessage(messages, (m) => m.id === 1, 8000);
      const text = resp.result.content[0].text as string;

      expect(text).toContain('SolidKG Status');
      expect(text).toContain(path.resolve(dataDir));
      expect(fs.existsSync(path.join(projectDir, '.solidkg'))).toBe(false);
    } finally {
      await stopChild(child);
      child = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20000);
});
