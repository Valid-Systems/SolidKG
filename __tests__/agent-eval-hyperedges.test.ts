import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const promptsPath = path.join(repoRoot, 'scripts', 'agent-eval', 'hyperedge-prompts.json');
const helperPath = path.join(repoRoot, 'scripts', 'agent-eval', 'hyperedge-metadata.mjs');

const expectedIds = [
  'semantic-route-handling',
  'semantic-event-emission',
  'semantic-ui-render',
  'semantic-interface-implementation',
  'semantic-native-bridge',
  'semantic-handler-impact',
];

const expectedCategories = [
  'route handling',
  'event emission',
  'UI render',
  'interface implementation',
  'native bridge',
  'handler impact',
];

const requiredMetadataFields = [
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

function readPrompts() {
  return JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
}

function runHelper(...args: string[]) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('semantic hyperedge benchmark prompts', () => {
  it('contains exactly six deterministic semantic-relation prompt records', () => {
    const prompts = readPrompts();

    expect(prompts).toHaveLength(6);
    expect(prompts.map((prompt: { id: string }) => prompt.id)).toEqual(expectedIds);
    expect(prompts.map((prompt: { category: string }) => prompt.category)).toEqual(expectedCategories);
    expect(new Set(prompts.map((prompt: { category: string }) => prompt.category)).size).toBe(6);

    for (const prompt of prompts) {
      expect(Object.keys(prompt)).toEqual([
        'id',
        'category',
        'relationUnderTest',
        'prompt',
        'expectedEvidence',
        'repeatedRunNotice',
      ]);
      expect(prompt.relationUnderTest).toMatch(/\S/);
      expect(prompt.prompt).toMatch(/\?/);
      expect(prompt.expectedEvidence).toMatch(/The answer/);
    }
  });

  it('documents that publication conclusions require repeated runs', () => {
    const prompts = readPrompts();

    for (const prompt of prompts) {
      expect(prompt.repeatedRunNotice).toMatch(/single run/i);
      expect(prompt.repeatedRunNotice).toMatch(/repeated runs/i);
      expect(prompt.repeatedRunNotice).toMatch(/current MCP/i);
      expect(prompt.repeatedRunNotice).toMatch(/hyperedge-enabled/i);
    }

    const schema = JSON.parse(runHelper('--schema').stdout);
    expect(schema.repeatedRunNotice).toMatch(/repeated runs/i);
    expect(schema.repeatedRunNotice).toMatch(/before publication/i);
  });
});

describe('semantic hyperedge comparison metadata', () => {
  it('emits required metadata fields and separate current MCP and hyperedge arms', () => {
    const result = runHelper('--schema');

    expect(result.status, result.stderr).toBe(0);
    const schema = JSON.parse(result.stdout);
    expect(schema.schemaName).toBe('semantic-hyperedge-comparison-result');
    expect(schema.arms).toEqual(['current-mcp', 'hyperedge-enabled']);
    expect(schema.fields).toEqual(requiredMetadataFields);
    expect(Object.keys(schema.fieldTypes)).toEqual(requiredMetadataFields);
    expect(schema.fieldTypes.arm).toContain('current-mcp');
    expect(schema.fieldTypes.arm).toContain('hyperedge-enabled');
  });

  it('emits dry-run example rows with all comparison-result metadata fields', () => {
    const result = runHelper('--example');

    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { arm: string }) => row.arm)).toEqual(['current-mcp', 'hyperedge-enabled']);

    for (const row of rows) {
      expect(Object.keys(row)).toEqual(requiredMetadataFields);
      expect(expectedIds).toContain(row.promptId);
      expect(row.answerCorrectness).toBe('unscored');
      expect(row.toolCalls).toBe(0);
      expect(row.tokens).toBe(0);
      expect(row.durationMs).toBe(0);
      expect(row.irrelevantFilesRead).toBe(0);
      expect(row.identifiedRegistrationOrBridgeSite).toBe(false);
      expect(row.runId).toContain(row.arm);
    }
  });

  it('validates comparison metadata without running a full agent benchmark', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hyperedge-metadata-'));
    try {
      const resultFile = path.join(tempDir, 'results.json');
      const exampleRows = JSON.parse(runHelper('--example').stdout);
      fs.writeFileSync(resultFile, JSON.stringify(exampleRows, null, 2));

      const result = runHelper('--validate', resultFile);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, validatedRows: 2 });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
