import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '..');
const evidencePath = path.join(repoRoot, '.omo', 'evidence', 'task-10-artifact-file-list.txt');
const readinessScript = path.join(repoRoot, 'scripts', 'readiness', 'verify-release-artifacts.mjs');

describe('release artifact readiness', () => {
  it('verifies local package and bundle file lists without publishing', () => {
    execFileSync(process.execPath, [readinessScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
    });

    const evidence = fs.readFileSync(evidencePath, 'utf8');
    expect(evidence).toContain('RESULT PASS');
    expect(evidence).toContain('Publication commands executed: none');
    expect(evidence).toContain('root package file list includes dist/bin/solidkg.js');
    expect(evidence).toContain('root package file list includes dist/db/schema.sql');
    expect(evidence).toContain('root package file list includes dist/extraction/wasm/*.wasm');
    expect(evidence).toContain('main npm package maps bin.solidkg to npm-shim.js');
    expect(evidence).toContain('excludes fixtures/evaluation-corpus/**');
    expect(evidence).not.toMatch(/^\s*fixtures\/evaluation-corpus\//m);
  }, 60000);
});
