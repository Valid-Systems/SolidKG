/**
 * Per-language extraction configurations.
 *
 * Each file exports a LanguageExtractor config object.
 * This barrel builds the EXTRACTORS map consumed by TreeSitterExtractor.
 */

import { Language } from '../../types';
import type { LanguageExtractor } from '../tree-sitter-types';

import { typescriptExtractor } from './typescript';
import { javascriptExtractor } from './javascript';
import { pythonExtractor } from './python';
import { goExtractor } from './go';
import { rustExtractor } from './rust';
import { javaExtractor } from './java';
import { cExtractor, cppExtractor } from './c-cpp';
import { csharpExtractor } from './csharp';
import { phpExtractor } from './php';
import { rubyExtractor } from './ruby';
import { swiftExtractor } from './swift';
import { kotlinExtractor } from './kotlin';
import { dartExtractor } from './dart';
import { pascalExtractor } from './pascal';
import { scalaExtractor } from './scala';
import { luaExtractor } from './lua';
import { luauExtractor } from './luau';
import { objcExtractor } from './objc';
import { systemverilogExtractor } from './systemverilog';
import { juliaExtractor } from './julia';
import { fortranExtractor } from './fortran';
import { rExtractor } from './r';
import { groovyExtractor } from './groovy';
import { vbnetExtractor } from './vbnet';
import { sqlExtractor } from './sql';
import { hclExtractor } from './hcl';
import { nixExtractor } from './nix';
import { solidityExtractor } from './solidity';
import { bashExtractor } from './bash';
import { powershellExtractor } from './powershell';

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: typescriptExtractor,
  tsx: typescriptExtractor,
  javascript: javascriptExtractor,
  jsx: javascriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
  java: javaExtractor,
  c: cExtractor,
  cpp: cppExtractor,
  csharp: csharpExtractor,
  php: phpExtractor,
  ruby: rubyExtractor,
  swift: swiftExtractor,
  kotlin: kotlinExtractor,
  dart: dartExtractor,
  pascal: pascalExtractor,
  scala: scalaExtractor,
  lua: luaExtractor,
  luau: luauExtractor,
  objc: objcExtractor,
  systemverilog: systemverilogExtractor,
  julia: juliaExtractor,
  fortran: fortranExtractor,
  r: rExtractor,
  groovy: groovyExtractor,
  vbnet: vbnetExtractor,
  sql: sqlExtractor,
  hcl: hclExtractor,
  nix: nixExtractor,
  solidity: solidityExtractor,
  bash: bashExtractor,
  powershell: powershellExtractor,
};
