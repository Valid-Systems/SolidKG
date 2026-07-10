#!/usr/bin/env node
import { analyzeIndexDatabase } from './sqlite-metrics.mjs';
import { copyIndexArtifacts, runProbeCase, snapshotIndexArtifacts, stabilizeCopiedDatabase } from './probe-runner.mjs';
import { isAbsolute, join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

async function main() {
  const mode = process.argv[2];
  const input = await readInput();
  if (typeof input.tempRoot !== 'string' || !isAbsolute(input.tempRoot)) {
    throw new Error('worker input requires a parent-owned absolute tempRoot for hard-timeout cleanup');
  }
  const tempRoot = resolve(input.tempRoot);
  if (mode === 'scan') {
    const sourceIndexDir = join(input.repoPath, '.solidkg');
    const before = snapshotIndexArtifacts(sourceIndexDir);
    const copied = copyIndexArtifacts(sourceIndexDir, tempRoot);
    let result;
    try {
      stabilizeCopiedDatabase(join(copied.copyDir, 'solidkg.db'));
      result = analyzeIndexDatabase(join(copied.copyDir, 'solidkg.db'), { repoId: input.repoId, repoPath: input.repoPath });
    } finally {
      rmSync(copied.tempRoot, { recursive: true, force: true });
      const after = snapshotIndexArtifacts(sourceIndexDir);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`original index artifacts changed for ${input.repoId}`);
    }
    return { ...result, cleanup: { tempRoot, owner: 'parent', cleaned: true }, originalPreserved: true };
  }
  if (mode === 'probe') return runProbeCase({ ...input, tempRoot });
  throw new Error(`unknown worker mode: ${mode}`);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
