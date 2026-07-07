import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { hiddenSpawnOptions } from '../platform/child-process';
import { fileURLToPath } from 'url';
import {
  deserializeSCIP,
  PositionEncoding,
  SymbolInformation_Kind,
  SymbolRole,
  type Document,
  type Index,
  type Occurrence,
  type Relationship,
  type SymbolInformation,
} from '@c4312/scip';
import type { QueryBuilder } from '../db/queries';
import type {
  Edge,
  Node,
  ScipDocumentRecord,
  ScipGenerationResult,
  ScipGenerationStatus,
  ScipIndexerAvailability,
  ScipIndexerConfig,
  ScipImportStats,
  ScipLinkStats,
  ScipMode,
  ScipOccurrenceRecord,
  ScipRelationshipRecord,
  ScipSymbolRecord,
} from '../types';

export interface ImportScipIndexesOptions {
  projectRoot: string;
  indexFiles: string[];
  maxBytes?: number;
  maxFacts?: number;
}

export interface GenerateScipIndexesOptions {
  projectRoot: string;
  mode?: ScipMode;
  indexers?: Record<string, ScipIndexerConfig>;
  languages?: string[];
  outputDir?: string;
  storageRoot?: string;
}

type Range = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

type ResolvedCommand = {
  executable: string;
  args?: string[];
  displayName: string;
  useCmdShim: boolean;
};

type IndexerRun = {
  cwd: string;
  outputFile: string;
  cleanupPaths?: string[];
};

const SCIP_GENERATION_METADATA_KEY = 'scip:generation';
const DEFAULT_SCIP_TIMEOUT_MS = 120_000;
const COMMAND_PROBE_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_CHARS = 2000;
const DEFAULT_MAX_SCIP_INDEX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SCIP_FACTS = 1_000_000;
const MAX_SCIP_LINK_DEFINITIONS = 100_000;

export const DEFAULT_SCIP_INDEXERS: Record<string, ScipIndexerConfig> = {
  typescript: {
    command: 'scip-typescript',
    args: ['index', '--infer-tsconfig', '--output', '{output}'],
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  },
  go: {
    command: 'scip-go',
    args: ['--output', '{output}'],
    files: ['**/*.go'],
  },
  rust: {
    command: 'scip-rust',
    args: ['--output', '{output}', '.'],
    files: ['**/*.rs'],
  },
  python: {
    command: 'scip-python',
    args: ['index', '.', '--project-version', '_', '--output', '{output}'],
    files: ['**/*.py'],
  },
  csharp: {
    command: 'scip-dotnet',
    args: ['index', '--output', '{output}'],
    files: ['**/*.cs'],
  },
};

export function canonicalizeScipSymbol(documentId: string, symbol: string): string {
  return symbol.startsWith('local ') ? `${documentId} ${symbol}` : symbol;
}

export function normalizeScipRange(range: readonly number[]): Range {
  if (range.length === 3) {
    const [startLine, startCharacter, endCharacter] = range as [number, number, number];
    return {
      startLine: startLine + 1,
      startCharacter,
      endLine: startLine + 1,
      endCharacter,
    };
  }
  if (range.length === 4) {
    const [startLine, startCharacter, endLine, endCharacter] = range as [number, number, number, number];
    return {
      startLine: startLine + 1,
      startCharacter,
      endLine: endLine + 1,
      endCharacter,
    };
  }
  throw new Error(`Invalid SCIP range length: ${range.length}`);
}

export function normalizeScipDocumentPath(workspaceRoot: string, indexProjectRoot: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (normalizedRelative.split('/').some((part) => part === '..')) {
    throw new Error(`SCIP document path escapes outside workspace: ${relativePath}`);
  }
  const projectRoot = normalizeScipProjectRoot(indexProjectRoot);
  const root = normalizePlatformPath(workspaceRoot);
  const project = normalizePlatformPath(projectRoot);
  if (samePathFlavor(root, project)) {
    const absolute = normalizeLexicalPath(project, normalizedRelative);
    const relativeToWorkspace = path.posix.relative(root, absolute);
    if (relativeToWorkspace.startsWith('..') || path.posix.isAbsolute(relativeToWorkspace)) {
      throw new Error(`SCIP document path escapes outside workspace: ${relativePath}`);
    }
    return relativeToWorkspace;
  }
  const absolute = path.resolve(projectRoot, normalizedRelative);
  const nativeRoot = path.resolve(workspaceRoot);
  const relativeToWorkspace = path.relative(nativeRoot, absolute);
  if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace)) {
    throw new Error(`SCIP document path escapes outside workspace: ${relativePath}`);
  }
  return relativeToWorkspace.replace(/\\/g, '/');
}

