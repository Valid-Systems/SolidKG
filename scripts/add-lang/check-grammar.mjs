#!/usr/bin/env node
// Verify that a configured native tree-sitter grammar parses a syntactically
// valid sample repeatedly before writing an extractor.
//
// Usage: node scripts/add-lang/check-grammar.mjs <lang> <valid-sample> [iterations]
// Exit: 0 healthy, 1 parse errors, 2 could not run.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const grammarMap = JSON.parse(readFileSync(join(repoRoot, 'src', 'extraction', 'native-grammars.json'), 'utf8'));
const require = createRequire(join(repoRoot, 'package.json'));

function fail(code, message) {
  console.error(`[check-grammar] ${message}`);
  process.exit(code);
}

const [token, sample, iterationArgument] = process.argv.slice(2);
if (!token || !sample) fail(2, 'usage: check-grammar.mjs <lang> <valid-sample> [iterations]');
if (!existsSync(sample)) fail(2, `sample not found: ${sample}`);

const language = token.toLowerCase() === 'c#' ? 'csharp' : token.toLowerCase();
const config = grammarMap[language];
if (!config) fail(2, `no native grammar mapping for "${token}" in src/extraction/native-grammars.json`);

const iterations = iterationArgument ? Number.parseInt(iterationArgument, 10) : 20;
if (!Number.isInteger(iterations) || iterations < 1) fail(2, `iterations must be a positive integer: ${iterationArgument}`);

const cacheDir = join(repoRoot, '.native-grammars', `${process.platform}-${process.arch}`);
process.env.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL = 'file:///definitely-missing/parsers.json';
const languagePack = require('@xberg-io/tree-sitter-language-pack');
languagePack.configure({ cacheDir });

let parser;
try {
  parser = languagePack.getParser(config.packageName);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(2, `failed to load ${config.packageName} from ${cacheDir}: ${message}`);
}

const source = readFileSync(sample, 'utf8');
let clean = 0;
let errors = 0;
for (let iteration = 0; iteration < iterations; iteration++) {
  const tree = parser.parse(source);
  if (!tree) fail(2, `parser returned no tree on iteration ${iteration + 1}`);
  if (tree.rootNode().hasError()) errors++; else clean++;
}

console.log(`grammar: ${config.packageName}`);
console.log(`  cache: ${cacheDir}`);
console.log(`  parses: ${clean} clean / ${errors} with errors (of ${iterations})`);
if (errors > 0) {
  console.log(`RESULT: FAIL — ${errors}/${iterations} parses produced ERROR trees on a valid sample.`);
  process.exit(1);
}
console.log('RESULT: PASS — native grammar parses cleanly and reuses safely offline.');
