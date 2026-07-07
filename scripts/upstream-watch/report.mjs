#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';

function parseArgs(argv) {
  const args = {
    manifest: '.upstream-watch/mirrored-paths.txt',
    repo: 'colbymchenry/codegraph',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base') {
      args.base = next;
      i += 1;
    } else if (arg === '--head') {
      args.head = next;
      i += 1;
    } else if (arg === '--manifest') {
      args.manifest = next;
      i += 1;
    } else if (arg === '--repo') {
      args.repo = next;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.base || !args.head) throw new Error('--base and --head are required');
  return args;
}

function readJsonFromStdin() {
  const input = readFileSync(0, 'utf8').trim();
  if (!input) throw new Error('compare JSON is required on stdin');
  return JSON.parse(input);
}

function readManifest(manifestPath) {
  const abs = resolve(process.cwd(), manifestPath);
  if (!existsSync(abs)) throw new Error(`manifest not found: ${manifestPath}`);
  return readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function matcherFor(patterns) {
  if (patterns.length === 0) return () => true;
  return picomatch(patterns, { dot: true });
}

function changedFiles(compareJson) {
  if (!Array.isArray(compareJson.files)) throw new Error('compare JSON must contain a files array');
  return compareJson.files.map((file) => ({
    filename: String(file.filename ?? ''),
    previousFilename: file.previous_filename ? String(file.previous_filename) : null,
    status: String(file.status ?? 'modified'),
    changes: Number.isFinite(file.changes) ? file.changes : 0,
  })).filter((file) => file.filename);
}

function matchesManifest(file, isMirrored) {
  return isMirrored(file.filename) || (file.previousFilename ? isMirrored(file.previousFilename) : false);
}

function renderFile(file) {
  if (file.previousFilename) {
    return `- \`${file.status}\` \`${file.previousFilename}\` -> \`${file.filename}\` (${file.changes} changes)`;
  }
  return `- \`${file.status}\` \`${file.filename}\` (${file.changes} changes)`;
}

function renderReport({ repo, base, head, manifestPath, allFiles, matchedFiles }) {
  const lines = [
    '# Upstream Watch Report',
    '',
    `Repository: \`${repo}\``,
    `Range: \`${base}...${head}\``,
    `Manifest: \`${manifestPath}\``,
    `Changed upstream files: ${allFiles.length}`,
    `Matched mirrored files: ${matchedFiles.length}`,
    '',
    '## Matched Files',
    '',
  ];

  if (matchedFiles.length === 0) {
    lines.push('No manifest paths changed. Keep the state file unchanged until a maintainer reviews the release notes.');
  } else {
    for (const file of matchedFiles) {
      lines.push(renderFile(file));
    }
    lines.push('', 'Review these local surfaces before updating `.upstream-watch/state.json`. Do not merge or cherry-pick from this report alone.');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const compareJson = readJsonFromStdin();
  const patterns = readManifest(args.manifest);
  const isMirrored = matcherFor(patterns);
  const allFiles = changedFiles(compareJson);
  const matchedFiles = allFiles.filter((file) => matchesManifest(file, isMirrored));

  process.stdout.write(renderReport({
    repo: args.repo,
    base: args.base,
    head: args.head,
    manifestPath: args.manifest,
    allFiles,
    matchedFiles,
  }));
}

try {
  main();
} catch (err) {
  process.stderr.write(`upstream-watch: ${err?.message ?? err}\n`);
  process.exit(1);
}
