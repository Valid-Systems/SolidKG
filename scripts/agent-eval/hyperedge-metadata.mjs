#!/usr/bin/env node
// Dry-run schema helper for semantic-hyperedge benchmark comparisons.
// It emits and validates metadata shape only; it does not launch agents or claim results.
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const COMPARISON_ARMS = ['current-mcp', 'hyperedge-enabled'];

export const REQUIRED_METADATA_FIELDS = [
  'arm',
  'promptId',
  'toolCalls',
  'tokens',
  'durationMs',
  'answerCorrectness',
  'irrelevantFilesRead',
  'identifiedRegistrationOrBridgeSite',
  'runId',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsPath = join(__dirname, 'hyperedge-prompts.json');

function readPrompts() {
  return JSON.parse(readFileSync(promptsPath, 'utf8'));
}

function metadataSchema() {
  return {
    schemaName: 'semantic-hyperedge-comparison-result',
    repeatedRunNotice: 'Benchmark conclusions require repeated runs for each prompt and arm before publication; this helper only emits or validates dry-run metadata shape.',
    arms: COMPARISON_ARMS,
    fields: REQUIRED_METADATA_FIELDS,
    fieldTypes: {
      arm: 'enum: current-mcp | hyperedge-enabled',
      promptId: 'string: id from hyperedge-prompts.json',
      toolCalls: 'number: total tool calls for one run',
      tokens: 'number: total tokens for one run',
      durationMs: 'number: wall-clock duration in milliseconds',
      answerCorrectness: 'string: unscored | incorrect | partial | correct',
      irrelevantFilesRead: 'number: count of files read that were not needed for the answer',
      identifiedRegistrationOrBridgeSite: 'boolean: whether the answer identified the relation registration or bridge site',
      runId: 'string: stable run identifier unique within a prompt and arm',
    },
  };
}

function exampleRows() {
  const firstPrompt = readPrompts()[0];
  return COMPARISON_ARMS.map((arm) => ({
    arm,
    promptId: firstPrompt.id,
    toolCalls: 0,
    tokens: 0,
    durationMs: 0,
    answerCorrectness: 'unscored',
    irrelevantFilesRead: 0,
    identifiedRegistrationOrBridgeSite: false,
    runId: `${firstPrompt.id}-${arm}-r1`,
  }));
}

function validateRows(rows) {
  const promptIds = new Set(readPrompts().map((prompt) => prompt.id));
  const errors = [];

  if (!Array.isArray(rows)) {
    return ['comparison results must be a JSON array'];
  }

  rows.forEach((row, index) => {
    for (const field of REQUIRED_METADATA_FIELDS) {
      if (!(field in row)) errors.push(`row ${index} missing ${field}`);
    }
    if (!COMPARISON_ARMS.includes(row.arm)) errors.push(`row ${index} has unsupported arm ${JSON.stringify(row.arm)}`);
    if (!promptIds.has(row.promptId)) errors.push(`row ${index} has unknown promptId ${JSON.stringify(row.promptId)}`);
    for (const field of ['toolCalls', 'tokens', 'durationMs', 'irrelevantFilesRead']) {
      if (typeof row[field] !== 'number' || row[field] < 0) errors.push(`row ${index} ${field} must be a non-negative number`);
    }
    if (typeof row.identifiedRegistrationOrBridgeSite !== 'boolean') errors.push(`row ${index} identifiedRegistrationOrBridgeSite must be boolean`);
    if (typeof row.answerCorrectness !== 'string' || row.answerCorrectness.length === 0) errors.push(`row ${index} answerCorrectness must be a non-empty string`);
    if (typeof row.runId !== 'string' || row.runId.length === 0) errors.push(`row ${index} runId must be a non-empty string`);
  });

  return errors;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const [, , command, file] = process.argv;

if (!command || command === '--schema') {
  printJson(metadataSchema());
} else if (command === '--example') {
  printJson(exampleRows());
} else if (command === '--validate') {
  if (!file || !existsSync(file)) {
    console.error('usage: node scripts/agent-eval/hyperedge-metadata.mjs --validate <results.json>');
    process.exit(2);
  }
  const errors = validateRows(JSON.parse(readFileSync(file, 'utf8')));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  printJson({ ok: true, validatedRows: JSON.parse(readFileSync(file, 'utf8')).length });
} else {
  console.error('usage: node scripts/agent-eval/hyperedge-metadata.mjs [--schema|--example|--validate <results.json>]');
  process.exit(2);
}
