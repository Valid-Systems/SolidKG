#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const evidencePath = resolve('.omo/evidence/task-8-mixed-stack-probes.json');
mkdirSync(dirname(evidencePath), { recursive: true });
function shellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cmdArg(value) {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : shellQuote(text);
}

function spawnPnpm(args, options) {
  if (process.platform !== 'win32') return spawnSync('pnpm', args, options);
  const commandLine = ['call', 'pnpm.cmd', ...args.map(cmdArg)].join(' ');
  return spawnSync('cmd.exe', ['/d', '/c', commandLine], options);
}

const args = ['exec', 'vitest', 'run', '__tests__/evaluation/mixed-stack-probes.test.ts'];
const result = spawnPnpm(args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SOLIDKG_TASK8_WRITE_EVIDENCE: '1',
    SOLIDKG_TASK8_EVIDENCE_PATH: evidencePath,
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);