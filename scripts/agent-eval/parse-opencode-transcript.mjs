#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NORMALIZED_SCHEMA = 'solidkg.opencode-transcript.normalized.v1';
const PEER_WRAPPER_PATTERN = /^(tilth|cartog|sverklo)(?:_wrapper)?$/i;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function eventListFromParsed(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.events)) return parsed.events;
  if (Array.isArray(parsed.messages)) return parsed.messages;
  if (Array.isArray(parsed.transcript)) return parsed.transcript;
  if (typeof parsed.type === 'string' || typeof parsed.role === 'string' || isRecord(parsed.message)) return [parsed];
  return null;
}

function parseTranscriptText(text) {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unsupported', events: [], reason: 'empty_transcript' };
  try {
    const parsed = JSON.parse(trimmed);
    const events = eventListFromParsed(parsed);
    if (!events) return { kind: 'unsupported', events: [], reason: 'unsupported_transcript_format' };
    return { kind: 'json', events, root: parsed, parseErrors: [] };
  } catch {}

  const events = [];
  const parseErrors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, message: error.message });
    }
  }
  if (events.length === 0) return { kind: 'unsupported', events: [], reason: 'unsupported_transcript_format' };
  return { kind: 'jsonl', events, parseErrors };
}

function collectTextBlocks(content) {
  const chunks = [];
  if (typeof content === 'string') chunks.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') chunks.push(block);
      else if (isRecord(block)) {
        if (typeof block.text === 'string') chunks.push(block.text);
        else if (typeof block.content === 'string') chunks.push(block.content);
      }
    }
  } else if (isRecord(content)) {
    if (typeof content.text === 'string') chunks.push(content.text);
    else if (typeof content.content === 'string') chunks.push(content.content);
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function extractToolCallsFromContent(content) {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = String(block.type ?? block.kind ?? '').toLowerCase();
    const name = block.name ?? block.tool ?? block.toolName ?? block.state?.tool ?? block.function?.name;
    if ((type === 'tool_use' || type === 'tool_call' || type === 'tool') && typeof name === 'string') {
      calls.push({ tool: name, input: block.input ?? block.args ?? block.arguments ?? block.state?.input ?? block.function?.arguments ?? null });
    }
    if (isRecord(block.toolInvocation) && typeof block.toolInvocation.toolName === 'string') {
      calls.push({ tool: block.toolInvocation.toolName, input: block.toolInvocation.args ?? null });
    }
  }
  return calls;
}

function extractToolCall(event) {
  if (!isRecord(event)) return [];
  const calls = [];
  const type = String(event.type ?? event.kind ?? '').toLowerCase();
  const directName = event.tool ?? event.toolName ?? event.name ?? event.part?.tool ?? event.part?.name ?? event.part?.toolName ?? event.function?.name;
  if ((type === 'tool_call' || type === 'tool_use' || type === 'tool') && typeof directName === 'string') {
    calls.push({ tool: directName, input: event.input ?? event.args ?? event.arguments ?? event.part?.state?.input ?? event.part?.input ?? event.function?.arguments ?? null });
  }
  if (isRecord(event.toolCall)) {
    const name = event.toolCall.tool ?? event.toolCall.toolName ?? event.toolCall.name;
    if (typeof name === 'string') calls.push({ tool: name, input: event.toolCall.input ?? event.toolCall.args ?? null });
  }
  if (isRecord(event.message)) calls.push(...extractToolCallsFromContent(event.message.content));
  calls.push(...extractToolCallsFromContent(event.content));
  calls.push(...extractToolCallsFromContent(event.parts));
  return calls;
}

function payloadSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null));
}

function extractToolResultFromPart(part, seq) {
  if (!isRecord(part)) return null;
  const type = String(part.type ?? part.kind ?? '').toLowerCase();
  const state = part.state;
  const status = String(state?.status ?? part.status ?? '').toLowerCase();
  const output = state?.output ?? part.output ?? part.result;
  if ((type !== 'tool' && type !== 'tool_use' && type !== 'tool_result' && type !== 'tool_output') || output === undefined) return null;
  if ((type === 'tool' || type === 'tool_use') && status && status !== 'completed' && status !== 'done') return null;
  const requestId = String(part.id ?? part.tool_use_id ?? seq);
  return {
    seq,
    tool: String(part.tool ?? part.name ?? part.toolName ?? state?.tool ?? 'tool'),
    requestId,
    resultId: String(part.resultId ?? part.result_id ?? `${requestId}:result`),
    output,
    sizeBytes: payloadSize(output),
    truncated: part.truncated === true || state?.truncated === true,
    error: part.error === true || state?.error === true,
    parseStatus: 'parsed',
  };
}

