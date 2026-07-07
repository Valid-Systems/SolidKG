#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { writeEvidenceBundle } from './evidence-schema.mjs';

function usage() {
  console.error('usage: node scripts/readiness/write-evidence.mjs --input <json> --out <path> [--allow-public-source]');
  console.error('   or: node scripts/readiness/write-evidence.mjs --sample --out <path>');
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function sampleInput(outputPath) {
  return {
    generatedAt: '2026-06-04T00:00:00.000Z',
    prompt: 'Synthetic evidence sample: prove metadata-only graph evidence excludes private source.',
    subject: {
      kind: 'readiness',
      solidkgVersion: '0.7.0-local',
      repo: {
        name: 'synthetic-private-fixture',
        identity: 'synthetic://readiness/task-6-private-fixture',
        privacy: 'private',
        revision: 'none',
      },
    },
    command: {
      commandLine: `node scripts/readiness/write-evidence.mjs --sample --out ${outputPath}`,
      cwd: process.cwd(),
      argv: ['node', 'scripts/readiness/write-evidence.mjs', '--sample', '--out', outputPath],
    },
    metrics: {
      durationMs: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      toolCalls: { total: 1, read: 0, grep: 0, bash: 0, solidkg: 1, other: 0 },
    },
    graphAnswer: {
      path: {
        found: true,
        hopCount: 2,
        symbols: ['SyntheticEntry', 'SyntheticSink'],
        metadata: { relation: 'synthetic-readiness-smoke' },
      },
      sourceCompleteness: {
        status: 'complete',
        returnedFiles: ['src/synthetic.ts'],
        truncatedFiles: [],
        omittedFiles: [],
        unreadableFiles: [],
        staleFiles: [],
      },
    },
    rawSource: 'export const privateValue = "SECRET_DO_NOT_CAPTURE";',
    result: {
      status: 'pass',
      summary: 'Synthetic sample evidence written without raw private source.',
      failureTaxonomyTag: 'pass',
    },
    artifacts: { evidencePath: outputPath },
  };
}

const args = process.argv.slice(2);
const outputPath = takeFlag(args, '--out');
const inputPath = takeFlag(args, '--input');
const allowPublicSource = args.includes('--allow-public-source');
const sample = args.includes('--sample');

if (!outputPath || (!inputPath && !sample) || (inputPath && sample)) {
  usage();
  process.exit(2);
}

try {
  const input = sample ? sampleInput(outputPath) : JSON.parse(readFileSync(inputPath, 'utf8'));
  const bundle = writeEvidenceBundle(input, outputPath, { allowPublicSource });
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: outputPath, schemaName: bundle.schemaName, result: bundle.result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (error.errors) process.stderr.write(`${JSON.stringify(error.errors, null, 2)}\n`);
  process.exit(1);
}
