import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

const repoRoot = path.resolve(__dirname, '..');
const shellInstaller = path.join(repoRoot, 'scripts', 'install.sh');
const powerShellInstaller = path.join(repoRoot, 'scripts', 'install.ps1');
const version = 'v9.9.9-test';
const isWindows = process.platform === 'win32';

function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-installer-${label}-`));
}

function hasCommand(command: string, args: string[] = ['--version']): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

function powerShellCommand(): string | null {
  for (const command of ['pwsh', 'powershell']) {
    if (hasCommand(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])) return command;
  }
  return null;
}

function runProcess(command: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function startServer(assetName: string, archiveBytes: Buffer): Promise<{ baseUrl: string; setSums: (body: string | null) => void; close: () => Promise<void> }> {
  let sumsBody: string | null = null;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.endsWith(`/${assetName}`)) {
      res.writeHead(200);
      res.end(archiveBytes);
    } else if (url.endsWith('/SHA256SUMS')) {
      if (sumsBody === null) {
        res.writeHead(404);
        res.end('not found');
      } else {
        res.writeHead(200);
        res.end(sumsBody);
      }
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setSums: (body) => { sumsBody = body; },
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

function writePosixBundleArchive(target: string): Buffer {
  const work = mkTmp('posix-asset');
  const binDir = path.join(work, `solidkg-${target}`, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, 'solidkg');
  fs.writeFileSync(launcher, '#!/bin/sh\necho FAKE_SOLIDKG\n');
  fs.chmodSync(launcher, 0o755);
  const archive = path.join(work, `solidkg-${target}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', work, `solidkg-${target}`]);
  const bytes = fs.readFileSync(archive);
  fs.rmSync(work, { recursive: true, force: true });
  return bytes;
}

function writeWindowsBundleArchive(target: string, psCommand: string): Buffer {
  const work = mkTmp('win-asset');
  const bundleRoot = path.join(work, `solidkg-${target}`);
  const binDir = path.join(bundleRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'solidkg.cmd'), '@echo off\necho FAKE_SOLIDKG\n');
  const archive = path.join(work, `solidkg-${target}.zip`);
  execFileSync(psCommand, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -Path ${JSON.stringify(bundleRoot)} -DestinationPath ${JSON.stringify(archive)} -Force`,
  ]);
  const bytes = fs.readFileSync(archive);
  fs.rmSync(work, { recursive: true, force: true });
  return bytes;
}

describe.skipIf(isWindows || !hasCommand('sh') || !hasCommand('tar') || !hasCommand('curl'))('standalone shell installer integrity', () => {
  const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const assetName = `solidkg-${target}.tar.gz`;
  let tempDirs: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>>;
  let sha = '';

  beforeAll(async () => {
    const archiveBytes = writePosixBundleArchive(target);
    sha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    server = await startServer(assetName, archiveBytes);
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  async function runShellInstaller(sumsBody: string | null, setup?: (installDir: string) => void) {
    const installDir = mkTmp('sh-install');
    const binDir = mkTmp('sh-bin');
    tempDirs.push(installDir, binDir);
    setup?.(installDir);
    server.setSums(sumsBody);
    const result = await runProcess('sh', [shellInstaller], {
      SOLIDKG_VERSION: version,
      SOLIDKG_DOWNLOAD_BASE: server.baseUrl,
      SOLIDKG_INSTALL_DIR: installDir,
      SOLIDKG_BIN_DIR: binDir,
    });
    return { ...result, installDir };
  }

  it('installs only after the release checksum matches', async () => {
    const result = await runShellInstaller(`${sha}  ${assetName}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('checksum verified');
    expect(fs.existsSync(path.join(result.installDir, 'current', 'bin', 'solidkg'))).toBe(true);
  });

  it('prunes old standalone versions after a successful install', async () => {
    const result = await runShellInstaller(`${sha}  ${assetName}\n`, (installDir) => {
      fs.mkdirSync(path.join(installDir, 'versions', 'v0.0.1-old'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'versions', 'v0.0.1-old', 'marker'), 'old');
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(result.installDir, 'versions', version))).toBe(true);
    expect(fs.existsSync(path.join(result.installDir, 'versions', 'v0.0.1-old'))).toBe(false);
  });

  it('fails closed on checksum mismatch', async () => {
    const result = await runShellInstaller(`${'0'.repeat(64)}  ${assetName}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(fs.existsSync(path.join(result.installDir, 'current'))).toBe(false);
  });

  it('fails closed when SHA256SUMS is unavailable', async () => {
    const result = await runShellInstaller(null);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum unavailable');
    expect(fs.existsSync(path.join(result.installDir, 'current'))).toBe(false);
  });
});

describe.skipIf(!isWindows || powerShellCommand() === null)('standalone PowerShell installer integrity', () => {
  const psCommand = powerShellCommand() ?? 'powershell';
  const target = `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const assetName = `solidkg-${target}.zip`;
  let tempDirs: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>>;
  let sha = '';

  beforeAll(async () => {
    const archiveBytes = writeWindowsBundleArchive(target, psCommand);
    sha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    server = await startServer(assetName, archiveBytes);
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  async function runWindowsInstaller(sumsBody: string | null) {
    const installDir = mkTmp('ps-install');
    tempDirs.push(installDir);
    server.setSums(sumsBody);
    const result = await runProcess(psCommand, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powerShellInstaller], {
      SOLIDKG_VERSION: version,
      SOLIDKG_DOWNLOAD_BASE: server.baseUrl,
      SOLIDKG_INSTALL_DIR: installDir,
    });
    return { ...result, installDir };
  }

  it('installs only after the release checksum matches', async () => {
    const result = await runWindowsInstaller(`${sha}  ${assetName}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('checksum verified');
    expect(fs.existsSync(path.join(result.installDir, 'current', 'bin', 'solidkg.cmd'))).toBe(true);
  });

  it('fails closed on checksum mismatch', async () => {
    const result = await runWindowsInstaller(`${'0'.repeat(64)}  ${assetName}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(fs.existsSync(path.join(result.installDir, 'current'))).toBe(false);
  });

  it('fails closed when SHA256SUMS is unavailable', async () => {
    const result = await runWindowsInstaller(null);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum unavailable');
    expect(fs.existsSync(path.join(result.installDir, 'current'))).toBe(false);
  });
});
