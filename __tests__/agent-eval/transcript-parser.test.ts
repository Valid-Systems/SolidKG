import { spawnSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const parserPath = path.join(repoRoot, 'scripts', 'agent-eval', 'parse-opencode-transcript.mjs');
const fixtureDir = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality', 'transcripts');

function parseFixture(name: string) {
  const result = spawnSync(process.execPath, [parserPath, '--from', path.join(fixtureDir, name)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    status: string;
    reason?: string;
    finalAnswer: { text: string };
    toolCalls: Array<{ tool: string }>;
    readCount: number;
    grepCount: number;
    bashCount: number;
    solidkgToolCalls: number;
    peerWrapperCalls: number;
    fallbackLoopCount: number;
    durationMs: number;
    costUsd?: number;
  };
}

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

describe('OpenCode transcript parser', () => {
  it('extracts probe final answer and at least one tool call', () => {
    const parsed = parseFixture('capability-probe.jsonl');

    expect(parsed.status).toBe('pass');
    expect(parsed.finalAnswer.text).toBe('Probe final answer.');
    expect(parsed.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(parsed.readCount).toBe(1);
    expect(parsed.durationMs).toBe(1200);
    expect(parsed.costUsd).toBe(0.001);
  });

  it('extracts tool counts and final answer for a successful SolidKG transcript', () => {
    const parsed = parseFixture('success-solidkg.jsonl');

    expect(parsed.status).toBe('pass');
    expect(parsed.finalAnswer.text).toContain('route reaches the handler');
    expect(parsed.solidkgToolCalls).toBeGreaterThan(0);
    expect(parsed.readCount).toBe(1);
    expect(parsed.grepCount).toBe(2);
    expect(parsed.bashCount).toBe(1);
    expect(parsed.fallbackLoopCount).toBe(3);
    expect(parsed.peerWrapperCalls).toBe(0);
    expect(parsed.durationMs).toBe(3456);
    expect(parsed.costUsd).toBe(0.042);
  });

  it('classifies malformed known-format transcripts without throwing', () => {
    const parsed = parseFixture('malformed-known.jsonl');

    expect(parsed.status).toBe('parse_failed');
    expect(parsed.reason).toBe('malformed_jsonl_transcript');
    expect(parsed.finalAnswer.text).toBe('partial answer');
    expect(parsed.readCount).toBe(1);
  });

  it('maps unsupported transcript format to runner_failed instead of partial quality', () => {
    const parsed = parseFixture('unsupported.txt');

    expect(parsed.status).toBe('runner_failed');
    expect(parsed.reason).toBe('unsupported_transcript_format');
    expect(parsed.finalAnswer.text).toBe('');
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.solidkgToolCalls).toBe(0);
  });

  it('counts rg launched through bash as grep fallback', async () => {
    const parser = await import(pathToFileUrl(parserPath));
    const parsed = parser.parseOpenCodeTranscriptText([
      JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'rg "needle" src' } }),
      JSON.stringify({ type: 'final', content: 'Found the answer.' }),
    ].join('\n'));

    expect(parsed.status).toBe('pass');
    expect(parsed.bashCount).toBe(1);
    expect(parsed.grepCount).toBe(1);
  });

  it('extracts final answers from OpenCode jsonl text parts', async () => {
    const parser = await import(pathToFileUrl(parserPath));
    const parsed = parser.parseOpenCodeTranscriptText([
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'tool_call', tool: 'solidkg_context', input: { task: 'trace retry flow' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'OpenCode final answer text.' } }),
      JSON.stringify({ type: 'step_finish', cost: 0.01, part: { type: 'step-finish' } }),
    ].join('\n'));

    expect(parsed.status).toBe('pass');
    expect(parsed.finalAnswer.text).toBe('OpenCode final answer text.');
    expect(parsed.solidkgToolCalls).toBe(1);
    expect(parsed.costUsd).toBe(0.01);
  });

  it('extracts completed OpenCode tool_use outputs as raw tool results', async () => {
    const parser = await import(pathToFileUrl(parserPath));
    const parsed = parser.parseOpenCodeTranscriptText([
      JSON.stringify({ type: 'tool_use', part: { id: 'toolu_1', tool: 'solidkg_context', state: { status: 'completed', input: { task: 'flow' }, output: { content: 'raw graph result' } } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Answer from graph.' } }),
    ].join('\n'));

    expect(parsed.status).toBe('pass');
    expect(parsed.toolCalls).toEqual([{ tool: 'solidkg_context', input: { task: 'flow' } }]);
    expect(parsed.toolResults).toHaveLength(1);
    expect(parsed.toolResults[0]).toMatchObject({ seq: 0, tool: 'solidkg_context', requestId: 'toolu_1', resultId: 'toolu_1:result', parseStatus: 'parsed' });
    expect(parsed.toolResults[0].output).toEqual({ content: 'raw graph result' });
  });

  it('extracts tool calls and raw tool results from OpenCode session export messages', async () => {
    const parser = await import(pathToFileUrl(parserPath));
    const parsed = parser.parseOpenCodeTranscriptText(JSON.stringify({
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Question' }] },
        { info: { role: 'assistant' }, parts: [
          { type: 'tool', id: 'toolu_1', tool: 'solidkg_context', state: { status: 'completed', input: { task: 'flow' }, output: { content: 'raw graph result' } } },
          { type: 'text', text: 'Answer from exported session.' },
        ] },
      ],
    }));

    expect(parsed.status).toBe('pass');
    expect(parsed.finalAnswer.text).toBe('Answer from exported session.');
    expect(parsed.toolCalls).toEqual([{ tool: 'solidkg_context', input: { task: 'flow' } }]);
    expect(parsed.toolResults).toHaveLength(1);
    expect(parsed.rawToolResultPayloadBytes).toBeGreaterThan(0);
  });
  it('summarizes raw tool-result payload bytes and truncation counts', async () => {
    const parser = await import(pathToFileUrl(parserPath));
    const parsed = parser.parseOpenCodeTranscriptText([
      JSON.stringify({ type: 'tool_use', part: { id: 'toolu_1', tool: 'solidkg_context', state: { status: 'completed', output: { content: 'raw graph result' } } } }),
      JSON.stringify({ type: 'tool_use', part: { id: 'toolu_2', tool: 'solidkg_node', state: { status: 'completed', output: 'node result', truncated: true } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Answer from graph.' } }),
    ].join('\n'));

    expect(parsed.rawToolResultPayloadBytes).toBe(parsed.toolResults.reduce((sum: number, result: { sizeBytes: number }) => sum + result.sizeBytes, 0));
    expect(parsed.truncatedToolResultCount).toBe(1);
  });

});