function normalizePlatformPath(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function samePathFlavor(left: string, right: string): boolean {
  return (/^[A-Za-z]:\//.test(left) && /^[A-Za-z]:\//.test(right)) || (left.startsWith('/') && right.startsWith('/'));
}

function normalizeLexicalPath(root: string, relativePath: string): string {
  return path.posix.normalize(`${root}/${relativePath}`);
}

function normalizeScipProjectRoot(projectRoot: string): string {
  if (!projectRoot.startsWith('file://')) return projectRoot;
  if (/^file:\/\/[A-Za-z]:/i.test(projectRoot)) return decodeURIComponent(projectRoot.slice('file://'.length));
  if (/^file:\/\/\/[A-Za-z]:/i.test(projectRoot)) return decodeURIComponent(projectRoot.slice('file:///'.length));
  try {
    return fileURLToPath(projectRoot);
  } catch (err) {
    void err;
    const encodedPath = projectRoot.slice('file://'.length);
    if (/^[A-Za-z]:/i.test(encodedPath)) return decodeURIComponent(encodedPath);
    throw err;
  }
}

export async function importScipIndexes(queries: QueryBuilder, options: ImportScipIndexesOptions): Promise<ScipImportStats> {
  for (const indexFile of options.indexFiles) {
    const index = readScipIndexFile(indexFile, options);
    queries.transaction(() => importScipIndex(queries, options.projectRoot, indexFile, index));
  }
  return queries.getScipStats();
}

export async function generateScipIndexes(
  queries: QueryBuilder,
  options: GenerateScipIndexesOptions
): Promise<ScipGenerationResult> {
  const startedAt = Date.now();
  const mode = options.mode ?? 'auto';
  const projectRoot = realpathIfExists(options.projectRoot);
  const storageRoot = options.storageRoot ? realpathIfExists(options.storageRoot) : projectRoot;
  const outputDir = path.resolve(projectRoot, options.outputDir ?? path.join(projectRoot, '.solidkg', 'scip'));
  const usingDefaultIndexers = options.indexers === undefined;
  const indexers = options.indexers ?? DEFAULT_SCIP_INDEXERS;
  const detected = detectScipLanguages(queries, options.languages);
  const status: ScipGenerationStatus = { mode, updatedAt: Date.now(), languages: {} };
  const generatedFiles: string[] = [];
  const errors: Array<{ language: string; message: string }> = [];

  for (const [language, fileCount] of detected) {
    const config = indexers[language];
    if (mode === 'off') {
      status.languages[language] = { language, state: 'skipped', fileCount, message: 'SCIP generation disabled' };
      continue;
    }
    if (!config) {
      const message = 'No SCIP indexer configured for this language';
      status.languages[language] = { language, state: 'unsupported', fileCount, message };
      if (mode === 'required') errors.push({ language, message });
      continue;
    }

    const runs = buildIndexerRuns(language, projectRoot, outputDir, queries, usingDefaultIndexers);
    const outputFile = runs[0]?.outputFile ?? path.join(outputDir, `${language}.scip`);
    const resolved = resolveIndexerCommand(config.command, projectRoot, !usingDefaultIndexers);
    if (typeof resolved === 'string') {
      const message = resolved;
      status.languages[language] = { language, state: 'indexer-missing', fileCount, command: config.command, outputFile, message };
      if (mode === 'required') errors.push({ language, message });
      continue;
    }
    const availability = await commandAvailable(resolved, COMMAND_PROBE_TIMEOUT_MS);
    if (!availability.available) {
      const message = availability.reason ?? `Indexer command not found or did not respond: ${config.command}`;
      status.languages[language] = { language, state: 'indexer-missing', fileCount, command: resolved.displayName, outputFile, message };
      if (mode === 'required') errors.push({ language, message });
      continue;
    }

    let generatedCount = 0;
    let totalDurationMs = 0;
    let lastOutputFile = outputFile;
    const failures: string[] = [];
    for (const run of runs) {
      const outputGuard = prepareScipOutput(projectRoot, storageRoot, outputDir, run.outputFile);
      if (outputGuard) {
        failures.push(outputGuard);
        if (mode === 'required') errors.push({ language, message: outputGuard });
        continue;
      }
      const args = buildIndexerArgs(config, run.outputFile);
      const commandStart = Date.now();
      const result = await runCommand(resolved, args, run.cwd, config.timeoutMs ?? DEFAULT_SCIP_TIMEOUT_MS);
      const durationMs = Date.now() - commandStart;
      totalDurationMs += durationMs;
      removeGeneratedConfigs(run.cleanupPaths ?? []);
      const failure = commandFailure(result);
      if (failure) {
        failures.push(failure);
        if (mode === 'required') errors.push({ language, message: failure });
        continue;
      }
      if (!fs.existsSync(run.outputFile) || fs.statSync(run.outputFile).size === 0) {
        const message = `SCIP indexer did not write ${run.outputFile}`;
        failures.push(message);
        if (mode === 'required') errors.push({ language, message });
        continue;
      }
      const invalidIndex = validateGeneratedScipIndex(run.outputFile);
      if (invalidIndex) {
        failures.push(invalidIndex);
        if (mode === 'required') errors.push({ language, message: invalidIndex });
        continue;
      }

      generatedFiles.push(run.outputFile);
      generatedCount += 1;
      lastOutputFile = run.outputFile;
    }

    if (generatedCount > 0) {
      status.languages[language] = { language, state: 'generated', fileCount, command: resolved.displayName, outputFile: lastOutputFile, durationMs: totalDurationMs };
    } else {
      const message = failures[0] ?? `SCIP indexer did not generate output for ${language}`;
      status.languages[language] = { language, state: 'failed', fileCount, command: resolved.displayName, outputFile, message, durationMs: totalDurationMs };
      if (mode === 'required' && failures.length === 0) errors.push({ language, message });
    }
  }

  storeScipGenerationStatus(queries, status);
  return {
    success: errors.length === 0,
    mode,
    generatedFiles,
    status,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

export function getScipGenerationStatus(queries: QueryBuilder): ScipGenerationStatus {
  const raw = queries.getMetadata(SCIP_GENERATION_METADATA_KEY);
  if (!raw) return emptyScipGenerationStatus();
  try {
    const parsed = JSON.parse(raw) as ScipGenerationStatus;
    if (!parsed || typeof parsed !== 'object' || !parsed.languages) return emptyScipGenerationStatus();
    return parsed;
  } catch (err) {
    void err;
    return emptyScipGenerationStatus();
  }
}

export function storeScipGenerationStatus(queries: QueryBuilder, status: ScipGenerationStatus): void {
  queries.setMetadata(SCIP_GENERATION_METADATA_KEY, JSON.stringify(status));
}

export function linkScipSymbolsToNodes(queries: QueryBuilder): ScipLinkStats {
  let nodesUpdated = 0;
  let edgesInserted = 0;
  const linkedNodesByScipSymbol = new Map<string, Node>();
  const usedNodeIds = new Set<string>();

  const definitions = queries.getScipDefinitionOccurrencesWithDocuments(MAX_SCIP_LINK_DEFINITIONS);
  const definitionCandidates = queries.getUnlinkedNodesByFilesAndNames(
    definitions.map((definition) => definition.document.repoRelativePath),
    definitions.flatMap((definition) => scipSymbolNames(definition.symbol))
  );
  const candidatesByFile = groupNodesByNormalizedFilePath(definitionCandidates);
  const nodeUpdates: Array<{ nodeId: string; symbol: ScipSymbolRecord }> = [];

  for (const definition of definitions) {
    const names = new Set(scipSymbolNames(definition.symbol));
    const candidates = (candidatesByFile.get(normalizeLinkFilePath(definition.document.repoRelativePath)) ?? [])
      .filter((node) => names.has(node.name) && !usedNodeIds.has(node.id));
    const best = bestScipNodeCandidate(candidates, definition.occurrence.startLine, definition.symbol);
    if (!best) continue;
    nodeUpdates.push({ nodeId: best.id, symbol: definition.symbol });
    linkedNodesByScipSymbol.set(definition.symbol.symbol, best);
    usedNodeIds.add(best.id);
    nodesUpdated++;
  }
  queries.updateNodeScipSymbols(nodeUpdates);
  queries.clearCache();

  const relationships = queries.getScipImplementationRelationships();
  for (const node of queries.getNodesByScipSymbols(relationships.flatMap((relationship) => [relationship.sourceSymbol, relationship.targetSymbol]))) {
    if (node.scipSymbol) linkedNodesByScipSymbol.set(node.scipSymbol, node);
    usedNodeIds.add(node.id);
  }

  const missingTargetSymbols = Array.from(new Set(relationships
    .map((relationship) => relationship.targetSymbol)
    .filter((symbol) => !linkedNodesByScipSymbol.has(symbol))));
  const targetSymbols = queries.getScipSymbols(missingTargetSymbols);
  const targetCandidates = queries.getUnlinkedNodesByNames(targetSymbols.flatMap((symbol) => scipSymbolNames(symbol)));
  const targetUpdates: Array<{ nodeId: string; symbol: ScipSymbolRecord }> = [];
  for (const targetSymbol of targetSymbols) {
    const targetCandidate = uniqueNodeForScipSymbol(targetCandidates, targetSymbol, usedNodeIds);
    if (!targetCandidate) continue;
    targetUpdates.push({ nodeId: targetCandidate.id, symbol: targetSymbol });
    linkedNodesByScipSymbol.set(targetSymbol.symbol, targetCandidate);
    usedNodeIds.add(targetCandidate.id);
    nodesUpdated++;
  }
  queries.updateNodeScipSymbols(targetUpdates);

  for (const relationship of relationships) {
    const source = linkedNodesByScipSymbol.get(relationship.sourceSymbol);
    const target = linkedNodesByScipSymbol.get(relationship.targetSymbol);
    if (!source || !target) continue;
    const edge: Edge = {
      source: source.id,
      target: target.id,
      kind: 'implements',
      provenance: 'scip',
      metadata: { scipRelationship: relationship.id },
    };
    queries.insertEdge(edge);
    edgesInserted++;
  }
  queries.clearCache();
  return { nodesUpdated, edgesInserted };
}

export async function resolveScipIndexerAvailability(
  configs: Record<string, ScipIndexerConfig>
): Promise<Record<string, ScipIndexerAvailability>> {
  const entries = await Promise.all(Object.entries(configs).map(async ([language, config]) => {
    const resolved = resolveIndexerCommand(config.command, process.cwd(), true);
    if (typeof resolved === 'string') return [language, { available: false, reason: resolved }] as const;
    const availability = await commandAvailable(resolved, COMMAND_PROBE_TIMEOUT_MS);
    return [language, availability] as const;
  }));
  return Object.fromEntries(entries);
}

function importScipIndex(queries: QueryBuilder, workspaceRoot: string, indexFile: string, index: Index): void {
  const metadata = index.metadata;
  const indexProjectRoot = metadata?.projectRoot || workspaceRoot;
  const sourceKey = scipIndexSourceKey(indexFile, indexProjectRoot);
  const indexId = hashId('scip:index', [indexFile, indexProjectRoot, metadata?.toolInfo?.name ?? '', metadata?.toolInfo?.version ?? '']);
  queries.deleteScipIndexesBySource(sourceKey, true);
  queries.deleteScipIndex(indexId, true);
  queries.insertScipIndex({
    id: indexId,
    projectRoot: indexProjectRoot,
    toolName: metadata?.toolInfo?.name,
    toolVersion: metadata?.toolInfo?.version,
    arguments: metadata?.toolInfo?.arguments,
    textDocumentEncoding: metadata?.textDocumentEncoding !== undefined ? String(metadata.textDocumentEncoding) : undefined,
    createdAt: Date.now(),
    metadata: { sourceKey, indexFile: path.resolve(indexFile) },
  });
  for (const document of index.documents) {
    importScipDocument(queries, workspaceRoot, indexProjectRoot, indexId, document);
  }
  for (const externalSymbol of index.externalSymbols) {
    queries.upsertScipSymbol(symbolRecord(indexId, externalSymbol, externalSymbol.symbol));
  }
}

function importScipDocument(
  queries: QueryBuilder,
  workspaceRoot: string,
  indexProjectRoot: string,
  indexId: string,
  document: Document
): void {
  const repoRelativePath = normalizeScipDocumentPath(workspaceRoot, indexProjectRoot, document.relativePath);
  const documentId = hashId('scip:document', [indexId, repoRelativePath]);
  const documentRecord: ScipDocumentRecord = {
    id: documentId,
    indexId,
    relativePath: document.relativePath,
    repoRelativePath,
    language: document.language || 'unknown',
    positionEncoding: positionEncodingName(document.positionEncoding),
    textSha256: document.text ? createHash('sha256').update(document.text).digest('hex') : undefined,
  };
  queries.insertScipDocument(documentRecord);
  const upsertedSymbols = new Map<string, boolean>();
  const upsertSymbol = (record: ScipSymbolRecord): void => {
    const hasMetadata = hasScipSymbolMetadata(record);
    const previousHasMetadata = upsertedSymbols.get(record.symbol);
    if (previousHasMetadata === true || previousHasMetadata === hasMetadata) return;
    upsertedSymbols.set(record.symbol, hasMetadata);
    queries.upsertScipSymbol(record);
  };
  for (const symbol of document.symbols) {
    const canonicalSymbol = canonicalizeScipSymbol(documentId, symbol.symbol);
    upsertSymbol(symbolRecord(indexId, symbol, canonicalSymbol));
    for (const relationship of symbol.relationships) {
      upsertSymbol({ symbol: canonicalizeScipSymbol(documentId, relationship.symbol), sourceIndexIds: [indexId] });
      queries.insertScipRelationship(relationshipRecord(indexId, documentId, canonicalSymbol, relationship));
    }
  }
  for (const occurrence of document.occurrences) {
    const canonicalSymbol = occurrence.symbol ? canonicalizeScipSymbol(documentId, occurrence.symbol) : undefined;
    if (canonicalSymbol) {
      upsertSymbol({ symbol: canonicalSymbol, sourceIndexIds: [indexId] });
    }
    queries.insertScipOccurrence(occurrenceRecord(documentId, occurrence, canonicalSymbol));
  }
}

function hasScipSymbolMetadata(record: ScipSymbolRecord): boolean {
  return Boolean(
    record.scheme
      || record.packageManager
      || record.packageName
      || record.packageVersion
      || record.displayName
      || record.kind
      || record.enclosingSymbol
      || record.documentation
      || record.signatureLanguage
      || record.signatureText
      || record.metadata
  );
}

function symbolRecord(indexId: string, symbol: SymbolInformation, canonicalSymbol: string): ScipSymbolRecord {
  return {
    symbol: canonicalSymbol,
    displayName: symbol.displayName || undefined,
    kind: symbolKindName(symbol.kind),
    enclosingSymbol: symbol.enclosingSymbol || undefined,
    documentation: symbol.documentation.length > 0 ? symbol.documentation.join('\n') : undefined,
    signatureLanguage: symbol.signatureDocumentation?.language || undefined,
    signatureText: symbol.signatureDocumentation?.text || undefined,
    sourceIndexIds: [indexId],
  };
}

function occurrenceRecord(documentId: string, occurrence: Occurrence, canonicalSymbol: string | undefined): ScipOccurrenceRecord {
  const range = normalizeScipRange(occurrence.range);
  const enclosing = occurrence.enclosingRange.length > 0 ? normalizeScipRange(occurrence.enclosingRange) : undefined;
  return {
    id: hashId('scip:occurrence', [documentId, canonicalSymbol ?? '', occurrence.range.join(':')]),
    documentId,
    symbol: canonicalSymbol,
    ...range,
    symbolRoles: occurrence.symbolRoles,
    syntaxKind: String(occurrence.syntaxKind),
    enclosingStartLine: enclosing?.startLine,
    enclosingStartCharacter: enclosing?.startCharacter,
    enclosingEndLine: enclosing?.endLine,
    enclosingEndCharacter: enclosing?.endCharacter,
    overrideDocumentation: occurrence.overrideDocumentation.length > 0 ? occurrence.overrideDocumentation : undefined,
    diagnostics: occurrence.diagnostics.length > 0 ? occurrence.diagnostics : undefined,
  };
}

function relationshipRecord(indexId: string, documentId: string, sourceSymbol: string, relationship: Relationship): ScipRelationshipRecord {
  const targetSymbol = canonicalizeScipSymbol(documentId, relationship.symbol);
  return {
    id: hashId('scip:relationship', [sourceSymbol, targetSymbol, String(relationship.isReference), String(relationship.isImplementation), String(relationship.isTypeDefinition), String(relationship.isDefinition)]),
    sourceSymbol,
    targetSymbol,
    isReference: relationship.isReference,
    isImplementation: relationship.isImplementation,
    isTypeDefinition: relationship.isTypeDefinition,
    isDefinition: relationship.isDefinition,
    metadata: { sourceIndexIds: [indexId] },
  };
}

function detectScipLanguages(queries: QueryBuilder, requestedLanguages: string[] | undefined): Map<string, number> {
  const detected = new Map<string, number>();
  if (requestedLanguages && requestedLanguages.length > 0) {
    for (const language of requestedLanguages) detected.set(language, 0);
    return detected;
  }
  for (const row of queries.getFileLanguageCounts()) {
    const language = scipLanguageKey(row.language);
    detected.set(language, (detected.get(language) ?? 0) + row.count);
  }
  return detected;
}

function scipLanguageKey(language: string): string {
  if (language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'jsx') return 'typescript';
  return language;
}

function buildIndexerRuns(
  language: string,
  projectRoot: string,
  outputDir: string,
  queries: QueryBuilder,
  usingDefaultIndexers: boolean
): IndexerRun[] {
  const defaultRun = (cwd = projectRoot, outputFile = path.join(outputDir, `${language}.scip`)): IndexerRun => ({
    cwd,
    outputFile,
    cleanupPaths: usingDefaultIndexers && language === 'typescript' && !fs.existsSync(path.join(cwd, 'tsconfig.json'))
      ? [path.join(cwd, 'tsconfig.json')]
      : [],
  });
  if (!usingDefaultIndexers || language !== 'go') return [defaultRun()];

  const moduleRoots = findGoModuleRoots(projectRoot, queries);
  if (moduleRoots.length === 0) return [defaultRun()];
  if (moduleRoots.length === 1) return [defaultRun(moduleRoots[0])];
  return moduleRoots.map((moduleRoot) => defaultRun(moduleRoot, path.join(outputDir, `go-${hashId('module', [path.relative(projectRoot, moduleRoot)]).slice('module:'.length, 'module:'.length + 12)}.scip`)));
}

function findGoModuleRoots(projectRoot: string, queries: QueryBuilder): string[] {
  const roots = new Set<string>();
  for (const filePath of queries.getFilePathsByLanguage('go')) {
    const moduleRoot = findNearestGoModRoot(projectRoot, path.resolve(projectRoot, filePath));
    if (moduleRoot) roots.add(moduleRoot);
  }
  return Array.from(roots).sort((left, right) => left.localeCompare(right));
}

function findNearestGoModRoot(projectRoot: string, filePath: string): string | null {
  const root = path.resolve(projectRoot);
  let current = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  while (isPathInside(current, root)) {
    if (fs.existsSync(path.join(current, 'go.mod'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.existsSync(path.join(root, 'go.mod')) ? root : null;
}

function removeGeneratedConfigs(paths: string[]): void {
  for (const configPath of paths) {
    try {
      if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    } catch (err) {
      void err;
    }
  }
}

function buildIndexerArgs(config: ScipIndexerConfig, outputFile: string): string[] {
  const templateArgs = config.args ?? ['--output', '{output}'];
  const args = templateArgs.map((arg) => arg.replaceAll('{output}', outputFile));
  if (!templateArgs.some((arg) => arg.includes('{output}'))) {
    args.push('--output', outputFile);
  }
  return args;
}

function commandFailure(result: CommandResult): string | null {
  if (result.timedOut) return 'SCIP indexer timed out';
  if (result.error) return sanitizeCommandOutput(result.error);
  if (result.code === 0) return null;
  const details = sanitizeCommandOutput(result.stderr.trim() || result.stdout.trim());
  return details ? `SCIP indexer exited with code ${result.code}: ${details}` : `SCIP indexer exited with code ${result.code}`;
}

function runCommand(command: ResolvedCommand, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawnCommand(command, [...(command.args ?? []), ...args], cwd);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child).finally(() => {
        resolve({ code: null, stdout, stderr, timedOut: true });
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString()); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString()); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut: false, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

function resolveIndexerCommand(command: string, projectRoot: string, allowProjectLocal: boolean): ResolvedCommand | string {
  const directPath = command.includes('/') || command.includes('\\') ? path.resolve(projectRoot, command) : null;
  const candidates = directPath ? commandCandidates(directPath) : pathCandidates(command);
  let unsafeCandidate: string | undefined;
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    const resolved = fs.realpathSync(candidate);
    if (!allowProjectLocal && isUnsafeIndexerPath(resolved, projectRoot)) {
      unsafeCandidate = resolved;
      continue;
    }
    return {
      executable: resolved,
      displayName: resolved,
      useCmdShim: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved),
    };
  }
  const bundled = bundledIndexerCommand(command);
  if (bundled) return bundled;
  if (unsafeCandidate) return `Refusing to run project-local SCIP indexer command: ${unsafeCandidate}`;
  return `Indexer command not found: ${command}`;
}

function bundledIndexerCommand(command: string): ResolvedCommand | null {
  if (command !== 'scip-typescript') return null;
  const main = resolvePackageBin('@sourcegraph/scip-typescript', 'scip-typescript');
  if (!main) return null;
  return {
    executable: process.execPath,
    args: [main],
    displayName: `${process.execPath} ${main}`,
    useCmdShim: false,
  };
}

function resolvePackageBin(packageName: string, binName: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageRoot = path.dirname(packageJsonPath);
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.[binName];
    if (!bin) return null;
    const resolved = path.resolve(packageRoot, bin);
    return fs.existsSync(resolved) ? resolved : null;
  } catch (err) {
    void err;
    return null;
  }
}

function pathCandidates(command: string): string[] {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry && entry !== '.');
  return pathEntries.flatMap((entry) => commandCandidates(path.join(entry, command)));
}

function commandCandidates(candidate: string): string[] {
  if (path.extname(candidate)) return [candidate];
  if (process.platform !== 'win32') return [candidate];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [...exts.map((ext) => `${candidate}${ext.toLowerCase()}`), ...exts.map((ext) => `${candidate}${ext.toUpperCase()}`), candidate];
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (err) {
    void err;
    return false;
  }
}

function isUnsafeIndexerPath(candidate: string, projectRoot: string): boolean {
  return isPathInside(candidate, realpathIfExists(projectRoot));
}

function spawnCommand(command: ResolvedCommand, args: string[], cwd: string) {
  const detached = process.platform !== 'win32';
  if (!command.useCmdShim) {
    return spawn(command.executable, args, hiddenSpawnOptions({ cwd, detached, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  const comspec = process.env.ComSpec || 'cmd.exe';
  const commandLine = ['call', quoteCmdArg(command.executable), ...args.map(quoteCmdArg)].join(' ');
  return spawn(comspec, ['/d', '/s', '/c', commandLine], hiddenSpawnOptions({
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: true,
  }));
}

function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return Promise.resolve();
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn(windowsTaskkillPath(), ['/pid', String(pid), '/t', '/f'], hiddenSpawnOptions({ cwd: os.tmpdir(), shell: false, stdio: 'ignore' }));
      killer.on('error', () => {
        child.kill();
        resolve();
      });
      killer.on('close', () => resolve());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    void err;
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  return (current + chunk).slice(0, MAX_CAPTURE_CHARS);
}

function sanitizeCommandOutput(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, MAX_CAPTURE_CHARS);
}

function prepareScipOutput(projectRoot: string, storageRoot: string, outputDir: string, outputFile: string): string | null {
  try {
    const root = realpathIfExists(projectRoot);
    const storage = realpathIfExists(storageRoot);
    const resolvedOutputDir = path.resolve(outputDir);
    const resolvedOutputFile = path.resolve(outputFile);
    if ((!isPathInside(resolvedOutputDir, root) && !isPathInside(resolvedOutputDir, storage)) || (!isPathInside(resolvedOutputFile, root) && !isPathInside(resolvedOutputFile, storage))) {
      return `Refusing to write SCIP output outside project root or data directory: ${resolvedOutputFile}`;
    }
    const symlinkAncestor = findSymlinkAncestor(resolvedOutputDir);
    if (symlinkAncestor) {
      return `Refusing to write SCIP output through symlinked directory: ${symlinkAncestor}`;
    }
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    const realOutputDir = fs.realpathSync(resolvedOutputDir);
    if (!isPathInside(realOutputDir, root) && !isPathInside(realOutputDir, storage)) {
      return `Refusing to write SCIP output outside project root or data directory: ${realOutputDir}`;
    }
    if (fs.existsSync(resolvedOutputFile) && fs.lstatSync(resolvedOutputFile).isSymbolicLink()) {
      return `Refusing to overwrite symlinked SCIP output file: ${resolvedOutputFile}`;
    }
    if (fs.existsSync(resolvedOutputFile)) {
      fs.unlinkSync(resolvedOutputFile);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function validateGeneratedScipIndex(indexFile: string): string | null {
  try {
    const index = readScipIndexFile(indexFile, {});
    const factCount = countScipFacts(index);
    return factCount === 0 ? `SCIP indexer wrote an empty index: ${indexFile}` : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `SCIP indexer wrote an unreadable index: ${sanitizeCommandOutput(message)}`;
  }
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/["%]/g, (match) => `^${match}`)}"`;
}

function realpathIfExists(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    void err;
    return resolved;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findSymlinkAncestor(target: string): string | null {
  let current = path.resolve(target);
  const existing: string[] = [];
  while (!fs.existsSync(current)) {
    existing.push(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  const chain = [current, ...existing.reverse()];
  for (const entry of chain) {
    if (fs.existsSync(entry) && fs.lstatSync(entry).isSymbolicLink()) return entry;
  }
  return null;
}

function emptyScipGenerationStatus(): ScipGenerationStatus {
  return { mode: 'off', updatedAt: 0, languages: {} };
}

function scipIndexSourceKey(indexFile: string, projectRoot: string): string {
  void projectRoot;
  return hashId('scip:source', [path.resolve(indexFile)]);
}

function bestScipNodeCandidate(
  candidates: Node[],
  definitionLine: number,
  symbol: ScipSymbolRecord
) {
  const available = candidates.filter((node) => !node.scipSymbol);
  if (available.length === 0) return undefined;
  return available.sort((left, right) => (
    scorePathAwareNodeForScipSymbol(right, definitionLine, symbol) - scorePathAwareNodeForScipSymbol(left, definitionLine, symbol)
  ))[0];
}

function groupNodesByNormalizedFilePath(nodes: readonly Node[]): Map<string, Node[]> {
  const grouped = new Map<string, Node[]>();
  for (const node of nodes) {
    const key = normalizeLinkFilePath(node.filePath);
    const group = grouped.get(key);
    if (group) {
      group.push(node);
    } else {
      grouped.set(key, [node]);
    }
  }
  return grouped;
}

function normalizeLinkFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function uniqueNodeForScipSymbol(candidates: readonly Node[], symbol: ScipSymbolRecord, usedNodeIds: ReadonlySet<string>) {
  const names = new Set(scipSymbolNames(symbol));
  const matching = candidates.filter((node) => names.has(node.name) && !usedNodeIds.has(node.id));
  const unique = new Map(matching.map((node) => [`${node.filePath}\0${node.name}`, node]));
  return unique.size === 1 ? Array.from(unique.values())[0] : undefined;
}

function scipSymbolNames(symbol: ScipSymbolRecord): string[] {
  return Array.from(new Set([symbol.displayName, terminalSymbolName(symbol.symbol)].filter((name): name is string => Boolean(name))));
}

function scorePathAwareNodeForScipSymbol(
  node: { startLine?: number; endLine?: number; filePath: string; name: string },
  definitionLine: number,
  symbol: ScipSymbolRecord
): number {
  const startLine = node.startLine ?? 0;
  const endLine = node.endLine ?? startLine;
  const lineScore = definitionLine >= startLine && definitionLine <= endLine ? 100 : Math.max(0, 20 - Math.abs(definitionLine - startLine));
  return lineScore + scoreNodeForScipSymbol(node, symbol);
}

function windowsTaskkillPath(): string {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(windowsRoot, 'System32', 'taskkill.exe');
}

function terminalSymbolName(symbol: string): string {
  const match = symbol.match(/([A-Za-z_$][\w$]*)\([^)]*\)\.$|([A-Za-z_$][\w$]*)[#.]$/);
  return match?.[1] ?? match?.[2] ?? symbol;
}

function scoreNodeForScipSymbol(node: { filePath: string; name: string }, symbol: ScipSymbolRecord): number {
  let score = symbol.displayName === node.name ? 10 : 0;
  if (symbol.symbol.includes(`${node.name}(`) || symbol.symbol.includes(`${node.name}.`) || symbol.symbol.includes(`${node.name}#`)) score += 5;
  if (symbol.symbol.toLowerCase().includes(path.basename(node.filePath, path.extname(node.filePath)).toLowerCase())) score += 2;
  return score;
}

function symbolKindName(kind: SymbolInformation_Kind): string | undefined {
  return SymbolInformation_Kind[kind] ?? undefined;
}

function positionEncodingName(encoding: PositionEncoding): string | undefined {
  return PositionEncoding[encoding] ?? undefined;
}

function hashId(prefix: string, parts: readonly string[]): string {
  return `${prefix}:${createHash('sha1').update(parts.join('\0')).digest('hex')}`;
}

function readScipIndexFile(indexFile: string, options: Pick<ImportScipIndexesOptions, 'maxBytes' | 'maxFacts'>): Index {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SCIP_INDEX_BYTES;
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_SCIP_FACTS;
  const size = fs.statSync(indexFile).size;
  if (size > maxBytes) {
    throw new Error(`SCIP index is larger than the configured limit (${size} bytes > ${maxBytes} bytes): ${indexFile}`);
  }
  const index = deserializeSCIP(fs.readFileSync(indexFile));
  const factCount = countScipFacts(index);
  if (factCount > maxFacts) {
    throw new Error(`SCIP index has more facts than the configured limit (${factCount} > ${maxFacts}): ${indexFile}`);
  }
  return index;
}

function countScipFacts(index: Index): number {
  return index.documents.reduce(
    (count, document) => count + document.symbols.length + document.occurrences.length + document.symbols.reduce((total, symbol) => total + symbol.relationships.length, 0),
    index.externalSymbols.length
  );
}

async function commandAvailable(command: ResolvedCommand, timeoutMs: number): Promise<ScipIndexerAvailability> {
  const result = await runCommand(command, ['--version'], os.tmpdir(), timeoutMs);
  if (result.timedOut) return { available: false, reason: `Indexer command did not respond: ${command.displayName}` };
  if (result.error) return { available: false, reason: `Indexer command could not start: ${sanitizeCommandOutput(result.error)}` };
  if (result.code !== 0) {
    const details = sanitizeCommandOutput(result.stderr.trim() || result.stdout.trim());
    return {
      available: false,
      reason: details ? `Indexer command probe failed with code ${result.code}: ${details}` : `Indexer command probe failed with code ${result.code}`,
    };
  }
  return { available: true };
}

export { SymbolRole };
