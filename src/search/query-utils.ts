/**
 * Search Query Utilities
 *
 * Shared module for search term extraction and scoring.
 */

import * as path from "path";
import { Node } from "../types";
import { isGeneratedFile, isGeneratedFileQuery } from "./path-classifiers";

/**
 * Common stop words to filter from search queries.
 * Includes generic English + code-specific noise words.
 */
export const STOP_WORDS = new Set([
  // English
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "that",
  "this",
  "are",
  "was",
  "be",
  "has",
  "had",
  "have",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "not",
  "no",
  "all",
  "each",
  "every",
  "how",
  "what",
  "where",
  "when",
  "who",
  "which",
  "why",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "show",
  "give",
  "tell",
  "been",
  "done",
  "made",
  "used",
  "using",
  "work",
  "works",
  "found",
  "also",
  "into",
  "then",
  "than",
  "just",
  "more",
  "some",
  "such",
  "over",
  "only",
  "out",
  "its",
  "so",
  "up",
  "as",
  "if",
  "look",
  "need",
  "needs",
  "want",
  "happen",
  "happens",
  "affect",
  "affected",
  "break",
  "breaks",
  "failing",
  "implemented",
  "implement",
  // Code-specific noise (avoid filtering common symbol names like get/set/add/build/find/list)
  "code",
  "file",
  "files",
  "function",
  "method",
  "class",
  "type",
  "fix",
  "bug",
  "called",
  "path",
  "paths",
  "solidkg",
  "source",
  "sources",
  "snippet",
  "snippets",
]);

/**
 * Generate stem variants of a search term by removing common English suffixes.
 * Used for FTS query expansion so "caching" also finds "cache", "eviction" finds "evict", etc.
 * Stems are used as PREFIX matches in FTS, so they don't need to be perfect English words.
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  // -ing: caching→cach/cache, handling→handl/handle, running→run
  if (t.endsWith("ing") && t.length > 5) {
    const base = t.slice(0, -3);
    variants.add(base);
    variants.add(base + "e");
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  // -tion/-sion: eviction→evict, expression→express
  if ((t.endsWith("tion") || t.endsWith("sion")) && t.length > 5) {
    variants.add(t.slice(0, -3));
  }

  // -ment: management→manage
  if (t.endsWith("ment") && t.length > 6) {
    variants.add(t.slice(0, -4));
  }

  // -ies: entries→entry
  if (t.endsWith("ies") && t.length > 4) {
    variants.add(t.slice(0, -3) + "y");
  }
  // -es: processes→process, classes→class
  else if (t.endsWith("es") && t.length > 4) {
    variants.add(t.slice(0, -2));
  }
  // -s: errors→error (skip -ss endings like "class")
  else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 4) {
    variants.add(t.slice(0, -1));
  }

  // -ed: handled→handle, propagated→propagate, carried→carry
  if (t.endsWith("ed") && !t.endsWith("eed") && t.length > 4) {
    variants.add(t.slice(0, -1));
    variants.add(t.slice(0, -2));
    if (t.endsWith("ied") && t.length > 5) {
      variants.add(t.slice(0, -3) + "y");
    }
  }

  // -er: builder→build/builde, handler→handl/handle, getter→get
  if (t.endsWith("er") && t.length > 4) {
    const base = t.slice(0, -2);
    variants.add(base);
    variants.add(base + "e");
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  return [...variants].filter((v) => v.length >= 3 && v !== t);
}

const CODE_TOKEN_PATTERN =
  /@?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|[._\/-])[A-Za-z0-9_$]+)*/g;
const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const RETRIEVAL_INTENT_TERMS = new Set([
  "exclude",
  "excluding",
  "implementation",
  "production",
  "rather",
  "without",
]);
const EXCLUSION_NOISE_TERMS = new Set(["api", "command"]);
const NON_PRODUCTION_TERMS = new Set([
  "benchmark",
  "benchmarks",
  "demo",
  "demos",
  "example",
  "examples",
  "fixture",
  "fixtures",
  "generated",
  "sample",
  "samples",
  "spec",
  "specs",
  "test",
  "tests",
]);
const EXPLICIT_EXCLUSION_CLAUSE_PATTERN =
  /\b(?:excluding|exclude|rather\s+than)\b([^,.;?]*?)(?=\bbut\b|[,.;?]|$)/gi;
const WITHOUT_SOURCE_EXCLUSION_PATTERN =
  /\bwithout\b([^,.;?]*\b(?:tests?|specs?|fixtures?|generated|metadata|models?|examples?|samples?|benchmarks?|demos?|snapshots?)\b[^,.;?]*?)(?=\bbut\b|[,.;?]|$)/gi;
