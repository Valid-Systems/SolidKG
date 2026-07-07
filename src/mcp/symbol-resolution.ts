import type SolidKG from '../index';
import type { Node } from '../types';

const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

export interface SymbolMatch {
  node: Node;
  note: string;
}

export interface SymbolSetMatch {
  nodes: Node[];
  note: string;
}

export interface SymbolLookupOptions {
  exactQualified?: boolean;
}

function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

export function normalizeLookupPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function stripRootLabel(value: string): string {
  return value.replace(/^@[^/]+\//, '');
}

function pathMatchesRootAwareExact(filePath: string, lookupPath: string): boolean {
  const normalizedFile = normalizeLookupPath(filePath);
  const normalizedLookup = normalizeLookupPath(lookupPath);
  return normalizedFile === normalizedLookup || stripRootLabel(normalizedFile) === normalizedLookup;
}

function splitFileQualifiedSymbol(symbol: string): { filePath: string; symbolName: string } | null {
  const separator = symbol.lastIndexOf('::');
  if (separator === -1) return null;
  const filePath = symbol.slice(0, separator);
  const symbolName = symbol.slice(separator + 2);
  if (!filePath || !symbolName) return null;
  const normalizedFilePath = normalizeLookupPath(filePath);
  if (!normalizedFilePath.includes('/') && !/\.[A-Za-z0-9]+$/.test(normalizedFilePath)) return null;
  return { filePath: normalizedFilePath, symbolName: lastQualifierPart(symbolName) };
}

function matchesSymbol(node: Node, symbol: string): boolean {
  if (node.name === symbol) return true;
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  const fileQualified = splitFileQualifiedSymbol(symbol);
  if (fileQualified) {
    return node.name === fileQualified.symbolName && pathMatchesRootAwareExact(node.filePath, fileQualified.filePath);
  }

  if (!/[./]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts.at(-1);
  if (!lastPart) return false;
  if (node.name !== lastPart) return false;

  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;

  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

function findExactScipSymbolNodes(cg: SolidKG, symbol: string): { matched: boolean; nodes: Node[]; note: string } {
  const matches = cg.findPreciseSymbols(symbol, 10).filter((match) => match.symbol.symbol === symbol);
  if (matches.length === 0) return { matched: false, nodes: [], note: '' };
  const seen = new Set<string>();
  const nodes: Node[] = [];
  for (const match of matches) {
    if (!match.node || seen.has(match.node.id)) continue;
    seen.add(match.node.id);
    nodes.push(match.node);
  }
  const note = nodes.length === 0
    ? `\n\n> **Note:** SCIP symbol "${symbol}" exists but is not linked to a graph node.`
    : '';
  return { matched: true, nodes, note };
}

function looksLikeScipSymbol(symbol: string): boolean {
  return /^\S+\s+\S+\s+\S+\s+\S/.test(symbol) && /[#.:]/.test(symbol);
}

export function findSymbol(cg: SolidKG, symbol: string): SymbolMatch | null {
  const isQualified = /[./]|::/.test(symbol);
  const limit = isQualified ? 50 : 10;
  let results = cg.searchNodes(symbol, { limit });

  if (isQualified && results.length === 0) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
  }

  if (results.length === 0 || !results[0]) {
    return null;
  }

  const exactMatches = results.filter(r => matchesSymbol(r.node, symbol));

  if (exactMatches.length > 1 && symbol.includes('/') && !symbol.startsWith('@')) {
    return null;
  }

  if (exactMatches.length === 1) {
    const match = exactMatches[0];
    if (!match) return null;
    return { node: match.node, note: '' };
  }

  if (exactMatches.length > 1) {
    const match = exactMatches[0];
    if (!match) return null;
    const picked = match.node;
    const others = exactMatches.slice(1).map(r =>
      `${r.node.name} (${r.node.kind}) at ${r.node.filePath}:${r.node.startLine}`
    );
    const note = `\n\n> **Note:** ${exactMatches.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`. Others: ${others.join(', ')}`;
    return { node: picked, note };
  }

  if (isQualified) return null;
  const fallback = results[0];
  if (!fallback) return null;
  return { node: fallback.node, note: '' };
}

export function findAllSymbols(cg: SolidKG, symbol: string, options: SymbolLookupOptions = {}): SymbolSetMatch {
  const precise = findExactScipSymbolNodes(cg, symbol);
  if (precise.matched) return { nodes: precise.nodes, note: precise.note };
  if (looksLikeScipSymbol(symbol)) return { nodes: [], note: '' };

  const isQualified = /[./]|::/.test(symbol);
  let results = cg.searchNodes(symbol, { limit: 50 });

  if (results.length === 0 && isQualified) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }

  if (results.length === 0) {
    return { nodes: [], note: '' };
  }

  const exactMatches = results.filter(r => matchesSymbol(r.node, symbol));

  if (exactMatches.length === 0 && isQualified && options.exactQualified) {
    return { nodes: [], note: '' };
  }

  if (exactMatches.length <= 1) {
    const fallback = results[0];
    if (!fallback) return { nodes: [], note: '' };
    const node = exactMatches[0]?.node ?? fallback.node;
    return { nodes: [node], note: '' };
  }

  const locations = exactMatches.map(r =>
    `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
  );
  const note = `\n\n> **Note:** Aggregated results across ${exactMatches.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: exactMatches.map(r => r.node), note };
}
