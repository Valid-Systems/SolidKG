import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(repoRoot, 'scripts', 'readiness', 'evidence-schema.mjs');
const cliPath = path.join(repoRoot, 'scripts', 'readiness', 'write-evidence.mjs');

type EvidenceModule = {
  SCHEMA_NAME: string;
  createEvidenceBundle(input: Record<string, unknown>, options?: Record<string, unknown>): {
    bundle: Record<string, unknown>;
    errors: string[];
  };
  validateEvidenceBundle(bundle: Record<string, unknown>): string[];
  parseClaudeStreamJsonl(text: string): {
    toolCounts: { total: number; read: number; grep: number; bash: number; solidkg: number; other: number };
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; totalAssistantUsage: number };
    durationMs: number;
    costUsd: number;
  };
};

async function loadEvidenceModule(): Promise<EvidenceModule> {
  return (await import(pathToFileURL(schemaPath).href)) as EvidenceModule;
}

function completeEvidenceInput(): Record<string, unknown> {
  return {
    generatedAt: '2026-06-04T00:00:00.000Z',
    prompt: 'How does SyntheticEntry reach SyntheticSink?',
    subject: {
      kind: 'agent-eval',
      solidkgVersion: '0.7.0-local',
      repo: {
        name: 'synthetic-private-fixture',
        identity: 'synthetic://task-6',
        privacy: 'private',
        revision: 'none',
      },
    },
    command: {
      commandLine: 'node scripts/agent-eval/probe-trace.mjs /tmp/repo SyntheticEntry SyntheticSink',
      cwd: repoRoot,
      argv: ['node', 'scripts/agent-eval/probe-trace.mjs', '/tmp/repo', 'SyntheticEntry', 'SyntheticSink'],
    },
    metrics: {
      durationMs: 1234,
      costUsd: 0,
      tokens: { input: 10, output: 5, cacheRead: 7, cacheCreation: 3 },
      toolCalls: { total: 3, read: 0, grep: 0, bash: 0, solidkg: 3, other: 0 },
    },
    graphAnswer: {
      path: {
        found: true,
        hopCount: 2,
        symbols: ['SyntheticEntry', 'SyntheticSink'],
        metadata: { provenance: 'synthetic' },
      },
      sourceCompleteness: {
        status: 'complete',
        returnedFiles: ['src/synthetic.ts'],
        truncatedFiles: [],
        omittedFiles: [],
        unreadableFiles: [],
        staleFiles: [],
      },
    },
    result: {
      status: 'pass',
      summary: 'Synthetic path evidence is complete.',
      failureTaxonomyTag: 'pass',
    },
    artifacts: { evidencePath: '.omo/evidence/task-6-sample-evidence.json' },
  };
}

