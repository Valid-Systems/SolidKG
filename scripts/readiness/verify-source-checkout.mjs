#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJsonPath = join(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const cliPath = join(repoRoot, 'dist', 'bin', 'solidkg.js');
const nativeGrammarMapPath = join(repoRoot, 'src', 'extraction', 'native-grammars.json');
const nativeGrammarMap = JSON.parse(readFileSync(nativeGrammarMapPath, 'utf8'));
const requiredVendoredIndexers = [
  { name: 'scip-clang', entrypoint: 'indexer/main.cc', license: 'LICENSE' },
  { name: 'scip-dart', entrypoint: 'bin/scip_dart.dart', license: 'LICENSE' },
  { name: 'scip-dotnet', entrypoint: 'ScipDotnet/Program.cs', license: 'LICENSE' },
  { name: 'scip-java', entrypoint: 'scip-java/src/main/scala/com/sourcegraph/scip_java/ScipJava.scala', license: 'LICENSE' },
  { name: 'scip-php', entrypoint: 'bin/scip-php', license: 'LICENSE' },
  { name: 'scip-python', entrypoint: 'packages/pyright-scip/src/main.ts', license: 'LICENSE.txt' },
  { name: 'scip-ruby', entrypoint: 'gems/scip-ruby/bin/scip-ruby', license: 'LICENSE' },
  { name: 'scip-typescript', entrypoint: 'src/main.ts', license: 'LICENSE' },
];

function pass(message) {
  console.log(`PASS ${message}`);
}

function nativeLibraryName(libraryName) {
  if (process.platform === 'win32') return `tree_sitter_${libraryName}.dll`;
  if (process.platform === 'darwin') return `libtree_sitter_${libraryName}.dylib`;
  return `libtree_sitter_${libraryName}.so`;
}

function assertReady(condition, message, correction) {
  if (condition) {
    pass(message);
    return;
  }
  throw new Error(`${message}\nCorrection: ${correction}`);
}

