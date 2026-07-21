/**
 * Grammar Loading and Caching
 *
 * Grammars are loaded lazily from the native libraries staged with SolidKG.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  configure as configureLanguagePack,
  getParser as getNativeParser,
} from '@xberg-io/tree-sitter-language-pack';
import type { Language } from '../types';
import { Parser } from './native-tree-sitter';
import nativeGrammars from './native-grammars.json';

export type GrammarLanguage = Exclude<Language, 'svelte' | 'vue' | 'liquid' | 'astro' | 'jinja' | 'razor' | 'arkts' | 'scl' | 'yaml' | 'twig' | 'unknown'>;

type NativeGrammarConfig = Readonly<{
  packageName: string;
  libraryName: string;
}>;

const NATIVE_GRAMMARS: Record<GrammarLanguage, NativeGrammarConfig> = nativeGrammars;
const GRAMMAR_LANGUAGES: readonly GrammarLanguage[] = [
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java',
  'c', 'cpp', 'csharp', 'php', 'ruby', 'swift', 'kotlin', 'dart', 'pascal',
  'scala', 'lua', 'luau', 'objc', 'systemverilog', 'julia', 'fortran', 'r',
  'groovy', 'vbnet', 'sql', 'hcl', 'nix', 'solidity', 'bash', 'powershell',
];

function isGrammarLanguage(language: Language): language is GrammarLanguage {
  return Object.prototype.hasOwnProperty.call(NATIVE_GRAMMARS, language);
}

function nativeLibraryFileName(libraryName: string): string {
  if (process.platform === 'win32') return `tree_sitter_${libraryName}.dll`;
  if (process.platform === 'darwin') return `libtree_sitter_${libraryName}.dylib`;
  return `libtree_sitter_${libraryName}.so`;
}

function grammarDirectoryCandidates(): readonly string[] {
  const target = `${process.platform}-${process.arch}`;
  return [
    process.env.SOLIDKG_NATIVE_GRAMMAR_DIR,
    path.join(__dirname, 'native', target),
    path.resolve(__dirname, '..', '..', '.native-grammars', target),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function hasAllNativeGrammars(directory: string): boolean {
  return GRAMMAR_LANGUAGES.every((language) =>
    fs.existsSync(path.join(directory, nativeLibraryFileName(NATIVE_GRAMMARS[language].libraryName)))
  );
}

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c', // Could also be C++, defaulting to C
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cu': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cuh': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  // Drupal-specific PHP file extensions
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.inc': 'php',
  // YAML (used for Drupal routing files; no symbol extraction, file-level tracking only)
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'yaml',
  // Twig templates (file-level tracking only, no symbol extraction)
  '.twig': 'twig',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.vue': 'vue',
  '.astro': 'astro',
  '.jinja': 'jinja',
  '.jinja2': 'jinja',
  '.html': 'jinja',
  '.cshtml': 'razor',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.lfm': 'pascal',
  '.lpi': 'pascal',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.luau': 'luau',
  '.m': 'objc',
  '.mm': 'objc',
  '.v': 'systemverilog',
  '.vh': 'systemverilog',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.jl': 'julia',
  '.f': 'fortran',
  '.for': 'fortran',
  '.f90': 'fortran',
  '.f95': 'fortran',
  '.f03': 'fortran',
  '.f08': 'fortran',
  '.r': 'r',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
  '.gvy': 'groovy',
  '.gy': 'groovy',
  '.gsh': 'groovy',
  '.vb': 'vbnet',
  '.sql': 'sql',
  '.tf': 'hcl',
  '.hcl': 'hcl',
  '.nix': 'nix',
  '.ets': 'arkts',
  '.scl': 'scl',
  '.sol': 'solidity',
  '.sh': 'bash',
  '.bash': 'bash',
  '.bats': 'bash',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
};

/**
 * Whether a file is one SolidKG can parse, based purely on its extension.
 * This is the single source of truth for "should we index this file" — derived
 * from EXTENSION_MAP so parser support and indexing selection never drift.
 */
export function isSourceFile(filePath: string): boolean {
  if (isPlayRoutesFile(filePath)) return true; // Play `conf/routes` is extensionless
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return filePath.slice(dot).toLowerCase() in EXTENSION_MAP;
}

/**
 * Play Framework routes file: the extensionless `conf/routes` (and included
 * `conf/*.routes`). No grammar — route extraction is done by the Play framework
 * resolver, so it's processed through the no-grammar (`yaml`-style) path.
 */
export function isPlayRoutesFile(filePath: string): boolean {
  return (
    filePath === 'conf/routes' ||
    filePath.endsWith('/conf/routes') ||
    filePath.endsWith('.routes')
  );
}

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const loadedLanguages = new Set<Language>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * Initialize the native tree-sitter runtime against SolidKG's staged grammar set.
 * Idempotent — safe to call multiple times.
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;
  const cacheDir = grammarDirectoryCandidates().find(hasAllNativeGrammars);
  if (!cacheDir) {
    throw new Error(
      `SolidKG native grammar assets are missing for ${process.platform}-${process.arch}. ` +
      'Reinstall SolidKG or run pnpm run prepare:native-runtime from a source checkout.'
    );
  }
  configureLanguagePack({ cacheDir });
  parserInitialized = true;
}

