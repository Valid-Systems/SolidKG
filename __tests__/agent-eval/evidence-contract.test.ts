import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'scripts', 'agent-eval', 'answer-evidence-contract.mjs');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

describe('answer-quality evidence dossier contract', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('accepts a dossier with linked raw payload sidecars and hashes', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-'));
    const payloadPath = path.join(tempDir, 'tool-results', '0001-solidkg_context.json');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    const payload = JSON.stringify({ content: 'raw result' });
    fs.writeFileSync(payloadPath, payload);

    const dossier = {
      schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
      diagnosticOnly: true,
      runId: 'repo-flow:r1:solidkg',
      scenarioId: 'repo-flow',
      armId: 'solidkg',
      repeat: 1,
      blockId: 'repo-flow:r1',
      rawEventsPath: path.join(tempDir, 'raw-events.jsonl'),
      transcriptPath: path.join(tempDir, 'transcript.jsonl'),
      toolResults: [{
        seq: 1,
        tool: 'solidkg_context',
        requestId: 'toolu_1',
        resultId: 'toolu_1:result',
        rawPayloadPath: payloadPath,
        rawPayloadSha256: sha256(payload),
        sizeBytes: Buffer.byteLength(payload),
        truncated: false,
        error: false,
        parseStatus: 'parsed',
      }],
      finalAnswer: { text: 'answer', eventSeq: 2 },
      metricsLedger: { toolCallCount: 1, readCount: 0, grepCount: 0, solidkgToolCalls: 1 },
      cohort: { model: 'stub-model', profile: 'calibration', repoId: 'repo' },
    };

    const validation = contract.validateEvidenceDossier(dossier);

    expect(validation).toMatchObject({ ok: true, toolResultPayloadsAvailable: true });
    expect(validation.errors).toEqual([]);
  });

  it('rejects a dossier that claims tool output availability without payload files and hashes', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-invalid-'));

    const validation = contract.validateEvidenceDossier({
      schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
      diagnosticOnly: true,
      runId: 'repo-flow:r1:solidkg',
      scenarioId: 'repo-flow',
      armId: 'solidkg',
      toolResults: [{ seq: 1, tool: 'solidkg_context', requestId: 'toolu_1', resultId: 'toolu_1:result' }],
      finalAnswer: { text: 'answer' },
      metricsLedger: {},
      cohort: {},
    });

    expect(validation.ok).toBe(false);
    expect(validation.toolResultPayloadsAvailable).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'toolResults[0].rawPayloadPath is required',
      'toolResults[0].rawPayloadSha256 is required',
    ]));
  });

  it('persists payload-byte guardrail metrics with raw sidecars', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-persist-'));

    const evidence = contract.persistEvidenceDossier({
      run: { id: 'repo-flow:r1:solidkg', scenarioId: 'repo-flow', armId: 'solidkg', repeat: 1, blockId: 'repo-flow:r1' },
      runDir: tempDir,
      rawEventsText: '',
      parsed: {
        toolCalls: [{ tool: 'solidkg_context', input: { task: 'flow' } }],
        toolResults: [
          { seq: 0, tool: 'solidkg_context', requestId: 'toolu_1', output: { content: 'raw graph result' }, truncated: false },
          { seq: 1, tool: 'solidkg_node', requestId: 'toolu_2', output: 'node result', truncated: true },
        ],
        finalAnswer: { text: 'answer', eventSeq: 2 },
      },
      metricsLedger: { toolCallCount: 1, readCount: 0, grepCount: 0 },
    });

    const dossier = JSON.parse(fs.readFileSync(evidence.evidenceDossierPath, 'utf8'));

    expect(dossier.metricsLedger.rawToolResultPayloadBytes).toBe(
      dossier.toolResults.reduce((sum: number, result: { sizeBytes: number }) => sum + result.sizeBytes, 0)
    );
    expect(dossier.metricsLedger.truncatedToolResultCount).toBe(1);
    expect(contract.validateEvidenceDossier(dossier)).toMatchObject({ ok: true, toolResultPayloadsAvailable: true });
  });

  it('rejects declared payload-byte guardrails that do not match sidecars', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-guardrail-'));
    const payloadPath = path.join(tempDir, 'tool-results', '0001-solidkg_context.json');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    const payload = JSON.stringify({ content: 'raw result' });
    fs.writeFileSync(payloadPath, payload);

    const validation = contract.validateEvidenceDossier({
      schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
      runId: 'repo-flow:r1:solidkg',
      scenarioId: 'repo-flow',
      armId: 'solidkg',
      toolResults: [{ seq: 1, tool: 'solidkg_context', requestId: 'toolu_1', resultId: 'toolu_1:result', rawPayloadPath: payloadPath, rawPayloadSha256: sha256(payload), sizeBytes: Buffer.byteLength(payload), truncated: false }],
      metricsLedger: { rawToolResultPayloadBytes: 1, truncatedToolResultCount: 0 },
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('metricsLedger.rawToolResultPayloadBytes does not match toolResults sizeBytes total');
  });

  it('classifies a sidecar with mismatched run identity as invalid', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-identity-'));
    const payloadPath = path.join(tempDir, 'tool-results', '0001-solidkg_context.json');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    const payload = JSON.stringify({ content: 'raw result' });
    fs.writeFileSync(payloadPath, payload);
    const dossierPath = path.join(tempDir, 'evidence-dossier.json');
    fs.writeFileSync(dossierPath, JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
      runId: 'other-scenario:r1:solidkg',
      scenarioId: 'other-scenario',
      armId: 'solidkg',
      repeat: 1,
      blockId: 'other-scenario:r1',
      toolResults: [{ seq: 1, tool: 'solidkg_context', requestId: 'toolu_1', resultId: 'toolu_1:result', rawPayloadPath: payloadPath, rawPayloadSha256: sha256(payload), sizeBytes: Buffer.byteLength(payload), truncated: false }],
      metricsLedger: { toolCallCount: 1, readCount: 0, grepCount: 0, solidkgToolCalls: 1, rawToolResultPayloadBytes: Buffer.byteLength(payload), truncatedToolResultCount: 0 },
    }, null, 2));

    const classification = contract.classifyRawEvidence({
      run: { id: 'repo-flow:r1:solidkg', scenarioId: 'repo-flow', armId: 'solidkg', repeat: 1, blockId: 'repo-flow:r1', evidenceDossierPath: dossierPath, toolCallCount: 1, readCount: 0, grepCount: 0, solidkgToolCalls: 1 },
    });

    expect(classification.status).toBe('invalid');
    expect(classification.causeCode).toBe('run_identity_mismatch');
    expect(classification.errors).toContain('dossier.runId does not match result row id');
  });

  it('classifies a sidecar with mismatched metric ledger as invalid', async () => {
    const contract = await import(pathToFileUrl(contractPath));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-evidence-metrics-'));
    const payloadPath = path.join(tempDir, 'tool-results', '0001-solidkg_context.json');
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    const payload = JSON.stringify({ content: 'raw result' });
    fs.writeFileSync(payloadPath, payload);
    const dossierPath = path.join(tempDir, 'evidence-dossier.json');
    fs.writeFileSync(dossierPath, JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
      runId: 'repo-flow:r1:solidkg',
      scenarioId: 'repo-flow',
      armId: 'solidkg',
      repeat: 1,
      blockId: 'repo-flow:r1',
      toolResults: [{ seq: 1, tool: 'solidkg_context', requestId: 'toolu_1', resultId: 'toolu_1:result', rawPayloadPath: payloadPath, rawPayloadSha256: sha256(payload), sizeBytes: Buffer.byteLength(payload), truncated: false }],
      metricsLedger: { toolCallCount: 1, readCount: 99, grepCount: 0, solidkgToolCalls: 1, rawToolResultPayloadBytes: Buffer.byteLength(payload), truncatedToolResultCount: 0 },
    }, null, 2));

    const classification = contract.classifyRawEvidence({
      run: { id: 'repo-flow:r1:solidkg', scenarioId: 'repo-flow', armId: 'solidkg', repeat: 1, blockId: 'repo-flow:r1', evidenceDossierPath: dossierPath, toolCallCount: 1, readCount: 0, grepCount: 0, solidkgToolCalls: 1 },
    });

    expect(classification.status).toBe('invalid');
    expect(classification.causeCode).toBe('metrics_ledger_mismatch');
    expect(classification.errors).toContain('metricsLedger.readCount does not match result row');
  });
});
