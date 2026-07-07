import type { Language, Node } from '../types';
import { capabilityAssertionId } from './ids';
import type { CapabilityAnalysisInput, CapabilityAnalysisResult, CapabilityAnalysisRun, CapabilityAnalysisStatus, CapabilityAssertion } from './types';

export const CONFIG_READ_PRODUCER_ID = 'solidkg.config-read';
export const CONFIG_READ_PRODUCER_VERSION = '1';

interface ConfigReadRule {
  readonly ruleId: string;
  readonly languages: readonly Language[];
  readonly regex: RegExp;
  readonly keyGroup: number;
}

interface LineIndexEntry {
  readonly startOffset: number;
  readonly line: number;
}

const STRING_DELIMITERS = new Set(["'", '"', '`']);

const CONFIG_READ_RULES: readonly ConfigReadRule[] = [
  { ruleId: 'typescript.process-env', languages: ['typescript', 'tsx', 'javascript', 'jsx'], regex: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, keyGroup: 1 },
  { ruleId: 'typescript.process-env-index', languages: ['typescript', 'tsx', 'javascript', 'jsx'], regex: /\bprocess\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g, keyGroup: 1 },
  { ruleId: 'typescript.import-meta-env', languages: ['typescript', 'tsx', 'javascript', 'jsx', 'astro', 'vue', 'svelte'], regex: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, keyGroup: 1 },
  { ruleId: 'deno.env-get', languages: ['typescript', 'tsx', 'javascript', 'jsx'], regex: /\bDeno\.env\.get\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
  { ruleId: 'python.getenv', languages: ['python'], regex: /\b(?:os\.)?getenv\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g, keyGroup: 1 },
  { ruleId: 'python.environ', languages: ['python'], regex: /\bos\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g, keyGroup: 1 },
  { ruleId: 'go.os-getenv', languages: ['go'], regex: /\bos\.Getenv\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
  { ruleId: 'rust.env-var', languages: ['rust'], regex: /\b(?:std::)?env::var\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
  { ruleId: 'jvm.system-getenv', languages: ['java', 'kotlin', 'scala'], regex: /\bSystem\.getenv\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
  { ruleId: 'ruby.env-index', languages: ['ruby'], regex: /\bENV\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g, keyGroup: 1 },
  { ruleId: 'php.getenv', languages: ['php'], regex: /\bgetenv\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
  { ruleId: 'csharp.environment-get-variable', languages: ['csharp'], regex: /\bEnvironment\.GetEnvironmentVariable\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g, keyGroup: 1 },
] as const;

export function configReadProducerSupports(language: Language): boolean {
  return CONFIG_READ_RULES.some((rule) => rule.languages.includes(language));
}

export function analyzeConfigReadCapabilities(input: CapabilityAnalysisInput): CapabilityAnalysisResult {
  if (!configReadProducerSupports(input.language)) {
    return { assertions: [], run: createRun(input.filePath, input.sourceHash, 'unsupported') };
  }

  const lineIndex = buildLineIndex(input.content);
  const ignoredOffsets = buildIgnoredOffsets(input.content);
  const nodes = sortContainmentCandidates(input.nodes);
  const assertions: CapabilityAssertion[] = [];

  for (const rule of CONFIG_READ_RULES) {
    if (!rule.languages.includes(input.language)) continue;
    rule.regex.lastIndex = 0;
    for (const match of input.content.matchAll(rule.regex)) {
      const resourceKey = match[rule.keyGroup];
      if (!resourceKey || match.index === undefined) continue;
      if (ignoredOffsets[match.index]) continue;
      const start = offsetToLineColumn(lineIndex, match.index);
      const end = offsetToLineColumn(lineIndex, match.index + match[0].length);
      const subject = containingNode(nodes, start.line);
      if (!subject) continue;
      assertions.push(createConfigReadAssertion({ subject, filePath: input.filePath, resourceKey, startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column, ruleId: rule.ruleId }));
    }
  }

  return { assertions, run: createRun(input.filePath, input.sourceHash, 'complete') };
}

function sortContainmentCandidates(nodes: readonly Node[]): readonly Node[] {
  return [...nodes].sort((left, right) => {
    const leftWidth = left.endLine - left.startLine;
    const rightWidth = right.endLine - right.startLine;
    return leftWidth - rightWidth || left.startLine - right.startLine || left.id.localeCompare(right.id);
  });
}

function createRun(filePath: string, sourceHash: string, status: CapabilityAnalysisStatus): CapabilityAnalysisRun {
  return { filePath, producerId: CONFIG_READ_PRODUCER_ID, producerVersion: CONFIG_READ_PRODUCER_VERSION, sourceHash, status, updatedAt: Date.now() };
}

function createConfigReadAssertion(input: {
  readonly subject: Node;
  readonly filePath: string;
  readonly resourceKey: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly ruleId: string;
}): CapabilityAssertion {
  const base = {
    subjectNodeId: input.subject.id,
    operation: 'read',
    resourceKind: 'config',
    resourceKey: input.resourceKey,
    scope: 'node_scoped',
    filePath: input.filePath,
    startLine: input.startLine,
    startColumn: input.startColumn,
    endLine: input.endLine,
    endColumn: input.endColumn,
    origin: 'ast',
    certainty: 'static',
    producerId: CONFIG_READ_PRODUCER_ID,
    ruleId: input.ruleId,
    producerVersion: CONFIG_READ_PRODUCER_VERSION,
    metadata: { language: input.subject.language },
  } satisfies Omit<CapabilityAssertion, 'id'>;
  return { id: capabilityAssertionId(base), ...base };
}

function buildLineIndex(content: string): readonly LineIndexEntry[] {
  const lines: LineIndexEntry[] = [{ startOffset: 0, line: 1 }];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') lines.push({ startOffset: index + 1, line: lines.length + 1 });
  }
  return lines;
}

function buildIgnoredOffsets(content: string): readonly boolean[] {
  const ignored: boolean[] = Array.from({ length: content.length }, () => false);
  let state: 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template' = 'code';
  for (let index = 0; index < content.length; index++) {
    const char = content[index] ?? '';
    const next = content[index + 1] ?? '';
    switch (state) {
      case 'code':
        if (char === '/' && next === '/') {
          ignored[index] = true;
          ignored[index + 1] = true;
          state = 'line_comment';
          index++;
        } else if (char === '/' && next === '*') {
          ignored[index] = true;
          ignored[index + 1] = true;
          state = 'block_comment';
          index++;
        } else if (char === '#') {
          ignored[index] = true;
          state = 'line_comment';
        } else if (STRING_DELIMITERS.has(char)) {
          ignored[index] = true;
          state = char === "'" ? 'single_quote' : char === '"' ? 'double_quote' : 'template';
        }
        break;
      case 'line_comment':
        ignored[index] = true;
        if (char === '\n') state = 'code';
        break;
      case 'block_comment':
        ignored[index] = true;
        if (char === '*' && next === '/') {
          ignored[index + 1] = true;
          state = 'code';
          index++;
        }
        break;
      case 'single_quote':
      case 'double_quote':
      case 'template':
        ignored[index] = true;
        if (char === '\\') {
          ignored[index + 1] = true;
          index++;
        } else if (stringDelimiterCloses(state, char)) {
          state = 'code';
        }
        break;
    }
  }
  return ignored;
}

function stringDelimiterCloses(state: 'single_quote' | 'double_quote' | 'template', char: string): boolean {
  return (state === 'single_quote' && char === "'") || (state === 'double_quote' && char === '"') || (state === 'template' && char === '`');
}

function offsetToLineColumn(index: readonly LineIndexEntry[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = index.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = index[mid];
    if (!entry) break;
    if (entry.startOffset <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const entry = index[Math.max(0, high)] ?? { startOffset: 0, line: 1 };
  return { line: entry.line, column: offset - entry.startOffset };
}

function containingNode(nodes: readonly Node[], line: number): Node | null {
  return nodes.find((node) => node.kind !== 'file' && node.startLine <= line && node.endLine >= line) ?? nodes.find((node) => node.kind === 'file') ?? null;
}
