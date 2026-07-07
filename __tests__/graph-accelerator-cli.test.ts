import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import SolidKG from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/solidkg.js');

function runCli(args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('CLI graph traversal packet output', () => {
  let testDir: string | undefined;
  let graph: SolidKG | undefined;

  afterEach(() => {
    graph?.destroy();
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    graph = undefined;
    testDir = undefined;
  });

  it('uses only traversed exact matches as impact packet start nodes', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-adjacency-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        'export function leaf(): string { return "ok"; }',
        'export function leafExtra(): string { return "extra"; }',
        'export function caller(): string { return leaf(); }',
      ].join('\n'),
    );
    graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();
    graph.destroy();
    graph = undefined;

    const result = runCli(['impact', 'leaf', '--path', testDir, '--depth', '1', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { readonly graphTraversal: { readonly query: { readonly start: readonly string[] } } };

    expect(parsed.graphTraversal.query.start).toHaveLength(1);
  });

  it('uses only traversed exact matches as callee packet start nodes', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-adjacency-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        'export function leaf(): string { return "ok"; }',
        'export function leafExtra(): string { return "extra"; }',
        'export function root(): string { return leaf(); }',
      ].join('\n'),
    );
    graph = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();
    graph.destroy();
    graph = undefined;

    const result = runCli(['callees', 'leaf', '--path', testDir, '--limit', '5', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { readonly graphTraversal: { readonly query: { readonly start: readonly string[] } } };

    expect(parsed.graphTraversal.query.start).toHaveLength(1);
  });
});