const SOURCE_NOUN_EXCLUSION_PATTERN =
  /\bnot\s+(?!only\b)((?:the\s+)?(?:api\s+)?(?:generated\s+)?(?:models?|metadata|tests?|specs?|examples?|samples?|fixtures?|benchmarks?|demos?)(?:\s+or\s+(?:its\s+)?(?:models?|metadata|tests?|specs?|examples?|samples?|fixtures?|benchmarks?|demos?))*)/gi;

function addToken(tokens: Set<string>, token: string): void {
  const trimmed = token.trim();
  if (trimmed.length >= 2) tokens.add(trimmed);
}

function addSplitParts(tokens: Set<string>, token: string): void {
  const withoutDecorator = token.startsWith("@") ? token.slice(1) : token;
  addToken(tokens, withoutDecorator);
  addToken(tokens, withoutDecorator.toLowerCase());

  for (const qualifiedPart of withoutDecorator.split(/::|[./]+/)) {
    addToken(tokens, qualifiedPart);
    addToken(tokens, qualifiedPart.toLowerCase());

    for (const segment of qualifiedPart.split(/[_-]+/)) {
      if (segment.length === 0) continue;
      addToken(tokens, segment);
      addToken(tokens, segment.toLowerCase());

      const spaced = segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
      for (const part of spaced.split(/[^A-Za-z0-9]+/)) {
        addToken(tokens, part.toLowerCase());
      }
    }
  }
}

export function tokenizeCodeForSearch(source: string): string[] {
  const tokens = new Set<string>();
  const normalized = source.replace(/\\/g, "/");
  for (const match of normalized.matchAll(CODE_TOKEN_PATTERN)) {
    const token = match[0];
    addToken(tokens, token);
    addSplitParts(tokens, token);
  }
  return [...tokens];
}

export function buildSourceChunkCodeTokenText(source: string): string {
  return tokenizeCodeForSearch(source).join(" ");
}

export function buildSourceChunkFtsQuery(query: string): string {
  return selectRetrievalSearchTerms(query)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" OR ");
}

function extractExclusionClauseTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const pattern of [
    EXPLICIT_EXCLUSION_CLAUSE_PATTERN,
    WITHOUT_SOURCE_EXCLUSION_PATTERN,
    SOURCE_NOUN_EXCLUSION_PATTERN,
  ]) {
    for (const match of query.matchAll(pattern)) {
      for (const token of tokenizeCodeForSearch(match[1] ?? "")) {
        const lower = token.toLowerCase();
        if (
          lower.length < 3 ||
          STOP_WORDS.has(lower) ||
          RETRIEVAL_INTENT_TERMS.has(lower)
        )
          continue;
        terms.add(lower);
      }
    }
  }
  return [...terms];
}

export function extractExcludedRetrievalTerms(query: string): string[] {
  return extractExclusionClauseTerms(query).filter(
    (term) => !EXCLUSION_NOISE_TERMS.has(term),
  );
}

export function isNonProductionQuery(query: string): boolean {
  const positiveTerms = new Set(selectRetrievalSearchTerms(query, 100));
  return [...NON_PRODUCTION_TERMS].some((term) => positiveTerms.has(term));
}

export function hasProductionRetrievalIntent(query: string): boolean {
  if (/\bproduction\b/i.test(query)) return true;
  return (
    !isNonProductionQuery(query) &&
    extractExcludedRetrievalTerms(query).some((term) =>
      NON_PRODUCTION_TERMS.has(term),
    )
  );
}

export function selectRetrievalSearchTerms(
  query: string,
  maxTerms = 6,
): string[] {
  const excluded = new Set(extractExclusionClauseTerms(query));
  const imperativeFind =
    /^\s*find\b/i.test(query) &&
    extractSearchTerms(query, { stems: false }).length > 1;
  return extractSearchTerms(query, { stems: false })
    .filter((term) => !FTS_OPERATORS.has(term.toUpperCase()))
    .filter((term) => !RETRIEVAL_INTENT_TERMS.has(term) && !excluded.has(term))
    .filter((term) => term !== "find" || !imperativeFind)
    .slice(0, maxTerms);
}

/**
 * Extract meaningful search terms from a natural language query.
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dot.notation
 * into individual tokens before filtering.
 *
 * Preserves original compound identifiers (e.g., "scrapeLoop") alongside
 * their split parts so that FTS can match both the full symbol name and
 * individual words within it.
 *
 * Also generates stem variants (e.g., "caching"→"cache", "eviction"→"evict")
 * so FTS prefix matching can find related code symbols.
 */
