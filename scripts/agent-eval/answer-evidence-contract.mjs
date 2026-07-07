#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVIDENCE_DOSSIER_SCHEMA = 'solidkg.llm-answer-quality.evidence-dossier.v1';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameText(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function payloadText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
}

function safeSegment(value) {
  return String(value ?? 'tool').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function copyMetadata(result) {
  const { output: _output, ...metadata } = result;
  return metadata;
}

export function validateEvidenceDossier(dossier, { run = null } = {}) {
  const errors = [];
  if (!isRecord(dossier)) {
    return { ok: false, toolResultPayloadsAvailable: false, errors: ['dossier must be an object'] };
  }
  if (dossier.schemaName !== EVIDENCE_DOSSIER_SCHEMA) errors.push(`schemaName must be ${EVIDENCE_DOSSIER_SCHEMA}`);
  for (const key of ['runId', 'scenarioId', 'armId']) {
    if (!hasText(dossier[key])) errors.push(`${key} is required`);
  }
  if (!Array.isArray(dossier.toolResults)) errors.push('toolResults must be an array');
  const toolResults = Array.isArray(dossier.toolResults) ? dossier.toolResults : [];
  let declaredPayloadBytes = 0;
  let declaredTruncatedCount = 0;
  for (const [index, result] of toolResults.entries()) {
    const prefix = `toolResults[${index}]`;
    if (!Number.isInteger(result?.seq) || result.seq < 0) errors.push(`${prefix}.seq must be a non-negative integer`);
    if (!hasText(result?.tool)) errors.push(`${prefix}.tool is required`);
    if (!hasText(result?.requestId)) errors.push(`${prefix}.requestId is required`);
    if (!hasText(result?.resultId)) errors.push(`${prefix}.resultId is required`);
    if (!hasText(result?.rawPayloadPath)) errors.push(`${prefix}.rawPayloadPath is required`);
    if (!hasText(result?.rawPayloadSha256)) errors.push(`${prefix}.rawPayloadSha256 is required`);
    if (hasText(result?.rawPayloadPath)) {
      if (!existsSync(result.rawPayloadPath)) {
        errors.push(`${prefix}.rawPayloadPath does not exist`);
      } else {
        const payload = readFileSync(result.rawPayloadPath, 'utf8');
        const actualHash = sha256Text(payload);
        if (hasText(result?.rawPayloadSha256) && actualHash !== result.rawPayloadSha256) errors.push(`${prefix}.rawPayloadSha256 does not match file`);
        if (Number.isFinite(result?.sizeBytes) && Buffer.byteLength(payload) !== result.sizeBytes) errors.push(`${prefix}.sizeBytes does not match file`);
      }
    }
    if (Number.isFinite(result?.sizeBytes)) declaredPayloadBytes += result.sizeBytes;
    if (result?.truncated === true) declaredTruncatedCount += 1;
  }
  if (isRecord(dossier.metricsLedger)) {
    if (Number.isFinite(dossier.metricsLedger.rawToolResultPayloadBytes) && dossier.metricsLedger.rawToolResultPayloadBytes !== declaredPayloadBytes) {
      errors.push('metricsLedger.rawToolResultPayloadBytes does not match toolResults sizeBytes total');
    }
    if (Number.isFinite(dossier.metricsLedger.truncatedToolResultCount) && dossier.metricsLedger.truncatedToolResultCount !== declaredTruncatedCount) {
      errors.push('metricsLedger.truncatedToolResultCount does not match toolResults truncated total');
    }
  }
  if (isRecord(run)) {
    const identityChecks = [
      ['runId', 'id'],
      ['scenarioId', 'scenarioId'],
      ['armId', 'armId'],
      ['blockId', 'blockId'],
    ];
    for (const [dossierKey, runKey] of identityChecks) {
      if (hasText(run[runKey]) && hasText(dossier[dossierKey]) && !sameText(dossier[dossierKey], run[runKey])) {
        errors.push(`dossier.${dossierKey} does not match result row ${runKey}`);
      }
    }
    if (finiteNumber(run.repeat) && finiteNumber(dossier.repeat) && Number(dossier.repeat) !== Number(run.repeat)) {
      errors.push('dossier.repeat does not match result row repeat');
    }
    if (isRecord(dossier.metricsLedger)) {
      for (const key of ['toolCallCount', 'readCount', 'grepCount', 'bashCount', 'solidkgToolCalls', 'peerWrapperCalls', 'fallbackLoopCount', 'rawToolResultPayloadBytes', 'truncatedToolResultCount']) {
        if (finiteNumber(run[key]) && finiteNumber(dossier.metricsLedger[key]) && Number(dossier.metricsLedger[key]) !== Number(run[key])) {
          errors.push(`metricsLedger.${key} does not match result row`);
        }
      }
    }
  }
  const toolResultPayloadsAvailable = toolResults.length > 0 && errors.length === 0;
  return { ok: errors.length === 0, toolResultPayloadsAvailable, errors };
}

function hasTranscriptToolOutput(events) {
  return Array.isArray(events) && events.some((event) => {
    const type = String(event?.type ?? '');
    const status = String(event?.part?.state?.status ?? event?.state?.status ?? '').toLowerCase();
    const hasOpenCodeOutput = type === 'tool_use' && (!status || status === 'completed' || status === 'done') && event?.part?.state?.output !== undefined;
    return hasOpenCodeOutput || /tool_(result|output)|tool_result|tool_output/.test(type);
  });
}

function causeCodeForValidation(errors, dossier) {
  if (errors.some((error) => error.includes('dossier.runId does not match') || error.includes('dossier.scenarioId does not match') || error.includes('dossier.armId does not match') || error.includes('dossier.blockId does not match') || error.includes('dossier.repeat does not match'))) return 'run_identity_mismatch';
  if (errors.some((error) => error.includes('metricsLedger.') && error.includes('does not match result row'))) return 'metrics_ledger_mismatch';
  if (errors.some((error) => error.includes('rawPayloadSha256 does not match'))) return 'payload_hash_mismatch';
  if (errors.some((error) => error.includes('rawPayloadPath does not exist'))) return 'missing_payload_file';
  if (errors.some((error) => error.includes('sizeBytes does not match'))) return 'payload_size_mismatch';
  if (Array.isArray(dossier?.toolResults) && dossier.toolResults.length === 0) return 'no_tool_results';
  if (errors.length > 0) return 'invalid_evidence_dossier';
  return 'no_tool_results';
}

export function classifyRawEvidence({ run = {}, events = [] } = {}) {
  const sourceAttempted = [];
  if (run?.evidenceDossierPath) sourceAttempted.push('evidence_dossier');
  if (run?.transcriptPath || events.length > 0) sourceAttempted.push('transcript');
  if (!run?.evidenceDossierPath) {
    return {
      status: 'unavailable',
      causeCode: hasTranscriptToolOutput(events) ? 'transcript_only_tool_output' : 'missing_evidence_dossier',
      sourceAttempted,
      errors: [],
    };
  }
  if (!existsSync(run.evidenceDossierPath)) {
    return { status: 'unavailable', causeCode: 'missing_evidence_dossier', sourceAttempted, errors: [`evidence dossier not found: ${run.evidenceDossierPath}`] };
  }
  try {
    const dossier = JSON.parse(readFileSync(run.evidenceDossierPath, 'utf8'));
    const validation = validateEvidenceDossier(dossier, { run });
    if (validation.toolResultPayloadsAvailable) return { status: 'available', causeCode: 'validated_sidecar_payloads', sourceAttempted, errors: [] };
    const causeCode = causeCodeForValidation(validation.errors, dossier);
    const status = causeCode === 'no_tool_results' ? 'unavailable' : 'invalid';
    return { status, causeCode, sourceAttempted, errors: validation.errors };
  } catch (error) {
    return { status: 'invalid', causeCode: 'invalid_evidence_dossier', sourceAttempted, errors: [error.message] };
  }
}

export function persistEvidenceDossier({ run, runDir, rawEventsText = '', transcriptPath = '', parsed = {}, cohort = {}, metricsLedger = {} }) {
  if (!runDir) throw new Error('runDir is required');
  mkdirSync(runDir, { recursive: true });
  const rawEventsPath = join(runDir, 'raw-events.jsonl');
  const rawText = String(rawEventsText ?? '');
  writeFileSync(rawEventsPath, rawText ? (rawText.endsWith('\n') ? rawText : `${rawText}\n`) : '');

  const payloadDir = join(runDir, 'tool-results');
  const rawToolResults = Array.isArray(parsed.toolResults) ? parsed.toolResults : [];
  const toolResults = rawToolResults.map((result, index) => {
    mkdirSync(payloadDir, { recursive: true });
    const seq = Number.isInteger(result.seq) && result.seq >= 0 ? result.seq : index;
    const tool = result.tool ?? 'tool';
    const text = payloadText(result.output);
    const rawPayloadPath = join(payloadDir, `${String(seq).padStart(4, '0')}-${safeSegment(tool)}.json`);
    writeFileSync(rawPayloadPath, text);
    return {
      seq,
      tool: String(tool),
      requestId: String(result.requestId ?? `${seq}`),
      resultId: String(result.resultId ?? `${result.requestId ?? seq}:result`),
      rawPayloadPath,
      rawPayloadSha256: sha256Text(text),
      sizeBytes: Buffer.byteLength(text),
      truncated: result.truncated === true,
      error: result.error === true,
      parseStatus: result.parseStatus ?? 'parsed',
    };
  });
  const rawToolResultPayloadBytes = toolResults.reduce((sum, result) => sum + result.sizeBytes, 0);
  const truncatedToolResultCount = toolResults.filter((result) => result.truncated).length;

  const dossier = {
    schemaName: EVIDENCE_DOSSIER_SCHEMA,
    diagnosticOnly: true,
    runId: run?.id ?? null,
    scenarioId: run?.scenarioId ?? null,
    armId: run?.armId ?? null,
    repeat: run?.repeat ?? null,
    blockId: run?.blockId ?? null,
    rawEventsPath,
    transcriptPath,
    toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
    toolResults,
    finalAnswer: { text: parsed.finalAnswer?.text ?? '', eventSeq: parsed.finalAnswer?.eventSeq ?? null },
    metricsLedger: {
      ...metricsLedger,
      rawToolResultPayloadBytes,
      truncatedToolResultCount,
    },
    cohort,
  };
  const evidenceDossierPath = join(runDir, 'evidence-dossier.json');
  const validation = validateEvidenceDossier(dossier);
  dossier.validation = validation;
  writeFileSync(evidenceDossierPath, `${JSON.stringify(dossier, null, 2)}\n`);
  return { evidenceDossierPath, rawEventsPath, toolResultPayloads: toolResults.map(copyMetadata), validation, dossier };
}
