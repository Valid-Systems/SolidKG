/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { matchReference } from './name-matcher';
import { resolveViaImport, resolveImportPath, extractImportMappings, extractReExports } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { synthesizeCallbackEdges } from './callback-synthesizer';
import { synthesizeSemanticHyperedges } from '../hypergraph/synthesizer';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { logDebug } from '../errors';
import type { ReExport } from './types';
import { LRUCache } from './lru-cache';
import { buildSourceRoots, type SourceRoot, type SourceRootOptions } from '../source-roots';
import { normalizePath, validatePathWithinRoot } from '../utils';

/**
 * Cache size limits. Each per-resolver cache is bounded so memory
 * stays flat on large codebases (20k+ files). Sizes were chosen to
 * cover the working set for typical resolution batches without
 * exceeding a few hundred MB worst-case. Override via the env var
 * `SOLIDKG_RESOLVER_CACHE_SIZE` (single integer applied to all
 * caches) when tuning for very large or very small projects.
 */
const DEFAULT_CACHE_LIMIT = 5_000;
function resolveCacheLimit(): number {
  const raw = process.env.SOLIDKG_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// Re-export types
export * from './types';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime', 'utilwait', 'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

const CSHARP_BUILT_INS = new Set([
  'nameof',
]);

const CSHARP_EXTERNAL_MEMBERS = new Set([
  'GetType',
  'ToString',
  'GetHashCode',
  'Equals',
  'HasFlag',
]);

const POWERSHELL_EXTERNAL_COMMANDS = new Set([
  'Describe',
  'It',
  'Should',
  'BeforeAll',
  'BeforeEach',
  'AfterAll',
  'AfterEach',
  'Context',
  'Assert-AreEqual',
  'Assert-NotNull',
  'Assert-True',
  'ConvertFrom-Json',
  'ConvertTo-Json',
  'Export-ModuleMember',
  'Find-Module',
  'ForEach-Object',
  'Foreach-Object',
  'Get-AzContext',
  'Get-ChildItem',
  'Get-Command',
  'Get-Content',
  'Get-Item',
  'Get-Module',
  'Get-Random',
  'Join-Path',
  'Measure-Object',
  'New-Guid',
  'New-Object',
  'Save-Module',
  'Select-Object',
  'Split-Path',
  'Start-Sleep',
  'Test-Path',
  'Where-Object',
  'Write-Error',
  'Write-Host',
  'Write-Information',
  'Write-Warning',
]);

function isExternalCSharpTypeof(name: string): boolean {
  return /^typeof\((?:global::)?System\./.test(name);
}

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private sourceRoots: SourceRoot[];
  private frameworks: FrameworkResolver[] = [];
  // All per-resolver caches are LRU-bounded. Previously these were
  // unbounded Maps that grew with every distinct lookup and OOM'd on
  // codebases with 20k+ files (see issue: unbounded cache growth).
  private nodeCache: LRUCache<string, Node[]>; // per-file node cache
  private fileCache: LRUCache<string, string | null>; // per-file content cache
  private importMappingCache: LRUCache<string, ImportMapping[]>;
  private reExportCache: LRUCache<string, ReExport[]>;
  private nameCache: LRUCache<string, Node[]>; // name → nodes cache
  private lowerNameCache: LRUCache<string, Node[]>; // lower(name) → nodes cache
  private qualifiedNameCache: LRUCache<string, Node[]>; // qualified_name → nodes cache
  private possibleMatchCache: LRUCache<string, boolean>;
  private filePathListCache: string[] | undefined;
  private cachesWarmed = false;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder, sourceOptions: SourceRootOptions = {}) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.sourceRoots = buildSourceRoots(this.projectRoot, sourceOptions.extraRoots ?? []);

    const limit = resolveCacheLimit();
    // The content cache is heavier (full file text), so we give it a
    // smaller budget than the metadata caches.
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);
    this.possibleMatchCache = new LRUCache(limit);

    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  warmCaches(): void {
    if (this.cachesWarmed) return;
    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.possibleMatchCache.clear();
    this.filePathListCache = undefined;
    this.cachesWarmed = false;
  }

  private resolveIndexedPath(filePath: string): string | null {
    const normalized = normalizePath(filePath);
    const rootQualified = normalized.match(/^@([^/]+)\/(.*)$/);
    if (rootQualified) {
      const [, label, relativePath] = rootQualified;
      for (const root of this.sourceRoots) {
        if (root.label === label) {
          return validatePathWithinRoot(root.rootDir, relativePath ?? '');
        }
      }
      return null;
    }

    if (this.sourceRoots.length === 1 && !this.queries.hasRootQualifiedFilePath()) {
      return validatePathWithinRoot(this.sourceRoots[0]!.rootDir, normalized);
    }

    return null;
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        const fullPath = this.resolveIndexedPath(filePath);
        if (!fullPath) return false;
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        const fullPath = this.resolveIndexedPath(filePath);
        if (!fullPath) {
          this.fileCache.set(filePath, null);
          return null;
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        if (this.filePathListCache === undefined) {
          this.filePathListCache = this.queries.getAllFilePaths();
        }
        return this.filePathListCache;
      },

      listDirectories: (relativePath: string) => {
        const target = relativePath === '.' || relativePath === ''
          ? this.resolveIndexedPath('')
          : this.resolveIndexedPath(relativePath);
        if (!target) return [];
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getImportMappings: (filePath: string, language) => {
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getReExports: (filePath: string, language) => {
        const cached = this.reExportCache.get(filePath);
        if (cached) return cached;
        const content = this.context.readFile(filePath);
        if (!content) {
          this.reExportCache.set(filePath, []);
          return [];
        }
        const reExports = extractReExports(content, language);
        this.reExportCache.set(filePath, reExports);
        return reExports;
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // Pre-load all nodes into memory for fast lookups
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      id: ref.id,
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
      candidates: ref.candidates,
      relationHint: ref.relationHint,
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // Report progress every 1% to avoid too many updates
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    const cached = this.possibleMatchCache.get(name);
    if (cached !== undefined) return cached;

    const hasName = (candidate: string): boolean => this.queries.hasNodeName(candidate);

    let matches = hasName(name);

    if (!matches && name.includes('.')) {
      const dotIdx = name.indexOf('.');
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      matches = hasName(receiver) || hasName(member) || hasName(capitalized);
    }

    if (!matches && name.includes('::')) {
      const colonIdx = name.indexOf('::');
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      matches = hasName(receiver) || hasName(member);
    }

    if (!matches && name.includes('/')) {
      const slashIdx = name.lastIndexOf('/');
      const fileName = name.substring(slashIdx + 1);
      matches = hasName(fileName);
    }

    this.possibleMatchCache.set(name, matches);
    return matches;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    if (ref.referenceKind === 'imports') {
      const filePath = resolveImportPath(ref.referenceName, ref.filePath, ref.language, this.context);
      if (filePath) {
        const fileNode = this.context.getNodesInFile(filePath).find((node) => node.kind === 'file');
        if (fileNode) {
          return {
            original: ref,
            targetNodeId: fileNode.id,
            confidence: 0.95,
            resolvedBy: 'file-path',
          };
        }
      }
    }

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    if (
      !this.hasAnyPossibleMatch(ref.referenceName) &&
      !this.matchesAnyImport(ref) &&
      !this.frameworks.some((f) => f.claimsReference?.(ref.referenceName))
    ) {
      return null;
    }

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (result) {
        if (result.confidence >= 0.9) return result; // High confidence, return immediately
        candidates.push(result);
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // Strategy 3: Try name matching
    const nameResult = matchReference(ref, this.context);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) return null;

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => {
      let kind = ref.original.referenceKind;

      // Promote "extends" to "implements" when a class/struct targets an interface
      if (kind === 'extends') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements';
          }
        }
      }

      // Promote "calls" to "instantiates" when the resolved target is a
      // class/struct. Languages without a `new` keyword (Python, Ruby)
      // express instantiation as `Foo()` — extraction can't tell that
      // apart from a function call without symbol info, but resolution
      // can: if `Foo` resolves to a class, the call IS an instantiation.
      if (kind === 'calls') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
          kind = 'instantiates';
        }
      }

      return {
        source: ref.original.fromNodeId,
        target: ref.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          confidence: ref.confidence,
          resolvedBy: ref.resolvedBy,
          ...(ref.original.relationHint ? { relationHint: ref.original.relationHint } : {}),
        },
      };
    });
  }

  private runPostResolutionSynthesis(
    changedFiles?: readonly string[],
    onProgress?: (current: number, total: number) => void
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    onProgress?.(0, 2);

    try {
      counts['callback-synthesis'] = synthesizeCallbackEdges(this.queries, this.context);
    } catch {
      counts['callback-synthesis'] = 0;
    }
    onProgress?.(1, 2);

    try {
      counts['hyperedge-synthesis'] = synthesizeSemanticHyperedges(this.queries, { changedFiles });
    } catch (error) {
      counts['hyperedge-synthesis'] = 0;
      logDebug('Semantic hyperedge synthesis failed', { error: String(error) });
    }
    onProgress?.(2, 2);

    return counts;
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void,
    changedFiles?: readonly string[],
    onSynthesisProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    // Clean up resolved refs from unresolved_refs table so metrics are accurate
    const resolvedIds = result.resolved
      .map((r) => r.original.id)
      .filter((id): id is number => id !== undefined);
    const ignoredIds = result.unresolved
      .filter((ref) => this.isBuiltInOrExternal(ref))
      .map((ref) => ref.id)
      .filter((id): id is number => id !== undefined);
    const cleanupIds = [...resolvedIds, ...ignoredIds];
    if (cleanupIds.length > 0) {
      this.queries.deleteUnresolvedReferencesByIds(cleanupIds);
    }

    const synthesisFiles = changedFiles ?? Array.from(
      new Set(unresolvedRefs.map((ref) => ref.filePath).filter((filePath): filePath is string => Boolean(filePath)))
    );
    Object.assign(result.stats.byMethod, this.runPostResolutionSynthesis(synthesisFiles, onSynthesisProgress));

    return result;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000,
    onSynthesisProgress?: (current: number, total: number) => void
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    let lastSeenId = 0;
    while (true) {
      const batch = this.queries.getUnresolvedReferencesAfterId(lastSeenId, batchSize);
      if (batch.length === 0) break;
      lastSeenId = Math.max(...batch.map((ref) => ref.id ?? lastSeenId));

      const result = this.resolveAll(batch);

      // Persist edges immediately
      const edges = this.createEdges(result.resolved);
      if (edges.length > 0) {
        this.queries.insertEdges(edges);
      }

      const resolvedIds = result.resolved
        .map((ref) => ref.original.id)
        .filter((id): id is number => id !== undefined);
      const ignoredIds = result.unresolved
        .filter((ref) => this.isBuiltInOrExternal(ref))
        .map((ref) => ref.id)
        .filter((id): id is number => id !== undefined);
      this.queries.deleteUnresolvedReferencesByIds([...resolvedIds, ...ignoredIds]);

      // Aggregate stats
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += batch.length;
      onProgress?.(processed, total);

      // Yield so progress UI can render between batches
      await new Promise(resolve => setImmediate(resolve));

    }

    Object.assign(aggregateStats.byMethod, this.runPostResolutionSynthesis(undefined, onSynthesisProgress));

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx';

    // JavaScript/TypeScript built-ins
    if (isJsTs && JS_BUILT_INS.has(name)) {
      return true;
    }

    // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React hooks from React itself
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python built-ins (bare calls only — dotted calls like console.print are method calls)
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python built-in method calls (e.g., list.extend, dict.update)
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // Filter calls on built-in types (list.append, dict.update, etc.)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // Filter built-in methods on non-class receivers
        // (e.g., items.append where items is a local list variable)
        // But allow if the capitalized receiver matches a known codebase class
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          if (!this.queries.hasNodeName(capitalized)) {
            return true;
          }
        }
      }
      // A bare name colliding with a builtin method (index, get, update, count…)
      // is only a builtin when NOTHING in the codebase declares it. A declared
      // symbol with that exact name — e.g. a Flask/FastAPI view `def index()` or
      // `def get()` — is a real reference target. Mirrors the symbol-existence
      // guard on the dotted branch above; without it, every handler named after a builtin
      // method silently loses its route→handler edge.
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.queries.hasNodeName(name)) {
        return true;
      }
    }

    // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx);
        if (GO_STDLIB_PACKAGES.has(pkg)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    if (ref.language === 'csharp') {
      if (this.queries.hasNodeName(name)) {
        return false;
      }
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        if (this.queries.hasNodeName(receiver)) {
          return false;
        }
      }
      if (CSHARP_BUILT_INS.has(name)) {
        return true;
      }
      if (name === 'System' || name.startsWith('System.') || name.startsWith('global::System.')) {
        return true;
      }
      if (isExternalCSharpTypeof(name)) {
        return true;
      }
      if (dotIdx > 0 && CSHARP_EXTERNAL_MEMBERS.has(name.substring(dotIdx + 1))) {
        return true;
      }
    }

    if (ref.language === 'powershell') {
      if (this.queries.hasNodeName(name)) {
        return false;
      }
      if (POWERSHELL_EXTERNAL_COMMANDS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi built-ins and standard library units
    if (ref.language === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(
  projectRoot: string,
  queries: QueryBuilder,
  sourceOptions: SourceRootOptions = {}
): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries, sourceOptions);
  resolver.initialize();
  return resolver;
}
