#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const grammarMap = JSON.parse(readFileSync(join(repoRoot, 'src', 'extraction', 'native-grammars.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const cacheDir = resolve(readArg('--output') ?? join(repoRoot, '.native-grammars', target));
const packageRoot = resolve(readArg('--package-root') ?? repoRoot);
const packageRequire = createRequire(join(packageRoot, 'package.json'));
const packageVersion = '1.13.1';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function nativeLibraryName(libraryName) {
  if (process.platform === 'win32') return `tree_sitter_${libraryName}.dll`;
  if (process.platform === 'darwin') return `libtree_sitter_${libraryName}.dylib`;
  return `libtree_sitter_${libraryName}.so`;
}

function patchWindowsAddon() {
  if (process.platform !== 'win32') return;
  const packageEntry = packageRequire.resolve('@xberg-io/tree-sitter-language-pack');
  const addonPath = join(dirname(packageEntry), `ts-pack-core-node.win32-${process.arch}-msvc.node`);
  const bytes = readFileSync(addonPath);
  const brokenImport = Buffer.from('node.dll\0', 'ascii');
  const fixedImport = Buffer.from('node.exe\0', 'ascii');
  let replacements = 0;
  for (let offset = bytes.indexOf(brokenImport); offset >= 0; offset = bytes.indexOf(brokenImport, offset + brokenImport.length)) {
    fixedImport.copy(bytes, offset);
    replacements++;
  }
  if (replacements > 0) {
    writeFileSync(addonPath, bytes);
    console.log(`[native-runtime] repaired ${replacements} Node import(s) in ${addonPath}`);
    return;
  }
  if (bytes.indexOf(fixedImport) < 0) {
    throw new Error(`Native addon has neither node.dll nor node.exe imports: ${addonPath}`);
  }
}

patchWindowsAddon();
if (process.argv.includes('--addon-only')) process.exit(0);

mkdirSync(cacheDir, { recursive: true });
process.env.TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL =
  `https://github.com/xberg-io/tree-sitter-language-pack/releases/download/v${packageVersion}/parsers.json`;
const languagePack = packageRequire('@xberg-io/tree-sitter-language-pack');
const packageNames = [...new Set(Object.values(grammarMap).map(({ packageName }) => packageName))].sort();
languagePack.configure({ cacheDir });
languagePack.prefetch(packageNames);

const missing = [...new Set(Object.values(grammarMap).map(({ libraryName }) => nativeLibraryName(libraryName)))]
  .filter((fileName) => !existsSync(join(cacheDir, fileName)));
if (missing.length > 0) {
  throw new Error(`Native grammar staging is incomplete for ${target}: ${missing.join(', ')}`);
}

console.log(`[native-runtime] staged ${packageNames.length} grammars for ${target} in ${cacheDir}`);
