import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const freezeScript = path.join(repoRoot, 'scripts', 'agent-eval', 'freeze-answer-diagnostics.mjs');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function runNode(...args: string[]) {
  return spawnSync(process.execPath, [freezeScript, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRunDir(base: string) {
  fs.mkdirSync(path.join(base, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(base, 'setup'), { recursive: true });
  writeJson(path.join(base, 'run-plan.json'), {
    schemaName: 'solidkg.llm-answer-quality.orchestrator.v1',
    profile: 'smoke',
    plannedRunCount: 1,
    repoCache: 'D:/tmp/corpus',
    model: 'openai/gpt-5.5',
    variant: 'medium',
  });
  writeJson(path.join(base, 'custom-scenarios.json'), {
    schemaName: 'solidkg.llm-answer-quality.scenarios.v1',
    repoMatrix: [{ id: 'repo-one', repoUrl: 'local:D:/tmp/corpus/repo-one' }],
    scenarios: [{ id: 'repo-one-flow', repoId: 'repo-one', kind: 'architecture_flow', question: 'How does it flow?' }],
  });
  writeJson(path.join(base, 'live-results.json'), {
    schemaName: 'solidkg.llm-answer-quality.results.v1',
    profile: 'smoke',
    model: 'openai/gpt-5.5',
    variant: 'medium',
    runs: [{ id: 'repo-one-flow:r1:solidkg', armId: 'solidkg', status: 'pass' }],
  });
  writeJson(path.join(base, 'llm-answer-quality.json'), {
    schemaName: 'solidkg.llm-answer-quality.report.v1',
    benchmarkCoverage: { decisionReady: true },
  });
  fs.writeFileSync(path.join(base, 'llm-answer-quality.md'), '# LLM Answer Quality Benchmark Report\n');
  writeJson(path.join(base, 'opencode-capabilities.json'), { status: 'available' });
}

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

describe('answer-quality diagnostic freeze', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('writes a diagnostic-only manifest and Markdown report for a complete run directory', async () => {
    const freezer = await import(pathToFileUrl(freezeScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-'));
    createRunDir(tempDir);

    const report = freezer.buildDiagnosticFreezeReport({ runDir: tempDir });

    expect(report.schemaName).toBe('solidkg.llm-answer-quality.diagnostic-freeze.v1');
    expect(report.diagnosticOnly).toBe(true);
    expect(report.requiredArtifacts.every((artifact: { exists: boolean }) => artifact.exists)).toBe(true);
    expect(report.claimBoundary).toContain('failure-analysis evidence');
    expect(report.runSummary).toMatchObject({ profile: 'smoke', plannedRunCount: 1, model: 'openai/gpt-5.5' });
    expect(report.requiredArtifacts.find((artifact: { relativePath: string }) => artifact.relativePath === 'live-results.json').sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records missing optional artifacts without failing required artifact validation', async () => {
    const freezer = await import(pathToFileUrl(freezeScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-optional-'));
    createRunDir(tempDir);

    const report = freezer.buildDiagnosticFreezeReport({ runDir: tempDir });

    expect(report.requiredArtifactsMissing).toEqual([]);
    expect(report.optionalArtifactsMissing).toContain('llm-answer-cost-estimate.json');
    expect(report.validationStatus).toBe('complete_required_artifacts');
  });

  it('freezes required directory contents with a digest that changes when files change', async () => {
    const freezer = await import(pathToFileUrl(freezeScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-dirs-'));
    createRunDir(tempDir);
    fs.writeFileSync(path.join(tempDir, 'runs', 'trace.txt'), 'before');

    const before = freezer.buildDiagnosticFreezeReport({ runDir: tempDir });
    fs.writeFileSync(path.join(tempDir, 'runs', 'trace.txt'), 'after');
    const after = freezer.buildDiagnosticFreezeReport({ runDir: tempDir });
    const beforeRuns = before.requiredArtifacts.find((artifact: { relativePath: string }) => artifact.relativePath === 'runs');
    const afterRuns = after.requiredArtifacts.find((artifact: { relativePath: string }) => artifact.relativePath === 'runs');

    expect(beforeRuns.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(afterRuns.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(afterRuns.sha256).not.toBe(beforeRuns.sha256);
  });

  it('uses locale-independent code-point ordering for directory digests', async () => {
    const freezer = await import(pathToFileUrl(freezeScript));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-order-'));
    createRunDir(tempDir);
    fs.writeFileSync(path.join(tempDir, 'runs', 'Z.txt'), 'Z');
    fs.writeFileSync(path.join(tempDir, 'runs', 'a.txt'), 'a');

    const report = freezer.buildDiagnosticFreezeReport({ runDir: tempDir });
    const runs = report.requiredArtifacts.find((artifact: { relativePath: string }) => artifact.relativePath === 'runs');
    const expected = sha256(`file\tZ.txt\t1\t${sha256('Z')}\nfile\ta.txt\t1\t${sha256('a')}\n`);

    expect(runs.sha256).toBe(expected);
  });

  it('returns status 2 and writes a failure manifest when required artifacts are missing', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-missing-'));
    createRunDir(tempDir);
    fs.rmSync(path.join(tempDir, 'live-results.json'));

    const result = runNode('--from-run-dir', tempDir, '--out', tempDir);
    const stdout = JSON.parse(result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'llm-answer-diagnostic-freeze.json'), 'utf8'));

    expect(result.status, result.stderr).toBe(2);
    expect(stdout.ok).toBe(false);
    expect(stdout.validationStatus).toBe('missing_required_artifacts');
    expect(manifest.requiredArtifactsMissing).toContain('live-results.json');
  });

  it('writes JSON and Markdown artifacts through the CLI', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-freeze-cli-'));
    createRunDir(tempDir);

    const result = runNode('--from-run-dir', tempDir, '--out', tempDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'llm-answer-diagnostic-freeze.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'llm-answer-diagnostic-freeze.md'), 'utf8')).toContain('Diagnostic-only artifact freeze');
  });
});