function extractToolResult(event, seq) {
  if (!isRecord(event)) return null;
  const type = String(event.type ?? event.kind ?? '').toLowerCase();
  const state = event.part?.state ?? event.state ?? event.toolCall?.state;
  const status = String(state?.status ?? event.status ?? '').toLowerCase();
  const output = state?.output ?? event.output ?? event.result;
  const directName = event.tool ?? event.toolName ?? event.name ?? event.part?.tool ?? event.part?.name ?? event.part?.toolName ?? event.function?.name;
  if ((type !== 'tool_use' && type !== 'tool_result' && type !== 'tool_output') || output === undefined) return null;
  if (type === 'tool_use' && status && status !== 'completed' && status !== 'done') return null;
  if (Array.isArray(event.parts)) return null;
  const requestId = String(event.part?.id ?? event.id ?? event.toolCall?.id ?? event.tool_use_id ?? seq);
  return {
    seq,
    tool: String(directName ?? 'tool'),
    requestId,
    resultId: String(event.resultId ?? event.result_id ?? `${requestId}:result`),
    output,
    sizeBytes: payloadSize(output),
    truncated: event.truncated === true || state?.truncated === true,
    error: event.error === true || state?.error === true,
    parseStatus: 'parsed',
  };
}

function extractAssistantText(event) {
  if (!isRecord(event)) return [];
  const chunks = [];
  const role = String(event.role ?? event.message?.role ?? '').toLowerCase();
  const type = String(event.type ?? '').toLowerCase();
  if (role === 'assistant' || type === 'assistant' || type === 'message' || type === 'result' || type === 'final' || type === 'text') {
    chunks.push(...collectTextBlocks(event.text));
    chunks.push(...collectTextBlocks(event.output));
    chunks.push(...collectTextBlocks(event.result));
    chunks.push(...collectTextBlocks(event.part?.text));
    chunks.push(...collectTextBlocks(event.part?.content));
    chunks.push(...collectTextBlocks(event.message?.content));
    chunks.push(...collectTextBlocks(event.content));
  }
  return chunks;
}

function normalizeToolName(tool) {
  return String(tool ?? '').replace(/^mcp__[A-Za-z0-9_-]+__/, '').toLowerCase();
}

function shellInputText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return [input.command, input.cmd, input.script, input.args, input.arguments]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function countMetrics(toolCalls) {
  let readCount = 0;
  let grepCount = 0;
  let bashCount = 0;
  let solidkgToolCalls = 0;
  let peerWrapperCalls = 0;
  let fallbackLoopCount = 0;
  let seenSolidKG = false;
  for (const call of toolCalls) {
    const tool = normalizeToolName(call.tool);
    const isRead = tool === 'read';
    const isGrep = tool === 'grep' || tool === 'rg' || tool.includes('grep');
    const isBash = tool === 'bash' || tool === 'shell';
    const isShellSearch = isBash && /\b(rg|grep)\b/.test(shellInputText(call.input));
    const isSolidKG = tool.startsWith('solidkg_') || tool.includes('solidkg');
    const isPeer = PEER_WRAPPER_PATTERN.test(tool) || /^(tilth|cartog|sverklo)_/.test(tool);
    if (isRead) readCount++;
    if (isGrep || isShellSearch) grepCount++;
    if (isBash) bashCount++;
    if (isSolidKG) seenSolidKG = true;
    if (isSolidKG) solidkgToolCalls++;
    if (isPeer) peerWrapperCalls++;
    if (seenSolidKG && (isRead || isGrep || isShellSearch || isBash)) fallbackLoopCount++;
  }
  return { readCount, grepCount, bashCount, solidkgToolCalls, peerWrapperCalls, fallbackLoopCount };
}

