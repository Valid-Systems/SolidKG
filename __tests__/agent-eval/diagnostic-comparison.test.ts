import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const compareScript = path.join(repoRoot, 'scripts', 'agent-eval', 'compare-answer-diagnostics.mjs');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function runNode(...args: string[]) {
  return spawnSync(process.execPath, [compareScript, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath: string, events: unknown[]) {
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}


function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function writeEvidenceDossier(runDir: string, run: { id: string; scenarioId: string; armId: string; blockId: string }) {
  const payloadDir = path.join(runDir, 'tool-results');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payload = JSON.stringify({ content: `raw output for ${run.id}` });
  const payloadPath = path.join(payloadDir, '0001-tool.json');
  fs.writeFileSync(payloadPath, payload);
  const dossierPath = path.join(runDir, 'evidence-dossier.json');
  writeJson(dossierPath, {
    schemaName: 'solidkg.llm-answer-quality.evidence-dossier.v1',
    diagnosticOnly: true,
    runId: run.id,
    scenarioId: run.scenarioId,
    armId: run.armId,
    blockId: run.blockId,
    rawEventsPath: path.join(runDir, 'raw-events.jsonl'),
    transcriptPath: path.join(runDir, 'transcript.jsonl'),
    toolResults: [{
      seq: 1,
      tool: 'tool',
      requestId: `${run.id}:tool`,
      resultId: `${run.id}:tool:result`,
      rawPayloadPath: payloadPath,
      rawPayloadSha256: sha256(payload),
      sizeBytes: Buffer.byteLength(payload),
      truncated: false,
      error: false,
      parseStatus: 'parsed',
    }],
    finalAnswer: { text: 'answer' },
    metricsLedger: {},
    cohort: {},
  });
  return dossierPath;
}

function createRunArtifacts(base: string) {
  const solidkgRunDir = path.join(base, 'runs', 'repo_flow_r1_solidkg');
  const grepRunDir = path.join(base, 'runs', 'repo_flow_r1_grep_read');
  fs.mkdirSync(solidkgRunDir, { recursive: true });
  fs.mkdirSync(grepRunDir, { recursive: true });
  const solidkgTranscript = path.join(solidkgRunDir, 'transcript.jsonl');
  const grepTranscript = path.join(grepRunDir, 'transcript.jsonl');
  writeJsonl(solidkgTranscript, [
    { type: 'final', content: 'answer with source' },
    { type: 'tool_call', tool: 'solidkg_solidkg_context', input: { task: 'flow' } },
    { type: 'tool_call', tool: 'read', input: { path: 'src/file.ts' } },
  ]);
  writeJsonl(grepTranscript, [
    { type: 'final', content: 'answer with fallback' },
    { type: 'tool_call', tool: 'read', input: { path: 'src/file.ts' } },
  ]);
  writeJson(path.join(base, 'custom-scenarios.json'), {
    schemaName: 'solidkg.llm-answer-quality.scenarios.v1',
    scenarios: [{ id: 'repo-flow', repoId: 'repo', kind: 'architecture_flow', question: 'How does it flow?' }],
  });
  writeJson(path.join(base, 'live-results.json'), {
    schemaName: 'solidkg.llm-answer-quality.results.v1',
    profile: 'smoke',
    runs: [
      { id: 'repo-flow:r1:solidkg', blockId: 'repo-flow:r1', scenarioId: 'repo-flow', armId: 'solidkg', status: 'pass', transcriptPath: solidkgTranscript, readCount: 1, solidkgToolCalls: 1, toolCalls: [{ tool: 'solidkg_solidkg_context' }, { tool: 'read' }] },
      { id: 'repo-flow:r1:grep_read', blockId: 'repo-flow:r1', scenarioId: 'repo-flow', armId: 'grep_read', status: 'pass', transcriptPath: grepTranscript, readCount: 1, toolCalls: [{ tool: 'read' }] },
    ],
  });
}

describe('answer-quality diagnostic comparison', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reports missing raw tool result payloads as a stop condition', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-'));
    createRunArtifacts(tempDir);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.schemaName).toBe('solidkg.llm-answer-quality.diagnostic-comparison.v1');
    expect(report.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(report.rawOutputAvailability.toolResultPayloadsAvailable).toBe(false);
    expect(report.rawOutputAvailability.missingRunIds).toEqual(['repo-flow:r1:solidkg', 'repo-flow:r1:grep_read']);
    expect(report.comparisons[0].solidkgRun.rawEvidenceStatus).toMatchObject({ status: 'unavailable', causeCode: 'missing_evidence_dossier' });
    expect(report.comparisons[0].solidkgRun.classifications).toContain('solidkg_then_local_read_fallback');
    expect(report.comparisons[0].solidkgRun.finalAnswerPresent).toBe(true);
  });

  it('keeps the raw-output stop condition when transcript-only tool results lack evidence dossiers', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-partial-'));
    createRunArtifacts(tempDir);
    writeJsonl(path.join(tempDir, 'runs', 'repo_flow_r1_solidkg', 'transcript.jsonl'), [
      { type: 'final', content: 'answer with source' },
      { type: 'tool_call', tool: 'solidkg_solidkg_context', input: { task: 'flow' } },
      { type: 'tool_result', tool: 'solidkg_solidkg_context', output: 'raw result' },
    ]);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.rawOutputAvailability.toolResultPayloadsAvailable).toBe(false);
    expect(report.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(report.rawOutputAvailability.missingRunIds).toEqual(['repo-flow:r1:solidkg', 'repo-flow:r1:grep_read']);
    expect(report.comparisons[0].solidkgRun.toolResultPayloadsAvailable).toBe(false);
    expect(report.comparisons[0].solidkgRun.rawEvidenceStatus).toMatchObject({ status: 'unavailable', causeCode: 'transcript_only_tool_output' });
  });

  it('does not clear the raw-output stop condition for legacy transcript-only payloads', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-legacy-transcript-'));
    createRunArtifacts(tempDir);
    writeJsonl(path.join(tempDir, 'runs', 'repo_flow_r1_solidkg', 'transcript.jsonl'), [
      { type: 'final', content: 'answer with source' },
      { type: 'tool_call', tool: 'solidkg_solidkg_context', input: { task: 'flow' } },
      { type: 'tool_result', tool: 'solidkg_solidkg_context', output: 'legacy raw result' },
    ]);
    writeJsonl(path.join(tempDir, 'runs', 'repo_flow_r1_grep_read', 'transcript.jsonl'), [
      { type: 'final', content: 'answer with fallback' },
      { type: 'tool_call', tool: 'read', input: { path: 'src/file.ts' } },
      { type: 'tool_output', tool: 'read', output: 'legacy file payload' },
    ]);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.rawOutputAvailability.toolResultPayloadsAvailable).toBe(false);
    expect(report.stopConditions).toContain('raw_tool_outputs_unavailable');
    expect(report.rawOutputAvailability.missingRunIds).toEqual(['repo-flow:r1:solidkg', 'repo-flow:r1:grep_read']);
    expect(report.comparisons[0].solidkgRun.classifications).toContain('raw_tool_outputs_unavailable');
    expect(report.comparisons[0].baselineRuns[0].classifications).toContain('raw_tool_outputs_unavailable');
    expect(report.comparisons[0].baselineRuns[0].rawEvidenceStatus.causeCode).toBe('transcript_only_tool_output');
  });

  it('reports hash-mismatched evidence sidecars with actionable cause codes', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-hash-mismatch-'));
    createRunArtifacts(tempDir);
    const liveResultsPath = path.join(tempDir, 'live-results.json');
    const liveResults = JSON.parse(fs.readFileSync(liveResultsPath, 'utf8'));
    const run = liveResults.runs[0];
    const runDir = path.join(tempDir, 'runs', run.id.replace(/[^A-Za-z0-9_.-]+/g, '_'));
    fs.mkdirSync(runDir, { recursive: true });
    run.evidenceDossierPath = writeEvidenceDossier(runDir, run);
    const dossier = JSON.parse(fs.readFileSync(run.evidenceDossierPath, 'utf8'));
    fs.writeFileSync(dossier.toolResults[0].rawPayloadPath, 'tampered payload');
    writeJson(liveResultsPath, liveResults);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.comparisons[0].solidkgRun.rawEvidenceStatus).toMatchObject({ status: 'invalid', causeCode: 'payload_hash_mismatch' });
    expect(report.rawOutputAvailability.causeCodesByRun['repo-flow:r1:solidkg']).toBe('payload_hash_mismatch');
    expect(report.stopConditions).toContain('raw_tool_outputs_unavailable');
  });

  it('includes scorer repair design without changing scorer behavior', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-scorer-'));
    createRunArtifacts(tempDir);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.scorerRepairDesign.metricOrder.slice(0, 3)).toEqual(['reliability', 'correctness', 'sourceEvidence']);
    expect(report.scorerRepairDesign.requiredAdversarialFixtures).toEqual(expect.arrayContaining([
      'wrong_answer_with_right_file_tokens_fails',
      'correct_paraphrase_with_source_evidence_passes',
      'correct_files_missing_glue_hop_is_penalized',
    ]));
  });

  it('classifies repeated SolidKG node-call over-drilling in tool sequences', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-sequence-'));
    createRunArtifacts(tempDir);
    const liveResultsPath = path.join(tempDir, 'live-results.json');
    const liveResults = JSON.parse(fs.readFileSync(liveResultsPath, 'utf8'));
    liveResults.runs[0].solidkgToolCalls = 14;
    liveResults.runs[0].toolCalls = Array.from({ length: 11 }, () => ({ tool: 'solidkg_solidkg_node' }))
      .concat([{ tool: 'solidkg_solidkg_context' }, { tool: 'solidkg_solidkg_explore' }, { tool: 'solidkg_solidkg_files' }]);
    writeJson(liveResultsPath, liveResults);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.comparisons[0].solidkgRun.toolCallSequenceSummary).toMatchObject({ solidkgNodeCalls: 11, totalCalls: 14 });
    expect(report.comparisons[0].solidkgRun.toolCallSequenceSummary.classifications).toContain('repeated_solidkg_node_calls');
    expect(report.comparisons[0].solidkgRun.classifications).toContain('repeated_solidkg_node_calls');
  });

  it('writes JSON and Markdown artifacts through the CLI', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-cli-'));
    createRunArtifacts(tempDir);

    const result = runNode('--from-run-dir', tempDir, '--out', tempDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-diagnostic-comparison.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'llm-answer-diagnostic-comparison.md'), 'utf8')).toContain('Raw tool outputs unavailable');
  });

  it('clears the raw-output stop condition only when every analyzed run has validated evidence dossiers', async () => {
    const comparer = await import(pathToFileUrl(compareScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-compare-dossiers-'));
    createRunArtifacts(tempDir);
    const liveResultsPath = path.join(tempDir, 'live-results.json');
    const liveResults = JSON.parse(fs.readFileSync(liveResultsPath, 'utf8'));
    for (const run of liveResults.runs) {
      const runDir = path.join(tempDir, 'runs', run.id.replace(/[^A-Za-z0-9_.-]+/g, '_'));
      fs.mkdirSync(runDir, { recursive: true });
      run.evidenceDossierPath = writeEvidenceDossier(runDir, run);
    }
    writeJson(liveResultsPath, liveResults);

    const report = comparer.buildDiagnosticComparisonReport({ runDir: tempDir });

    expect(report.rawOutputAvailability.toolResultPayloadsAvailable).toBe(true);
    expect(report.stopConditions).not.toContain('raw_tool_outputs_unavailable');
    expect(report.rawOutputAvailability.missingRunIds).toEqual([]);
    expect(report.comparisons[0].solidkgRun.rawEvidenceStatus).toMatchObject({ status: 'available', causeCode: 'validated_sidecar_payloads' });
  });

});
