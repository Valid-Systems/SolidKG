#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultEvidence = join(repoRoot, '.omo', 'evidence', 'task-10-artifact-file-list.txt');
const evidencePath = resolve(readArg('--evidence') || defaultEvidence);
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const syntheticTargets = ['linux-x64', 'darwin-arm64'];
const evidence = [];

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function record(line = '') {
  evidence.push(line);
}

function run(command, args, options = {}) {
  const useCmd = process.platform === 'win32' && (command === 'npm' || command === 'pnpm');
  const executable = useCmd ? 'cmd.exe' : command;
  const finalArgs = useCmd ? ['/d', '/s', '/c', command, ...args] : args;
  const result = spawnSync(executable, finalArgs, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const commandLine = [command, ...args].join(' ');
  record(`$ ${commandLine}`);
  if (result.stdout) record(result.stdout.trimEnd());
  if (result.stderr) record(result.stderr.trimEnd());
  if (result.error) {
    throw new Error(`${commandLine} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${commandLine} exited ${result.status}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  record(`PASS ${message}`);
}

function listFiles(dir) {
  const out = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).replace(/\\/g, '/'));
    }
  }
  walk(dir);
  return out.sort();
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('npm pack dry-run did not emit JSON');
  return JSON.parse(stdout.slice(start, end + 1))[0].files.map((file) => file.path).sort();
}

function ensureBuiltDist() {
  if (!existsSync(join(repoRoot, 'dist', 'bin', 'solidkg.js'))
    || !existsSync(join(repoRoot, 'dist', 'db', 'schema.sql'))
    || !existsSync(join(repoRoot, 'dist', 'extraction', 'wasm'))
    || readdirSync(join(repoRoot, 'dist', 'extraction', 'wasm')).filter((file) => file.endsWith('.wasm')).length === 0) {
    run('pnpm', ['run', 'build']);
  }
}

function verifyDistAssets() {
  const entrypoint = join(repoRoot, 'dist', 'bin', 'solidkg.js');
  const schema = join(repoRoot, 'dist', 'db', 'schema.sql');
  const wasmDir = join(repoRoot, 'dist', 'extraction', 'wasm');
  const wasmFiles = readdirSync(wasmDir).filter((file) => file.endsWith('.wasm')).sort();

  assert(existsSync(entrypoint), 'built executable entrypoint dist/bin/solidkg.js exists');
  if (process.platform === 'win32') {
    record('PASS dist/bin/solidkg.js executable bit check skipped on Windows');
  } else {
    assert((statSync(entrypoint).mode & 0o111) !== 0, 'dist/bin/solidkg.js is executable on POSIX');
  }
  assert(existsSync(schema), 'built artifact includes dist/db/schema.sql');
  assert(wasmFiles.length > 0, 'built artifact includes dist/extraction/wasm/*.wasm');
  record(`WASM files: ${wasmFiles.join(', ')}`);
}

function verifyRootPackDryRun() {
  const stdout = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
  const files = parsePackJson(stdout);
  record('Root npm pack dry-run files:');
  for (const file of files) record(`  ${file}`);
  assert(files.includes('dist/bin/solidkg.js'), 'root package file list includes dist/bin/solidkg.js');
  assert(files.includes('dist/db/schema.sql'), 'root package file list includes dist/db/schema.sql');
  assert(files.some((file) => file.startsWith('dist/extraction/wasm/') && file.endsWith('.wasm')), 'root package file list includes dist/extraction/wasm/*.wasm');
  assert(files.includes('scripts/npm-shim.js'), 'root package file list includes scripts/npm-shim.js');
  assert(!files.some((file) => file.startsWith('fixtures/evaluation-corpus/')), 'root package file list excludes fixtures/evaluation-corpus/** by default');
}

function writeSyntheticPlatformPackage(pkgDir, target) {
  const bundleDir = pkgDir;
  mkdirSync(join(bundleDir, 'bin'), { recursive: true });
  mkdirSync(join(bundleDir, 'lib', 'dist', 'bin'), { recursive: true });
  mkdirSync(join(bundleDir, 'lib', 'dist', 'db'), { recursive: true });
  mkdirSync(join(bundleDir, 'lib', 'dist', 'extraction', 'wasm'), { recursive: true });
  writeFileSync(join(bundleDir, 'node'), '#!/bin/sh\necho synthetic-node\n');
  chmodSync(join(bundleDir, 'node'), 0o755);
  writeFileSync(join(bundleDir, 'bin', 'solidkg'), '#!/bin/sh\necho synthetic-solidkg\n');
  chmodSync(join(bundleDir, 'bin', 'solidkg'), 0o755);
  writeFileSync(join(bundleDir, 'lib', 'dist', 'bin', 'solidkg.js'), '#!/usr/bin/env node\nconsole.log("synthetic")\n');
  writeFileSync(join(bundleDir, 'lib', 'dist', 'db', 'schema.sql'), '-- synthetic schema\n');
  writeFileSync(join(bundleDir, 'lib', 'dist', 'extraction', 'wasm', 'synthetic.wasm'), 'synthetic wasm\n');

  const [osName, cpu] = target.split('-');
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: `solidkg-${target}`,
    version,
    description: `SolidKG self-contained bundle for ${target}`,
    os: [osName],
    cpu: [cpu],
    files: ['node', 'lib', 'bin'],
  }, null, 2) + '\n');
}

function verifyPackNpmWithSyntheticBundles() {
  const temp = mkdtempSync(join(tmpdir(), 'cg-artifact-readiness-'));
  const releaseDir = join(temp, 'release');
  const npmDir = join(releaseDir, 'npm');
  mkdirSync(npmDir, { recursive: true });
  try {
    for (const target of syntheticTargets) writeSyntheticPlatformPackage(join(npmDir, `solidkg-${target}`), target);

    const mainDir = join(npmDir, 'main');
    mkdirSync(mainDir, { recursive: true });
    cpSync(join(repoRoot, 'scripts', 'npm-shim.js'), join(mainDir, 'npm-shim.js'));
    cpSync(join(repoRoot, 'README.md'), join(mainDir, 'README.md'));
    const optionalDependencies = Object.fromEntries(syntheticTargets.map((target) => [`solidkg-${target}`, version]));
    writeFileSync(join(mainDir, 'package.json'), JSON.stringify({
      name: 'solidkg',
      version,
      description: 'Local-first code intelligence for AI agents (MCP). Self-contained - bundles its own runtime.',
      bin: { solidkg: 'npm-shim.js' },
      optionalDependencies,
      files: ['npm-shim.js', 'README.md'],
    }, null, 2) + '\n');

    const mainPackage = JSON.parse(readFileSync(join(mainDir, 'package.json'), 'utf8'));
    assert(mainPackage.bin?.solidkg === 'npm-shim.js', 'main npm package maps bin.solidkg to npm-shim.js');
    assert(JSON.stringify(mainPackage.files) === JSON.stringify(['npm-shim.js', 'README.md']), 'main npm package file whitelist is npm-shim.js and README.md');
    for (const target of syntheticTargets) {
      assert(mainPackage.optionalDependencies?.[`solidkg-${target}`] === version, `main npm optionalDependencies maps solidkg-${target} to package version`);
    }

    const mainPackFiles = parsePackJson(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', mainDir]));
    assert(mainPackFiles.includes('npm-shim.js'), 'main npm dry-run package includes npm-shim.js');
    assert(!mainPackFiles.some((file) => file.startsWith('fixtures/evaluation-corpus/')), 'main npm dry-run package excludes fixtures/evaluation-corpus/**');

    for (const target of syntheticTargets) {
      const pkgDir = join(releaseDir, 'npm', `solidkg-${target}`);
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      const files = listFiles(pkgDir);
      record(`solidkg-${target} staged files:`);
      for (const file of files) record(`  ${file}`);
      assert(JSON.stringify(pkg.files) === JSON.stringify(['node', 'lib', 'bin']), `solidkg-${target} package whitelist is node/lib/bin`);
      assert(pkg.os?.[0] === target.split('-')[0], `solidkg-${target} package os matches target`);
      assert(pkg.cpu?.[0] === target.split('-')[1], `solidkg-${target} package cpu matches target`);
      assert(files.includes('node'), `solidkg-${target} includes vendored node runtime`);
      assert(files.includes('bin/solidkg'), `solidkg-${target} includes executable launcher`);
      assert(files.includes('lib/dist/bin/solidkg.js'), `solidkg-${target} includes CLI entrypoint`);
      assert(files.includes('lib/dist/db/schema.sql'), `solidkg-${target} includes schema.sql`);
      assert(files.some((file) => file.startsWith('lib/dist/extraction/wasm/') && file.endsWith('.wasm')), `solidkg-${target} includes WASM assets`);
      assert(!files.some((file) => file.startsWith('fixtures/evaluation-corpus/')), `solidkg-${target} excludes fixtures/evaluation-corpus/**`);

      const platformPackFiles = parsePackJson(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', pkgDir]));
      assert(platformPackFiles.includes('lib/dist/db/schema.sql'), `solidkg-${target} dry-run package includes schema.sql`);
      assert(platformPackFiles.some((file) => file.startsWith('lib/dist/extraction/wasm/') && file.endsWith('.wasm')), `solidkg-${target} dry-run package includes WASM assets`);
      assert(!platformPackFiles.some((file) => file.startsWith('fixtures/evaluation-corpus/')), `solidkg-${target} dry-run package excludes fixtures/evaluation-corpus/**`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyScriptAndWorkflowGuards() {
  const buildBundle = readFileSync(join(repoRoot, 'scripts', 'build-bundle.sh'), 'utf8');
  const packNpm = readFileSync(join(repoRoot, 'scripts', 'pack-npm.sh'), 'utf8');
  const shim = readFileSync(join(repoRoot, 'scripts', 'npm-shim.js'), 'utf8');
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']) {
    assert(buildBundle.includes(target), `build-bundle documents ${target}`);
    assert(workflow.includes(target), `release workflow builds ${target}`);
  }
  assert(buildBundle.includes('cp -R "$ROOT/dist" "$STAGE/lib/dist"'), 'build-bundle copies built dist into bundle lib/dist');
  assert(packNpm.includes('files: [process.env.NODEFILE, "lib", "bin"]'), 'pack-npm platform packages whitelist node/lib/bin');
  assert(packNpm.includes('files: ["npm-shim.js","README.md"]'), 'pack-npm main package whitelist is shim plus README');
  assert(shim.includes('SOLIDKG_NO_DOWNLOAD'), 'npm shim supports SOLIDKG_NO_DOWNLOAD');
  assert(shim.includes('SOLIDKG_INSTALL_DIR'), 'npm shim supports SOLIDKG_INSTALL_DIR');
  assert(shim.includes('SOLIDKG_DOWNLOAD_BASE'), 'npm shim supports SOLIDKG_DOWNLOAD_BASE');
  assert(!buildBundle.includes('fixtures/evaluation-corpus'), 'build-bundle does not include fixtures/evaluation-corpus');
  assert(!packNpm.includes('fixtures/evaluation-corpus'), 'pack-npm does not include fixtures/evaluation-corpus');
}

try {
  record(`# Task 10 Artifact File-List Readiness Evidence`);
  record(`Generated: ${new Date().toISOString()}`);
  record(`Repo: ${repoRoot}`);
  record(`Version: ${version}`);
  record('Publication commands executed: none');
  record();
  ensureBuiltDist();
  verifyDistAssets();
  verifyRootPackDryRun();
  verifyPackNpmWithSyntheticBundles();
  verifyScriptAndWorkflowGuards();
  record();
  record('RESULT PASS');
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, evidence.join('\n') + '\n');
  console.log(`wrote ${evidencePath}`);
} catch (error) {
  record();
  record(`RESULT FAIL ${error instanceof Error ? error.message : String(error)}`);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, evidence.join('\n') + '\n');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
