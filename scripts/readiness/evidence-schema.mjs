#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_NAME = 'solidkg.readiness-evidence.v1';
export const FAILURE_TAXONOMY_TAGS = Object.freeze([
  'pass',
  'payload_budget_regression',
  'source_completeness_gap',
  'ambiguity',
  'unbridged_dynamic_dispatch',
  'partial_coverage',
  'read_grep_fallback',
  'install_package_failure',
  'unsupported_readme_claim',
  'attribution_gap',
  'maintainability_regression',
  'blocked_external_dependency',
  'schema_invalid',
]);

const RAW_SOURCE_KEYS = new Set([
  'rawSource',
  'source',
  'sourceText',
  'sourceSnippet',
  'sourceSnippets',
  'code',
  'content',
  'contents',
  'fileContents',
  'privateSource',
]);

const SECRET_PATTERNS = [
  /SECRET_DO_NOT_CAPTURE/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
  /\b(?:sk|pk|ghp|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  /(\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?token)\b\s*[:=]\s*)(["'`])([^"'`\r\n]{6,})(\2)/gi,
  /(\b[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|AUTH[_-]?TOKEN)[A-Z0-9_]*\b\s*=\s*)([^\s#;]{6,})/g,
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function redactString(value) {
  let redacted = value;
  redacted = redacted.replace(SECRET_PATTERNS[0], '[REDACTED_PRIVATE_SENTINEL]');
  redacted = redacted.replace(SECRET_PATTERNS[1], 'Bearer [REDACTED_SECRET]');
  redacted = redacted.replace(SECRET_PATTERNS[2], '[REDACTED_SECRET]');
  redacted = redacted.replace(SECRET_PATTERNS[3], (_match, prefix, quote) => `${prefix}${quote}[REDACTED_SECRET]${quote}`);
  redacted = redacted.replace(SECRET_PATTERNS[4], (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
  return redacted;
}

function sanitizeValue(value, options = {}, key = '') {
  const allowPublicSource = options.allowPublicSource === true;
  if (!allowPublicSource && RAW_SOURCE_KEYS.has(key)) {
    return '[EXCLUDED_PRIVATE_SOURCE]';
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, options));
  if (!isRecord(value)) return value;

  const result = {};
  for (const entryKey of Object.keys(value).sort()) {
    result[entryKey] = sanitizeValue(value[entryKey], options, entryKey);
  }
  return result;
}

function normalizeToolCounts(toolCounts = {}) {
  const normalized = {
    total: Number(toolCounts.total ?? 0),
    read: Number(toolCounts.read ?? 0),
    grep: Number(toolCounts.grep ?? 0),
    bash: Number(toolCounts.bash ?? 0),
    solidkg: Number(toolCounts.solidkg ?? 0),
    other: Number(toolCounts.other ?? 0),
  };
  if (!Number.isFinite(normalized.total) || normalized.total === 0) {
    normalized.total = normalized.read + normalized.grep + normalized.bash + normalized.solidkg + normalized.other;
  }
  return normalized;
}

function normalizeTokens(tokens = {}) {
  const normalized = {
    input: Number(tokens.input ?? 0),
    output: Number(tokens.output ?? 0),
    cacheRead: Number(tokens.cacheRead ?? 0),
    cacheCreation: Number(tokens.cacheCreation ?? 0),
    totalAssistantUsage: Number(tokens.totalAssistantUsage ?? 0),
  };
  if (!Number.isFinite(normalized.totalAssistantUsage) || normalized.totalAssistantUsage === 0) {
    normalized.totalAssistantUsage = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheCreation;
  }
  return normalized;
}

function sourceApprovedForSnippets(input) {
  return input?.privacy?.sourcePolicy === 'public_corpus_snippets_allowed'
    && input?.subject?.repo?.privacy === 'public-approved'
    && isNonEmptyString(input?.subject?.repo?.corpusManifest);
}

export function parseClaudeStreamJsonl(text) {
  const counts = { total: 0, read: 0, grep: 0, bash: 0, solidkg: 0, other: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, totalAssistantUsage: 0 };
  let durationMs = 0;
  let costUsd = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const usage = event.message?.usage;
      if (usage) {
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cacheRead += usage.cache_read_input_tokens || 0;
        tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
      }
      for (const block of event.message?.content || []) {
        if (block.type !== 'tool_use') continue;
        counts.total += 1;
        if (block.name === 'Read') counts.read += 1;
        else if (block.name === 'Grep' || block.name === 'Glob') counts.grep += 1;
        else if (block.name === 'Bash') counts.bash += 1;
        else if (String(block.name).includes('solidkg')) counts.solidkg += 1;
        else counts.other += 1;
      }
    }
    if (event.type === 'result') {
      durationMs = Number(event.duration_ms || durationMs || 0);
      costUsd = Number(event.total_cost_usd || costUsd || 0);
    }
  }
  tokens.totalAssistantUsage = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
  return { toolCounts: counts, tokens, durationMs, costUsd };
}

export function validateEvidenceBundle(bundle) {
  const errors = [];
  if (!isRecord(bundle)) return ['bundle must be an object'];
  if (bundle.schemaName !== SCHEMA_NAME) errors.push('schemaName must be solidkg.readiness-evidence.v1');
  if (bundle.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isNonEmptyString(bundle.generatedAt)) errors.push('generatedAt is required');
  if (!isNonEmptyString(bundle.prompt)) errors.push('prompt is required');
  if (!isRecord(bundle.subject)) errors.push('subject is required');
  if (!isNonEmptyString(bundle.subject?.solidkgVersion)) errors.push('subject.solidkgVersion is required');
  if (!isRecord(bundle.subject?.repo)) errors.push('subject.repo is required');
  if (!isNonEmptyString(bundle.subject?.repo?.name)) errors.push('subject.repo.name is required');
  if (!isNonEmptyString(bundle.subject?.repo?.identity)) errors.push('subject.repo.identity is required');
  if (!isRecord(bundle.command)) errors.push('command is required');
  if (!isNonEmptyString(bundle.command?.commandLine)) errors.push('command.commandLine is required');
  if (!isRecord(bundle.result)) errors.push('result is required');
  if (!['pass', 'fail', 'blocked'].includes(bundle.result?.status)) errors.push('result.status must be pass, fail, or blocked');
  if (!FAILURE_TAXONOMY_TAGS.includes(bundle.result?.failureTaxonomyTag)) errors.push('result.failureTaxonomyTag is not allowed');
  if (!isRecord(bundle.metrics?.toolCalls)) errors.push('metrics.toolCalls is required');
  if (!isRecord(bundle.graphAnswer?.sourceCompleteness)) errors.push('graphAnswer.sourceCompleteness is required');
  if (!isRecord(bundle.privacy)) errors.push('privacy is required');
  if (bundle.privacy?.privateSourceExcluded !== true) errors.push('privacy.privateSourceExcluded must be true');
  if (JSON.stringify(bundle).includes('SECRET_DO_NOT_CAPTURE')) errors.push('bundle contains private sentinel');
  return errors;
}

export function createEvidenceBundle(input, options = {}) {
  const allowPublicSource = options.allowPublicSource === true && sourceApprovedForSnippets(input);
  const sanitized = sanitizeValue(input, { allowPublicSource });
  const streamMetrics = sanitized.claudeStreamJsonlPath
    ? parseClaudeStreamJsonl(readFileSync(sanitized.claudeStreamJsonlPath, 'utf8'))
    : null;
  const metrics = sanitized.metrics || {};
  const graphAnswer = sanitized.graphAnswer || {};
  const result = sanitized.result || {};
  const sourceCompleteness = graphAnswer.sourceCompleteness || {};

  const bundle = {
    schemaName: SCHEMA_NAME,
    schemaVersion: 1,
    generatedAt: sanitized.generatedAt || new Date().toISOString(),
    prompt: sanitized.prompt,
    subject: {
      kind: sanitized.subject?.kind || 'readiness',
      solidkgVersion: sanitized.subject?.solidkgVersion,
      repo: {
        name: sanitized.subject?.repo?.name,
        identity: sanitized.subject?.repo?.identity,
        privacy: sanitized.subject?.repo?.privacy || 'private',
        corpusManifest: sanitized.subject?.repo?.corpusManifest || null,
        revision: sanitized.subject?.repo?.revision || null,
      },
    },
    command: {
      commandLine: sanitized.command?.commandLine,
      cwd: sanitized.command?.cwd || null,
      argv: Array.isArray(sanitized.command?.argv) ? sanitized.command.argv : [],
    },
    metrics: {
      durationMs: Number(metrics.durationMs ?? streamMetrics?.durationMs ?? 0),
      costUsd: Number(metrics.costUsd ?? streamMetrics?.costUsd ?? 0),
      tokens: normalizeTokens(metrics.tokens || streamMetrics?.tokens || {}),
      toolCalls: normalizeToolCounts(metrics.toolCalls || streamMetrics?.toolCounts || {}),
    },
    graphAnswer: {
      path: {
        found: Boolean(graphAnswer.path?.found),
        hopCount: Number(graphAnswer.path?.hopCount ?? 0),
        symbols: Array.isArray(graphAnswer.path?.symbols) ? graphAnswer.path.symbols : [],
        metadata: graphAnswer.path?.metadata || {},
      },
      sourceCompleteness: {
        status: sourceCompleteness.status || 'not_applicable',
        returnedFiles: Array.isArray(sourceCompleteness.returnedFiles) ? sourceCompleteness.returnedFiles : [],
        truncatedFiles: Array.isArray(sourceCompleteness.truncatedFiles) ? sourceCompleteness.truncatedFiles : [],
        omittedFiles: Array.isArray(sourceCompleteness.omittedFiles) ? sourceCompleteness.omittedFiles : [],
        unreadableFiles: Array.isArray(sourceCompleteness.unreadableFiles) ? sourceCompleteness.unreadableFiles : [],
        staleFiles: Array.isArray(sourceCompleteness.staleFiles) ? sourceCompleteness.staleFiles : [],
      },
    },
    result: {
      status: result.status,
      summary: result.summary || '',
      failureTaxonomyTag: result.failureTaxonomyTag || (result.status === 'pass' ? 'pass' : 'schema_invalid'),
    },
    privacy: {
      sourcePolicy: allowPublicSource ? 'public_corpus_snippets_allowed' : 'metadata_only',
      redaction: 'enabled',
      privateSourceExcluded: true,
      rawSourceKeysExcluded: !allowPublicSource,
    },
    artifacts: sanitized.artifacts || {},
  };

  const errors = validateEvidenceBundle(bundle);
  return { bundle, errors };
}

export function writeEvidenceBundle(input, outputPath, options = {}) {
  const { bundle, errors } = createEvidenceBundle(input, options);
  if (errors.length > 0) {
    const error = new Error(`Evidence bundle validation failed: ${errors.join('; ')}`);
    error.errors = errors;
    throw error;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}
