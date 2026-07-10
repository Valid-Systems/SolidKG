import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality-sweep.mjs');

describe('reference quality sweep CLI', () => {
  it('documents the diagnostic sweep and comparison surface', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--help'], { cwd: repoRoot, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--root <path>');
    expect(result.stdout).toContain('--baseline <report.json>');
    expect(result.stdout).toContain('--scan-timeout-ms <number>');
    expect(result.stdout).toContain('diagnostic');
  });

  it('rejects a missing root without writing a success report', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--root', 'Z:/definitely-missing', '--out', 'Z:/also-missing'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('root not found');
  });

  it.each([
    ['--min-repos', 'nope'],
    ['--min-repos', '-1'],
    ['--probe-repeats', '-1'],
    ['--scan-timeout-ms', '0'],
    ['--probe-timeout-ms', '1.5'],
  ])('rejects invalid numeric option %s=%s', (option, value) => {
    const root = mkdtempSync(path.join(tmpdir(), 'solidkg-reference-cli-'));
    try {
      const result = spawnSync(process.execPath, [scriptPath, '--root', root, '--out', path.join(root, 'out'), option, value], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${option}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects comparison inputs that are not reference-quality reports', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'solidkg-reference-cli-'));
    try {
      const invalid = path.join(root, 'invalid.json');
      writeFileSync(invalid, JSON.stringify({ name: 'not-a-report' }));
      const result = spawnSync(process.execPath, [scriptPath, '--from-results', invalid, '--baseline', invalid, '--out', path.join(root, 'out')], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid reference-quality report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans parent-owned disposable copies after a hard worker timeout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'solidkg-reference-cli-'));
    const repo = path.join(root, 'fixture');
    mkdirSync(path.join(repo, '.solidkg'), { recursive: true });
    writeFileSync(path.join(repo, '.solidkg', 'solidkg.db'), 'not sqlite');
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('solidkg-reference-scan-')));
    try {
      const result = spawnSync(process.execPath, [scriptPath, '--root', root, '--out', path.join(root, 'out'), '--scan-timeout-ms', '1'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      const after = readdirSync(tmpdir()).filter((name) => name.startsWith('solidkg-reference-scan-') && !before.has(name));
      expect(result.status, result.stderr).toBe(0);
      expect(after).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
