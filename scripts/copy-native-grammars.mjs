#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(readArg('--source') ?? join(repoRoot, '.native-grammars', `${process.platform}-${process.arch}`));
const destinationDir = resolve(requiredArg('--destination'));
const grammarMap = JSON.parse(readFileSync(join(repoRoot, 'src', 'extraction', 'native-grammars.json'), 'utf8'));
const expectedFiles = [...new Set(Object.values(grammarMap).map(({ libraryName }) => nativeLibraryName(libraryName)))].sort();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function requiredArg(name) {
  const value = readArg(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function nativeLibraryName(libraryName) {
  if (process.platform === 'win32') return `tree_sitter_${libraryName}.dll`;
  if (process.platform === 'darwin') return `libtree_sitter_${libraryName}.dylib`;
  return `libtree_sitter_${libraryName}.so`;
}

for (const fileName of expectedFiles) {
  if (!existsSync(join(sourceDir, fileName))) {
    throw new Error(`Missing native grammar ${fileName} in ${sourceDir}`);
  }
}

rmSync(destinationDir, { recursive: true, force: true });
mkdirSync(destinationDir, { recursive: true });
for (const fileName of expectedFiles) {
  copyFileSync(join(sourceDir, fileName), join(destinationDir, fileName));
}

console.log(`[native-runtime] copied ${expectedFiles.length} grammar libraries to ${destinationDir}`);