export function extractSearchTerms(
  query: string,
  options?: { stems?: boolean },
): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();

  for (const token of tokenizeCodeForSearch(query)) {
    const lower = token.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // Generate stem variants for broader FTS matching.
  // "caching" → "cache" finds CacheBuilder; "eviction" → "evict" finds evictEntries.
  // Also enables co-occurrence dampening by increasing term count above 1.
  // Stems are skipped when scoring path relevance (stems inflate path scores).
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) {
          stems.add(variant);
        }
      }
    }
    for (const stem of stems) {
      tokens.add(stem);
    }
  }

  return [...tokens];
}

/**
 * Score path relevance to a query
 * Higher score = more relevant path
 */
export function scorePathRelevance(filePath: string, query: string): number {
  // Use base terms only — stem variants inflate path scores by generating
  // many near-duplicate terms that all match the same path segments.
  const terms = extractSearchTerms(query, { stems: false });
  if (terms.length === 0) return 0;

  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  for (const term of terms) {
    // Exact filename match (strongest)
    if (fileName.includes(term)) score += 10;
    // Directory match
    if (dirName.includes(term)) score += 5;
    // General path match
    else if (pathLower.includes(term)) score += 3;
  }

  // Deprioritize test files unless the query is explicitly about tests
  const excludedTerms = extractExcludedRetrievalTerms(query);
  const excluded = new Set(excludedTerms);
  const productionIntent = hasProductionRetrievalIntent(query);
  const isTestQuery = isNonProductionQuery(query);
  if (!isTestQuery && isTestFile(filePath)) {
    score -= 15;
  }

  const generatedIntent =
    !excluded.has("generated") && isGeneratedFileQuery(query);
  if (!generatedIntent && isGeneratedFile(filePath)) {
    score -= 20;
  }

  for (const term of excludedTerms) {
    if (fileName.includes(term)) score -= 12;
    else if (pathLower.includes(term)) score -= 6;
  }

  if (productionIntent && !isTestFile(filePath) && !isGeneratedFile(filePath))
    score += 8;

  return score;
}

/**
 * Check if a file path looks like a test file
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath); // original case — needed for camelCase boundaries
  const lowerName = fileName.toLowerCase();

  // --- Filename patterns ---
  if (
    lowerName.startsWith("test_") || // python: test_foo.py
    lowerName.startsWith("test.") ||
    // separator-delimited: foo_test.go, foo.test.ts, foo-spec.rb, bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase suffix (Java/Kotlin/Swift/C#/Scala): FooTest.kt, BarTests.swift,
    // BazSpec.scala, QuxTestCase.java. Capital-led so "latest.kt"/"manifest.kt"
    // (lowercase "test") are NOT matched.
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- Directory patterns ---
  if (
    lower.includes("/tests/") ||
    lower.includes("/test/") ||
    lower.includes("/__tests__/") ||
    lower.includes("/spec/") ||
    lower.includes("/specs/") ||
    lower.includes("/testlib/") ||
    lower.includes("/testing/") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.startsWith("spec/") ||
    lower.startsWith("specs/") ||
    // CamelCase test source-set dirs (Kotlin Multiplatform / Gradle / Xcode):
    // jvmTest/, commonTest/, androidTest/, iosTest/, integrationTest/. Capital-led
    // so "latest/" / "manifest/" are not matched.
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  ) {
    return true;
  }

  // Non-production directories: examples, samples, benchmarks, fixtures, demos.
  // Check both mid-path (/integration/) and start-of-path (integration/) since
  // file paths may be stored as relative paths without a leading slash.
  return matchesNonProductionDir(lower);
}

/**
 * Check if a path is in a non-production directory (integration, sample, example, etc.)
 * Handles both absolute paths (/foo/integration/bar) and relative paths (integration/bar).
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    "integration",
    "sample",
    "samples",
    "example",
    "examples",
    "fixture",
    "fixtures",
    "benchmark",
    "benchmarks",
    "demo",
    "demos",
  ];
  for (const dir of dirs) {
    if (
      lowerPath.includes("/" + dir + "/") ||
      lowerPath.startsWith(dir + "/")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replace(/[\s]+/g, "").toLowerCase();

  // Exact match: query exactly equals the node name
  if (nameLower === queryLower) return 80;

  // Exact match on a query token: "CacheBuilder build" and node name is "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(10 + 30 * ratio);
  }

  // All camelCase-split terms appear in the name
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every((t) => nameLower.includes(t));
    if (allMatch) return 15;
  }

  // Name contains the full query as substring
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

/**
 * Kind-based bonus for search ranking
 * Functions and classes are typically more relevant than variables/imports
 */
export function kindBonus(kind: Node["kind"]): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
  };
  return bonuses[kind] ?? 0;
}