function run(command, args, options = {}) {
  const useCmd = process.platform === 'win32' &&
    (command === 'pnpm' || command === 'npm' || command.toLowerCase().endsWith('.cmd'));
  const executable = useCmd ? 'cmd.exe' : command;
  const finalArgs = useCmd ? ['/d', '/s', '/c', command, ...args] : args;
  const result = spawnSync(executable, finalArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(
      `${[command, ...args].join(' ')} failed${result.status == null ? '' : ` with exit code ${result.status}`}` +
      `${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout;
}

function checkToolchain() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assertReady(
    nodeMajor === 24,
    `Node ${process.versions.node} satisfies the source-checkout Node 24 contract`,
    'Switch to Node 24, remove node_modules created by another Node major, and run pnpm install --frozen-lockfile again.',
  );

  const packageManager = String(packageJson.packageManager ?? '');
  const expectedPnpm = packageManager.startsWith('pnpm@') ? packageManager.slice('pnpm@'.length) : '';
  assertReady(
    expectedPnpm.length > 0,
    'package.json pins the pnpm toolchain',
    'Restore the committed packageManager field instead of choosing an unpinned pnpm version.',
  );
  const actualPnpm = run('pnpm', ['--version']).trim();
  assertReady(
    actualPnpm === expectedPnpm,
    `pnpm ${actualPnpm} matches package.json`,
    `Enable Corepack for this checkout or install pnpm ${expectedPnpm}, then rerun pnpm install --frozen-lockfile.`,
  );
}

function checkSourceInputs() {
  const requiredFiles = [
    'LICENSE',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'vitest.config.ts',
    'src/db/schema.sql',
    'src/extraction/grammars.ts',
    'src/extraction/native-grammars.json',
    'src/bin/solidkg.ts',
    'scripts/prepare-native-runtime.mjs',
    'scripts/copy-native-grammars.mjs',
  ];
  const missing = requiredFiles.filter((file) => !existsSync(join(repoRoot, file)));
  assertReady(
    missing.length === 0,
    'source checkout contains every required manifest, schema, and entrypoint',
    `Re-download or re-clone the same commit; required files are missing: ${missing.join(', ') || '(unknown)'}.`,
  );

  const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  assertReady(
    packageLock.version === packageJson.version && packageLock.packages?.['']?.version === packageJson.version,
    'package.json and package-lock.json versions agree',
    'Update the lock with the repository release workflow or a reviewed npm --package-lock-only change; do not hand-edit dependency resolutions.',
  );
  assertReady(
    packageJson.license === 'MIT' &&
      packageLock.packages?.['']?.license === packageJson.license,
    'source and lock manifests declare the MIT license',
    'Restore LICENSE and keep package.json plus package-lock.json license metadata set to MIT.',
  );

  const grammarMappings = Object.values(nativeGrammarMap);
  const nativeFiles = [...new Set(grammarMappings.map(({ libraryName }) => nativeLibraryName(libraryName)))].sort();
  assertReady(
    grammarMappings.length === 33 && nativeFiles.length === 32,
    'native parser manifest maps 33 language identifiers to 32 shared libraries',
    'Restore src/extraction/native-grammars.json from the same commit; JSX intentionally shares the JavaScript library.',
  );

  const vendoredFiles = [
    'vendored/README.md',
    ...requiredVendoredIndexers.flatMap(({ name, entrypoint, license }) => [
      `vendored/${name}/${entrypoint}`,
      `vendored/${name}/${license}`,
    ]),
  ];
  const missingOrEmptyVendored = vendoredFiles.filter((file) => {
    const fullPath = join(repoRoot, file);
    return !existsSync(fullPath) || statSync(fullPath).size === 0;
  });
  assertReady(
    missingOrEmptyVendored.length === 0,
    `source checkout contains all ${requiredVendoredIndexers.length} pinned SolidKG-maintained SCIP indexer trees`,
    `Re-download or re-clone the same commit. Do not substitute floating upstream indexers; missing or empty files: ${missingOrEmptyVendored.join(', ') || '(unknown)'}.`,
  );
  return nativeFiles;
}

function verifyBuiltAssets(expectedNativeFiles) {
  run('pnpm', ['run', 'build']);
  pass('TypeScript build completed');

  assertReady(
    existsSync(cliPath),
    'built CLI entrypoint exists',
    'Run pnpm run build and fix the first compiler or asset-copy error.',
  );

  const sourceSchema = readFileSync(join(repoRoot, 'src', 'db', 'schema.sql'));
  const builtSchemaPath = join(repoRoot, 'dist', 'db', 'schema.sql');
  assertReady(
    existsSync(builtSchemaPath) && sourceSchema.equals(readFileSync(builtSchemaPath)),
    'built database schema is byte-identical to the source schema',
    'Run pnpm run copy-assets, then repair the build script if dist/db/schema.sql is still missing or stale.',
  );

  const builtGrammarMapPath = join(repoRoot, 'dist', 'extraction', 'native-grammars.json');
  assertReady(
    existsSync(builtGrammarMapPath) && readFileSync(nativeGrammarMapPath).equals(readFileSync(builtGrammarMapPath)),
    'built native grammar manifest is byte-identical to the source manifest',
    'Run pnpm run copy-assets and keep package.json copy-assets aligned with src/extraction/native-grammars.json.',
  );

  const nativeDir = join(repoRoot, '.native-grammars', `${process.platform}-${process.arch}`);
  const stagedNativeFiles = existsSync(nativeDir) ? readdirSync(nativeDir).filter((file) => expectedNativeFiles.includes(file)).sort() : [];
  assertReady(
    JSON.stringify(stagedNativeFiles) === JSON.stringify(expectedNativeFiles) &&
      stagedNativeFiles.every((file) => statSync(join(nativeDir, file)).size > 0),
    `build staged all ${expectedNativeFiles.length} non-empty native parser libraries for ${process.platform}-${process.arch}`,
    'Run pnpm run prepare:native-runtime with network access, then repair the first missing or empty native grammar asset.',
  );
  assertReady(
    !existsSync(join(repoRoot, 'dist', 'extraction', 'wasm')),
    'built artifacts contain no obsolete parser WASM directory',
    'Run pnpm run clean followed by pnpm run build; remove stale WASM copy logic from package scripts.',
  );

  const versionOutput = run(process.execPath, [cliPath, '--version']).trim();
  assertReady(
    versionOutput.includes(packageJson.version),
    `built CLI reports version ${packageJson.version}`,
    'Rebuild dist from this checkout and verify package.json is the version authority.',
  );
  const helpOutput = run(process.execPath, [cliPath, '--help']);
  assertReady(
    helpOutput.includes('serve') && helpOutput.includes('install') && helpOutput.includes('init'),
    'built CLI exposes install, init, and MCP serve commands',
    'Fix the CLI build/registration failure, then rerun pnpm run verify:source.',
  );
}

async function smokeGraphAndMcp() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'solidkg-source-readiness-'));
  const projectPath = join(tempRoot, 'fixture');
  const profilePath = join(tempRoot, 'profile');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  mkdirSync(profilePath, { recursive: true });
  writeFileSync(
    join(projectPath, 'src', 'math.ts'),
    [
      'export function add(left: number, right: number): number {',
      '  return left + right;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectPath, 'src', 'main.ts'),
    [
      "import { add } from './math';",
      '',
      'export function calculate(): number {',
      '  return add(20, 22);',
      '}',
      '',
    ].join('\n'),
  );

  let graph;
  try {
    const loaded = await import(`${pathToFileURL(join(repoRoot, 'dist', 'index.js')).href}?readiness=${Date.now()}`);
    const SolidKG = loaded.default?.default ?? loaded.default ?? loaded.SolidKG;
    assertReady(
      typeof SolidKG?.init === 'function',
      'built library exports SolidKG.init',
      'Repair src/index.ts exports or the TypeScript module build before continuing.',
    );

    graph = await SolidKG.init(projectPath, { index: false });
    const indexed = await graph.indexAll({ scip: 'required' });
    assertReady(
      indexed.success && indexed.filesIndexed === 2 && indexed.nodesCreated > 0,
      'clean fixture indexed both TypeScript files and created graph nodes with required SCIP enabled',
      `Inspect parser/SCIP warnings, repair the first indexing error, and rerun the verifier. Errors: ${JSON.stringify(indexed.errors)}`,
    );
    const scipStats = graph.getStats().scip;
    assertReady(
      scipStats?.generation?.languages?.typescript?.state === 'generated' &&
        scipStats.indexes > 0 &&
        scipStats.documents >= 2 &&
        scipStats.occurrences > 0 &&
        scipStats.linkedNodes > 0,
      'bundled TypeScript SCIP indexer generated, imported, and linked precise-reference facts',
      `Repair the bundled @sourcegraph/scip-typescript dependency or SCIP import/link path. Stats: ${JSON.stringify(scipStats)}`,
    );
    const matches = graph.searchNodes('calculate');
    const matchNames = matches.map((result) => result.node.name).filter(Boolean);
    assertReady(
      matches.some((result) => result.node.name === 'calculate'),
      'library search finds a symbol from the fresh index',
      `Inspect extraction and FTS initialization; returned names were ${JSON.stringify(matchNames)}. Do not treat a build-only pass as a working graph.`,
    );
    graph.close();
    graph = undefined;

    const statusOutput = run(process.execPath, [cliPath, 'status', projectPath], { cwd: projectPath });
    assertReady(
      /files\s*:?\s*2\b/i.test(statusOutput) || statusOutput.includes('2 files'),
      'CLI status opens the fresh SQLite graph',
      'Inspect the status error and node:sqlite runtime; keep the checkout on Node 24.',
    );

    const isolatedEnv = {
      HOME: profilePath,
      USERPROFILE: profilePath,
      APPDATA: join(profilePath, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(profilePath, 'AppData', 'Local'),
      HERMES_HOME: join(profilePath, '.hermes'),
    };
    const installCheck = run(
      process.execPath,
      [cliPath, 'install', '--check', '--target', 'all', '--location', 'local'],
      { cwd: projectPath, env: isolatedEnv },
    );
    assertReady(
      installCheck.includes('No files were modified.'),
      'agent-harness setup check is read-only',
      'Repair install --check before asking users or agents to run migration diagnostics.',
    );

    const pnpmHome = join(profilePath, 'pnpm-home');
    mkdirSync(pnpmHome, { recursive: true });
    const sourceInstallEnv = {
      ...isolatedEnv,
      // The Windows Corepack shim resolves pnpm from LOCALAPPDATA. Keep that
      // bootstrap location available while PNPM_HOME isolates the linked CLI.
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PNPM_HOME: pnpmHome,
      PATH: `${pnpmHome}${delimiter}${process.env.PATH ?? ''}`,
    };
    run('pnpm', ['link', '--global'], { cwd: repoRoot, env: sourceInstallEnv });
    const installedLauncher = join(pnpmHome, process.platform === 'win32' ? 'solidkg.CMD' : 'solidkg');
    assertReady(
      existsSync(installedLauncher),
      'source checkout creates a SolidKG launcher in an isolated pnpm global home',
      'Keep install:source on pnpm link --global; relative pnpm add --global paths resolve from pnpm global state and do not install this checkout.',
    );
    const installedVersion = run(installedLauncher, ['--version'], { cwd: projectPath, env: sourceInstallEnv }).trim();
    assertReady(
      installedVersion === packageJson.version,
      `isolated source-installed launcher reports version ${packageJson.version}`,
      'Rebuild the checkout and repair the pnpm global-link launcher before offering source installation.',
    );

    await smokeMcpTransport(projectPath);
  } finally {
    try { graph?.close?.(); } catch { /* best effort */ }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function smokeMcpTransport(projectPath) {
  const childEnv = { ...process.env };
  delete childEnv.SOLIDKG_MCP_TOOLS;
  childEnv.SOLIDKG_NO_DAEMON = '1';
  childEnv.SOLIDKG_NO_RELAUNCH = '1';
  childEnv.SOLIDKG_NO_WATCH = '1';

  const child = spawn(process.execPath, [cliPath, 'serve', '--mcp', '--no-watch'], {
    cwd: projectPath,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const request = (method, params, timeoutMs = 20_000) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`MCP ${method} timed out.\n${stderr}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveRequest, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'source-readiness', version: packageJson.version },
      rootUri: pathToFileURL(projectPath).href,
    }, 10_000);
    assertReady(
      initialized.result?.capabilities?.tools,
      'MCP stdio server completes initialize with tool capability',
      'Run the MCP initialize tests and repair the server/session startup path.',
    );
    notify('notifications/initialized');

    const tools = await request('tools/list', {});
    const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
    assertReady(
      names.length === 1 && names[0] === 'solidkg_explore',
      'default MCP profile exposes only solidkg_explore',
      'Unset SOLIDKG_MCP_TOOLS and restore the compact default MCP profile.',
    );

    const called = await request('tools/call', {
      name: 'solidkg_explore',
      arguments: { projectPath, query: 'add calculate' },
    });
    const responseText = called.result?.content?.find((item) => item.type === 'text')?.text ?? '';
    assertReady(
      !called.error && !called.result?.isError && responseText.includes('calculate') && responseText.includes('Answer Packet'),
      'MCP solidkg_explore returns source and an answer packet from the fresh index',
      'Inspect the MCP tool error, then repair the graph open/retrieval path before configuring an agent harness.',
    );
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    await stopChild(child);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.end(); } catch { /* best effort */ }
  if (await waitForClose(child, 1_000)) return;
  child.kill('SIGTERM');
  if (await waitForClose(child, 1_000)) return;
  child.kill('SIGKILL');
  await waitForClose(child, 2_000);
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolveClose(false);
    }, timeoutMs);
    timer.unref?.();
    const onClose = () => {
      clearTimeout(timer);
      resolveClose(true);
    };
    child.once('close', onClose);
  });
}

async function main() {
  console.log('SolidKG source-checkout readiness');
  console.log(`Repository: ${repoRoot}`);
  checkToolchain();
  const expectedNativeFiles = checkSourceInputs();
  verifyBuiltAssets(expectedNativeFiles);
  await smokeGraphAndMcp();
  console.log('RESULT PASS: source checkout builds, indexes with SCIP, and serves MCP correctly.');
}

main().catch((error) => {
  console.error('RESULT FAIL: source checkout is not ready.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