describe('readiness evidence bundle schema', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('accepts complete metadata-only evidence and computes token totals from assistant usage fields', async () => {
    const mod = await loadEvidenceModule();
    const { bundle, errors } = mod.createEvidenceBundle(completeEvidenceInput());

    expect(errors).toEqual([]);
    expect(bundle).toMatchObject({
      schemaName: mod.SCHEMA_NAME,
      schemaVersion: 1,
      prompt: 'How does SyntheticEntry reach SyntheticSink?',
      subject: expect.objectContaining({
        solidkgVersion: '0.7.0-local',
        repo: expect.objectContaining({ name: 'synthetic-private-fixture', identity: 'synthetic://task-6' }),
      }),
      result: { status: 'pass', summary: 'Synthetic path evidence is complete.', failureTaxonomyTag: 'pass' },
      privacy: expect.objectContaining({ sourcePolicy: 'metadata_only', privateSourceExcluded: true }),
    });
    expect((bundle.metrics as { tokens: { totalAssistantUsage: number } }).tokens.totalAssistantUsage).toBe(25);
    expect((bundle.metrics as { toolCalls: { total: number; solidkg: number } }).toolCalls).toMatchObject({
      total: 3,
      solidkg: 3,
    });
  });

  it.each([
    ['repo identity', (input: Record<string, unknown>) => {
      ((input.subject as Record<string, unknown>).repo as Record<string, unknown>).identity = '';
    }, 'subject.repo.identity is required'],
    ['command', (input: Record<string, unknown>) => {
      (input.command as Record<string, unknown>).commandLine = '';
    }, 'command.commandLine is required'],
    ['result', (input: Record<string, unknown>) => {
      (input.result as Record<string, unknown>).status = 'unknown';
    }, 'result.status must be pass, fail, or blocked'],
  ])('rejects evidence missing %s', async (_label, mutate, expectedError) => {
    const mod = await loadEvidenceModule();
    const input = completeEvidenceInput();
    mutate(input);

    const { errors } = mod.createEvidenceBundle(input);

    expect(errors).toContain(expectedError);
  });

  it('sums per-assistant stream usage and tool-call counts instead of relying on final result usage only', async () => {
    const mod = await loadEvidenceModule();
    const parsed = mod.parseClaudeStreamJsonl([
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
          content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'mcp__solidkg__solidkg_trace' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 11, output_tokens: 13, cache_read_input_tokens: 17, cache_creation_input_tokens: 19 },
          content: [{ type: 'tool_use', name: 'Grep' }, { type: 'tool_use', name: 'Bash' }],
        },
      }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 999 }, duration_ms: 3210, total_cost_usd: 0.042 }),
    ].join('\n'));

    expect(parsed.tokens).toEqual({ input: 13, output: 16, cacheRead: 22, cacheCreation: 26, totalAssistantUsage: 77 });
    expect(parsed.toolCounts).toMatchObject({ total: 4, read: 1, grep: 1, bash: 1, solidkg: 1 });
    expect(parsed.durationMs).toBe(3210);
    expect(parsed.costUsd).toBe(0.042);
  });

  it('excludes raw private source and redacts the SECRET_DO_NOT_CAPTURE sentinel by default', async () => {
    const mod = await loadEvidenceModule();
    const input = {
      ...completeEvidenceInput(),
      rawSource: 'export const secret = "SECRET_DO_NOT_CAPTURE";',
      graphAnswer: {
        ...(completeEvidenceInput().graphAnswer as Record<string, unknown>),
        sourceSnippets: ['function privateThing() { return "SECRET_DO_NOT_CAPTURE"; }'],
      },
    };

    const { bundle, errors } = mod.createEvidenceBundle(input);
    const serialized = JSON.stringify(bundle, null, 2);

    expect(errors).toEqual([]);
    expect(serialized).not.toContain('SECRET_DO_NOT_CAPTURE');
    expect(serialized).not.toContain('privateThing');
    expect(serialized).toContain('metadata_only');
    expect(serialized).toContain('rawSourceKeysExcluded');
  });

  it('writes a sample artifact from the CLI without capturing private fixture source', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-evidence-'));
    const outPath = path.join(tempDir, 'task-6-sample-evidence.json');
    const stdout = execFileSync(process.execPath, [cliPath, '--sample', '--out', outPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const artifact = fs.readFileSync(outPath, 'utf8');

    expect(stdout).toContain('solidkg.readiness-evidence.v1');
    expect(artifact).toContain('synthetic-private-fixture');
    expect(artifact).toContain('metadata_only');
    expect(artifact).not.toContain('SECRET_DO_NOT_CAPTURE');
  });

  it('returns a failing exit code for schema-invalid CLI input', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-evidence-invalid-'));
    const inputPath = path.join(tempDir, 'invalid.json');
    const outPath = path.join(tempDir, 'invalid-out.json');
    const invalid = completeEvidenceInput();
    ((invalid.subject as Record<string, unknown>).repo as Record<string, unknown>).identity = '';
    fs.writeFileSync(inputPath, JSON.stringify(invalid, null, 2));

    const result = spawnSync(process.execPath, [cliPath, '--input', inputPath, '--out', outPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('subject.repo.identity is required');
    expect(fs.existsSync(outPath)).toBe(false);
  });
});

