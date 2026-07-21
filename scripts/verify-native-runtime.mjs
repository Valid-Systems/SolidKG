#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(requiredArg('--package-root'));
const grammarDir = resolve(requiredArg('--grammar-dir'));
const grammarMap = JSON.parse(readFileSync(join(repoRoot, 'src', 'extraction', 'native-grammars.json'), 'utf8'));
const packageRequire = createRequire(join(packageRoot, 'package.json'));

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function requiredArg(name) {
  const value = readArg(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

process.env.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL = 'file:///definitely-missing/parsers.json';
const languagePack = packageRequire('@xberg-io/tree-sitter-language-pack');
languagePack.configure({ cacheDir: grammarDir });

for (const [language, { packageName }] of Object.entries(grammarMap)) {
  const tree = languagePack.getParser(packageName).parse('');
  if (!tree || typeof tree.rootNode().kind() !== 'string') {
    throw new Error(`Native parser verification failed for ${language}`);
  }
}

console.log(`[native-runtime] loaded ${Object.keys(grammarMap).length} language mappings offline`);