/**
 * Load native grammars for specific languages only.
 * Skips languages that are already loaded or use a standalone extractor.
 * Must be called after initGrammars().
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  const toLoad = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage =>
      isGrammarLanguage(lang) &&
      !loadedLanguages.has(lang) &&
      !unavailableGrammarErrors.has(lang)
  );

  for (const lang of toLoad) {
    try {
      parserCache.set(lang, new Parser(getNativeParser(NATIVE_GRAMMARS[lang].packageName)));
      loadedLanguages.add(lang);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[SolidKG] Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * Load every native grammar. Convenience function for tests and
 * backward compatibility. Prefer loadGrammarsForLanguages() in production.
 */
export async function loadAllGrammars(): Promise<void> {
  await loadGrammarsForLanguages([...GRAMMAR_LANGUAGES]);
}

/**
 * Check if grammars have been initialized
 */
export function isGrammarsInitialized(): boolean {
  return parserInitialized;
}

/**
 * Get a parser for the specified language.
 * Returns synchronously from pre-loaded cache.
 */
export function getParser(language: Language): Parser | null {
  const cached = parserCache.get(language);
  if (cached) return cached;
  if (!parserInitialized || !isGrammarLanguage(language) || unavailableGrammarErrors.has(language)) {
    return null;
  }

  try {
    const parser = new Parser(getNativeParser(NATIVE_GRAMMARS[language].packageName));
    parserCache.set(language, parser);
    loadedLanguages.add(language);
    return parser;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[SolidKG] Failed to load ${language} grammar — parsing will be unavailable: ${message}`);
    unavailableGrammarErrors.set(language, message);
    return null;
  }
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string, source?: string): Language {
  // Play `conf/routes` has no grammar — route through the no-symbol path; the
  // Play framework resolver extracts route nodes from it.
  if (isPlayRoutesFile(filePath)) return 'yaml';
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const lang = EXTENSION_MAP[ext] || 'unknown';

  // .h files could be C, C++, or Objective-C — check source content
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeCpp(source)) return 'cpp';
    if (looksLikeObjc(source)) return 'objc';
  }

  return lang;
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Checks the first ~8KB for patterns that are unique to C++ and never valid C.
 */
function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample);
}

/**
 * Heuristic: does a .h file contain Objective-C constructs?
 */
function looksLikeObjc(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(sample);
}

/**
 * Check if a language is supported (has a grammar defined).
 * Returns true if the grammar exists, even if not yet loaded.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'svelte') return true; // custom extractor (script block delegation)
  if (language === 'vue') return true; // custom extractor (script block delegation)
  if (language === 'liquid') return true; // custom regex extractor
  if (language === 'astro') return true;
  if (language === 'jinja') return true;
  if (language === 'razor') return true;
  if (language === 'arkts') return true;
  if (language === 'scl') return true;
  if (language === 'yaml') return true; // file-level tracking only; Drupal routing extraction via framework resolver
  if (language === 'twig') return true; // file-level tracking only
  if (language === 'unknown') return false;
  return isGrammarLanguage(language);
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 */
export function isGrammarLoaded(language: Language): boolean {
  if (language === 'svelte' || language === 'vue' || language === 'liquid') return true;
  if (language === 'astro' || language === 'jinja' || language === 'razor') return true;
  if (language === 'arkts' || language === 'scl') return true;
  if (language === 'yaml' || language === 'twig') return true; // no WASM grammar needed
  return loadedLanguages.has(language);
}

/**
 * Get all supported languages (those with grammar definitions).
 */
export function getSupportedLanguages(): Language[] {
  return [...GRAMMAR_LANGUAGES, 'svelte', 'vue', 'liquid', 'astro', 'jinja', 'razor', 'arkts', 'scl'];
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    parser.delete();
  }
  parserCache.clear();
  loadedLanguages.clear();
  unavailableGrammarErrors.clear();
}

/**
 * Report grammars that failed to load.
 */
export function getUnavailableGrammarErrors(): Partial<Record<Language, string>> {
  const out: Partial<Record<Language, string>> = {};
  for (const [language, message] of unavailableGrammarErrors.entries()) {
    out[language] = message;
  }
  return out;
}

/**
 * Get language display name
 */
export function getLanguageDisplayName(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    vue: 'Vue',
    liquid: 'Liquid',
    astro: 'Astro',
    jinja: 'Jinja2 / HTML templates',
    razor: 'Razor',
    pascal: 'Pascal / Delphi',
    scala: 'Scala',
    lua: 'Lua',
    luau: 'Luau',
    objc: 'Objective-C',
    systemverilog: 'Verilog / SystemVerilog',
    julia: 'Julia',
    fortran: 'Fortran',
    r: 'R',
    groovy: 'Groovy',
    vbnet: 'Visual Basic .NET',
    sql: 'SQL',
    hcl: 'HCL/Terraform',
    nix: 'Nix',
    arkts: 'ArkTS',
    scl: 'PLC SCL',
    solidity: 'Solidity',
    bash: 'Bash / sh',
    powershell: 'PowerShell',
    yaml: 'YAML',
    twig: 'Twig',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