function collectUsage(root, events) {
  const candidates = [];
  if (isRecord(root)) candidates.push(root, root.result, root.usage, root.metadata);
  for (const event of events) if (isRecord(event)) candidates.push(event, event.usage, event.message?.usage, event.metadata);
  let durationMs;
  let costUsd;
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    durationMs ??= firstNumber(candidate.durationMs, candidate.duration_ms, candidate.elapsedMs, candidate.elapsed_ms);
    costUsd ??= firstNumber(candidate.costUsd, candidate.total_cost_usd, candidate.cost_usd, candidate.cost);
  }
  return { durationMs: durationMs ?? 0, costUsd };
}

function hasKnownOpenCodeShape(events) {
  return events.some((event) => isRecord(event) && (
    typeof event.type === 'string' ||
    typeof event.role === 'string' ||
    isRecord(event.message) ||
    isRecord(event.info) ||
    isRecord(event.toolCall) ||
    Array.isArray(event.content) ||
    Array.isArray(event.parts)
  ));
}

export function parseOpenCodeTranscriptText(text) {
  const parsed = parseTranscriptText(text);
  if (parsed.kind === 'unsupported') {
    return {
      schemaName: NORMALIZED_SCHEMA,
      status: 'runner_failed',
      reason: parsed.reason ?? 'unsupported_transcript_format',
      finalAnswer: { text: '' },
      toolCalls: [],
      readCount: 0,
      grepCount: 0,
      bashCount: 0,
      solidkgToolCalls: 0,
      peerWrapperCalls: 0,
      fallbackLoopCount: 0,
      durationMs: 0,
    };
  }

  const events = parsed.events.filter(isRecord);
  if (!hasKnownOpenCodeShape(events)) {
    return {
      schemaName: NORMALIZED_SCHEMA,
      status: 'runner_failed',
      reason: 'unsupported_transcript_format',
      finalAnswer: { text: '' },
      toolCalls: [],
      readCount: 0,
      grepCount: 0,
      bashCount: 0,
      solidkgToolCalls: 0,
      peerWrapperCalls: 0,
      fallbackLoopCount: 0,
      durationMs: 0,
    };
  }

  const toolCalls = [];
  const toolResults = [];
  const answerChunks = [];
  for (const [seq, event] of events.entries()) {
    toolCalls.push(...extractToolCall(event));
    const toolResult = extractToolResult(event, seq);
    if (toolResult) toolResults.push(toolResult);
    if (Array.isArray(event.parts)) {
      for (const [partIndex, part] of event.parts.entries()) {
        const partResult = extractToolResultFromPart(part, (seq * 1000) + partIndex);
        if (partResult) toolResults.push(partResult);
      }
    }
    answerChunks.push(...extractAssistantText(event));
    answerChunks.push(...collectTextBlocks(event.parts));
  }
  const finalAnswerText = answerChunks.at(-1)?.trim() ?? '';
  const usage = collectUsage(parsed.root, events);
  const metrics = countMetrics(toolCalls);
  const rawToolResultPayloadBytes = toolResults.reduce((sum, result) => sum + Number(result.sizeBytes ?? 0), 0);
  const truncatedToolResultCount = toolResults.filter((result) => result.truncated === true).length;
  const malformed = parsed.parseErrors.length > 0 || !finalAnswerText;
  const result = {
    schemaName: NORMALIZED_SCHEMA,
    status: malformed ? 'parse_failed' : 'pass',
    finalAnswer: { text: finalAnswerText },
    toolCalls,
    toolResults,
    rawToolResultPayloadBytes,
    truncatedToolResultCount,
    ...metrics,
    durationMs: usage.durationMs,
  };
  if (usage.costUsd !== undefined) result.costUsd = usage.costUsd;
  if (malformed) result.reason = parsed.parseErrors.length > 0 ? 'malformed_jsonl_transcript' : 'missing_final_answer';
  return result;
}

export function parseOpenCodeTranscriptFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`transcript file not found: ${filePath}`);
  return parseOpenCodeTranscriptText(readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const args = { from: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' || argv[i] === '--transcript') args.from = argv[++i] ?? '';
    else if (!args.from) args.from = argv[i];
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.from) return { status: 1, stdout: '', stderr: 'usage: parse-opencode-transcript.mjs --from <transcript.jsonl>\n' };
  const parsed = parseOpenCodeTranscriptFile(args.from);
  return { status: 0, stdout: `${JSON.stringify(parsed, null, 2)}\n`, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runCli();
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}


