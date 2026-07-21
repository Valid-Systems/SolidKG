#!/usr/bin/env node
// Dump the native tree-sitter AST for a configured language so contributors can
// map the grammar's real node and field names in a LanguageExtractor.
//
// Usage: node scripts/add-lang/dump-ast.mjs <lang> <sample-file> [--depth=N] [--full]

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const grammarMap = JSON.parse(readFileSync(join(repoRoot, 'src', 'extraction', 'native-grammars.json'), 'utf8'));
const require = createRequire(join(repoRoot, 'package.json'));

function fail(message) {
  console.error(`[dump-ast] ${message}`);
  process.exit(1);
}

const argumentsList = process.argv.slice(2);
const positional = argumentsList.filter((argument) => !argument.startsWith('--'));
const [token, sampleFile] = positional;
const depthFlag = argumentsList.find((argument) => argument.startsWith('--depth='));
const showAll = argumentsList.includes('--full');
const maxDepth = depthFlag ? Number.parseInt(depthFlag.split('=')[1], 10) : (showAll ? Number.POSITIVE_INFINITY : 8);

if (!token || !sampleFile) fail('usage: dump-ast.mjs <lang> <sample-file> [--depth=N] [--full]');
if (!existsSync(sampleFile)) fail(`sample file not found: ${sampleFile}`);
if (Number.isNaN(maxDepth) || maxDepth < 0) fail(`depth must be a non-negative integer: ${depthFlag}`);

const language = token.toLowerCase() === 'c#' ? 'csharp' : token.toLowerCase();
const config = grammarMap[language];
if (!config) fail(`no native grammar mapping for "${token}" in src/extraction/native-grammars.json`);

const cacheDir = join(repoRoot, '.native-grammars', `${process.platform}-${process.arch}`);
process.env.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL = 'file:///definitely-missing/parsers.json';
const languagePack = require('@xberg-io/tree-sitter-language-pack');
languagePack.configure({ cacheDir });

let parser;
try {
  parser = languagePack.getParser(config.packageName);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`failed to load ${config.packageName} from ${cacheDir}: ${message}`);
}

const source = readFileSync(sampleFile, 'utf8');
const sourceBytes = Buffer.from(source, 'utf8');
const tree = parser.parse(source);
if (!tree) fail(`parser returned no tree for ${sampleFile}`);

const frequency = new Map();
function snippet(node) {
  const text = sourceBytes.subarray(node.startByte(), node.endByte()).toString('utf8').replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function childrenWithFields(node) {
  const cursor = node.walk();
  if (!cursor.gotoFirstChild()) return [];
  const children = [];
  do {
    children.push({ node: cursor.node(), fieldName: cursor.fieldName() });
  } while (cursor.gotoNextSibling());
  return children;
}

function walk(node, depth, fieldName) {
  const kind = node.kind();
  if (node.isNamed()) frequency.set(kind, (frequency.get(kind) ?? 0) + 1);
  if ((node.isNamed() || showAll) && depth <= maxDepth) {
    const field = fieldName ? `${fieldName}: ` : '';
    const leaf = node.childCount() === 0 ? `  "${snippet(node)}"` : '';
    const position = node.startPosition();
    console.log(`${'  '.repeat(depth)}${field}${kind}  @${position.row + 1}:${position.column}${leaf}`);
  }
  for (const child of childrenWithFields(node)) {
    walk(child.node, depth + 1, child.fieldName);
  }
}

console.log(`\n# AST for ${sampleFile}  (grammar: ${config.packageName})\n`);
walk(tree.rootNode(), 0, null);

console.log('\n# Node-type frequency (named nodes) — map the relevant ones in your extractor:\n');
[...frequency.entries()]
  .sort((left, right) => right[1] - left[1])
  .forEach(([kind, count]) => console.log(`  ${String(count).padStart(5)}  ${kind}`));
console.log();
