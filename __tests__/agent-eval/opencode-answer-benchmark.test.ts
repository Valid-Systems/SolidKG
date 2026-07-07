import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const benchScript = path.join(repoRoot, 'scripts', 'agent-eval', 'opencode-answer-benchmark.mjs');
const sampleResults = path.join(repoRoot, 'fixtures', 'agent-eval', 'answer-quality', 'sample-results.json');

function pathToFileUrl(filePath: string) {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

function runNode(...args: string[]) {
  return spawnSync(process.execPath, [benchScript, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

describe('OpenCode answer benchmark orchestrator', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  function temp(prefix: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('writes calibration, smoke, and full dry-run plans with exact counts', () => {
    const calibrationOut = temp('cg-answer-calibration-');
    const smokeOut = temp('cg-answer-smoke-');
    const fullOut = temp('cg-answer-full-');

    expect(runNode('--profile', 'calibration', '--dry-run', '--out', calibrationOut).status).toBe(0);
    expect(runNode('--profile', 'smoke', '--dry-run', '--out', smokeOut).status).toBe(0);
    expect(runNode('--profile', 'full', '--dry-run', '--out', fullOut).status).toBe(0);

    expect(JSON.parse(fs.readFileSync(path.join(calibrationOut, 'run-plan.json'), 'utf8')).plannedRunCount).toBe(5);
    expect(JSON.parse(fs.readFileSync(path.join(smokeOut, 'run-plan.json'), 'utf8')).plannedRunCount).toBe(45);
    expect(JSON.parse(fs.readFileSync(path.join(fullOut, 'run-plan.json'), 'utf8')).plannedRunCount).toBe(270);
    expect(JSON.parse(fs.readFileSync(path.join(smokeOut, 'run-plan.json'), 'utf8')).willInvokeModel).toBe(false);
  });

  it('dry-runs a custom local-repo scenario matrix without built-in repo count requirements', () => {
    const out = temp('cg-answer-custom-plan-');
    const customScenarios = path.join(out, 'custom-scenarios.json');
    fs.writeFileSync(customScenarios, JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.scenarios.v1',
      repoMatrix: [{ id: 'pallets__flask', language: 'Python', size: 'Medium', repoUrl: 'local' }],
      scenarios: [{
        id: 'pallets__flask-architecture_flow',
        repoId: 'pallets__flask',
        kind: 'architecture_flow',
        question: 'How does Flask route a WSGI request to a view function?',
        answerType: 'architecture flow explanation',
        rubric: {
          mustMention: ['wsgi_app', 'full_dispatch_request', 'dispatch_request'],
          expectedEvidence: [
            { id: 'flask-routing-ev1', file: 'src/flask/app.py', symbolHint: 'wsgi_app', claim: 'request enters Flask through wsgi_app' },
            { id: 'flask-routing-ev2', file: 'src/flask/app.py', symbolHint: 'dispatch_request', claim: 'dispatch_request calls the matched endpoint view' },
          ],
          forbiddenClaims: ['Do not claim benchmark performance from this scenario fixture'],
          minEvidenceAnchors: 2,
          evidenceProvenance: 'Authored from local reference corpus for bounded live rerun.',
          goldEvidenceProvenance: 'Offline authored rubric for custom local reference corpus rerun.',
          goldSecondReview: { reviewedBy: 'custom-scenario-reviewer', status: 'approved', reviewedAt: '2026-06-06T00:00:00.000Z', notes: 'Reviewed for source-backed evidence.' },
          secondReviewedBy: 'custom-scenario-reviewer',
          secondReviewStatus: 'approved',
        },
      }],
    }));

    const result = runNode('--profile', 'smoke', '--from-scenarios', customScenarios, '--dry-run', '--out', out);

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(fs.readFileSync(path.join(out, 'run-plan.json'), 'utf8'));
    expect(plan.plannedRunCount).toBe(5);
    expect(plan.plannedRuns.map((run: { repoId: string }) => run.repoId)).toEqual(['pallets__flask', 'pallets__flask', 'pallets__flask', 'pallets__flask', 'pallets__flask']);
  });

  it('keeps seeded dry-run order deterministic while preserving block IDs', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const first = orchestrator.planRuns({ matrix, profile: 'smoke', seed: '123' });
    const second = orchestrator.planRuns({ matrix, profile: 'smoke', seed: '123' });
    const different = orchestrator.planRuns({ matrix, profile: 'smoke', seed: '456' });

    expect(first.map((run: { id: string }) => run.id)).toEqual(second.map((run: { id: string }) => run.id));
    expect(first.map((run: { id: string }) => run.id)).not.toEqual(different.map((run: { id: string }) => run.id));
    expect(first.every((run: { blockId: string; id: string }) => run.id.startsWith(`${run.blockId}:`))).toBe(true);
  });

  it('routes --from-results to report artifacts', () => {
    const out = temp('cg-answer-from-results-');
    const result = runNode('--from-results', sampleResults, '--out', out);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.html'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'llm-answer-quality.json'), 'utf8'));
    expect(report.passportReadiness.claimGrade).toBe(false);
    expect(report.passportReadiness.stopConditions).toContain('missing_benchmark_passport');
  });

  it('loads default scenarios when invoked outside the repo cwd', () => {
    const out = temp('cg-answer-nonrepo-cwd-');
    const result = spawnSync(process.execPath, [benchScript, '--profile', 'calibration', '--dry-run', '--out', out], { cwd: os.tmpdir(), encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'run-plan.json'), 'utf8')).plannedRunCount).toBe(5);
  });

  it('separates setup timing from query timing', () => {
    const out = temp('cg-answer-fixture-timing-');
    runNode('--from-results', sampleResults, '--out', out);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'llm-answer-quality.json'), 'utf8'));
    const solidkgRun = report.perRunRows.find((row: { armId: string }) => row.armId === 'solidkg');

    expect(solidkgRun.setupDurationMs).toBeGreaterThan(0);
    expect(solidkgRun.queryDurationMs).toBeGreaterThan(0);
    expect(report.aggregateByArm.find((row: { armId: string }) => row.armId === 'solidkg').medianQueryDurationMs).toBe(solidkgRun.queryDurationMs);
  });

  it('requires live confirmation and enforces caps before model invocation', () => {
    const noConfirm = runNode('--profile', 'calibration', '--out', temp('cg-answer-no-confirm-'));
    const missingRuns = runNode('--profile', 'calibration', '--confirm-live', '--max-estimated-cost-usd', '1', '--out', temp('cg-answer-missing-runs-'));
    const missingCost = runNode('--profile', 'calibration', '--confirm-live', '--max-runs', '5', '--out', temp('cg-answer-missing-cost-'));
    const tooMany = runNode('--profile', 'calibration', '--confirm-live', '--max-runs', '1', '--max-estimated-cost-usd', '1', '--out', temp('cg-answer-max-runs-'));
    const tooCostly = runNode('--profile', 'calibration', '--confirm-live', '--max-runs', '5', '--max-estimated-cost-usd', '0.01', '--out', temp('cg-answer-cost-'));
    const noCalibration = runNode('--profile', 'smoke', '--confirm-live', '--max-runs', '100', '--max-estimated-cost-usd', '100', '--out', temp('cg-answer-no-calibration-'));
    const fullOut = temp('cg-answer-no-smoke-');
    fs.writeFileSync(path.join(fullOut, 'calibration-success.json'), JSON.stringify({ status: 'successful' }));
    const noSmoke = runNode('--profile', 'full', '--confirm-live', '--max-runs', '300', '--max-estimated-cost-usd', '20', '--out', fullOut);

    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain('--confirm-live');
    expect(missingRuns.status).not.toBe(0);
    expect(missingRuns.stderr).toContain('--max-runs');
    expect(missingCost.status).not.toBe(0);
    expect(missingCost.stderr).toContain('--max-estimated-cost-usd');
    expect(tooMany.status).not.toBe(0);
    expect(tooMany.stderr).toContain('exceed --max-runs');
    expect(tooCostly.status).not.toBe(0);
    expect(tooCostly.stderr).toContain('exceeds --max-estimated-cost-usd');
    expect(noCalibration.status).not.toBe(0);
    expect(noCalibration.stderr).toContain('calibration evidence');
    expect(noSmoke.status).not.toBe(0);
    expect(noSmoke.stderr).toContain('smoke evidence');
  });

  it('executes the live path through stub adapters and writes scored report artifacts', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const reporter = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'report-answer-quality.mjs')));
    const out = temp('cg-answer-live-stub-');
    const repoCache = temp('cg-answer-live-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });

    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'live-stub' });
    const args = {
      profile: 'calibration',
      repeats: null,
      dryRun: false,
      preflightOnly: false,
      fromResults: '',
      out,
      repoCache,
      opencodeBin: 'stub-opencode',
      model: 'stub-model',
      timeoutMs: 12345,
      skipJudge: false,
      arm: ['solidkg'],
      seed: 'live-stub',
      confirmLive: true,
      maxRuns: 1,
      maxEstimatedCostUsd: 1,
      fromScenarios: '',
    };
    const calls: string[] = [];
    const nowValues = [1000, 1600, 2000, 2250];

    const result = await orchestrator.executeLiveBenchmark({
      args,
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => {
          calls.push('preflight');
          return { status: 'pass', artifact: path.join(out, 'opencode-capabilities.json'), transcriptCapability: { status: 'available' } };
        },
        nowMs: () => nowValues.shift(),
        runSetupCommand: ({ command, cwd }: { command: string[]; cwd: string }) => {
          calls.push('setup');
          expect(command[0]).toBe('solidkg');
          expect(cwd).toBe(path.join(repoCache, 'ky'));
          return { statusCode: 0, stdout: 'indexed', stderr: '' };
        },
        runOpenCode: ({ bin, argv, runDir }: { bin: string; argv: string[]; runDir: string }) => {
          calls.push('opencode');
          expect(bin).toBe('stub-opencode');
          expect(argv[0]).toBe('run');
          expect(argv).toContain('--pure');
          expect(runDir.startsWith(path.join(out, 'runs'))).toBe(true);
          return { statusCode: 0, stdout: 'stdout copy', stderr: '', transcriptText: '{"type":"final","content":"unused by stub parser"}\n' };
        },
        writeReport: (payload: { results: any; matrix: any; out: string; currentBenchmarkScriptPath?: string; currentScenarioFile?: string; expectedSolidKGBin?: string }) => {
          calls.push('report');
          expect(payload.currentBenchmarkScriptPath).toBe(benchScript);
          expect(payload.currentScenarioFile).toBe(args.fromScenarios);
          expect(payload.expectedSolidKGBin).toBe('solidkg');
          return reporter.writeAnswerQualityReport(payload);
        },
        parseTranscript: (transcriptPath: string) => {
          calls.push('parse');
          expect(fs.existsSync(transcriptPath)).toBe(true);
          expect(transcriptPath.startsWith(path.join(out, 'runs'))).toBe(true);
          return {
            status: 'pass',
            finalAnswer: { text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' },
            toolCalls: [{ tool: 'solidkg_trace' }],
            toolResults: [{ seq: 0, tool: 'solidkg_trace', requestId: 'toolu_1', output: { content: 'raw graph payload' }, sizeBytes: 31, truncated: true }],
            rawToolResultPayloadBytes: 31,
            truncatedToolResultCount: 1,
            readCount: 0,
            grepCount: 0,
            bashCount: 0,
            solidkgToolCalls: 1,
            peerWrapperCalls: 0,
            fallbackLoopCount: 0,
            costUsd: 0.03,
          };
        },
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual(['preflight', 'setup', 'opencode', 'parse', 'report']);
    expect(fs.existsSync(path.join(out, 'live-results.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'llm-answer-quality.html'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'calibration-success.json'))).toBe(true);

    const liveResults = JSON.parse(fs.readFileSync(path.join(out, 'live-results.json'), 'utf8'));
    expect(liveResults.runs[0].status).toBe('pass');
    expect(liveResults.runs[0].setupDurationMs).toBe(600);
    expect(liveResults.runs[0].queryDurationMs).toBe(250);
    expect(liveResults.runs[0].rawToolResultPayloadBytes).toBe(liveResults.runs[0].toolResultPayloads[0].sizeBytes);
    expect(liveResults.runs[0].truncatedToolResultCount).toBe(1);
    expect(liveResults.runs[0].score).toBeGreaterThan(0);
    expect(liveResults.runs[0].stdoutPath.startsWith(path.join(out, 'runs'))).toBe(true);
    expect(liveResults.runs[0].stderrPath.startsWith(path.join(out, 'runs'))).toBe(true);
    expect(liveResults.runs[0].transcriptPath.startsWith(path.join(out, 'runs'))).toBe(true);

    const report = JSON.parse(fs.readFileSync(path.join(out, 'llm-answer-quality.json'), 'utf8'));
    const row = report.perRunRows[0];
    expect(row.setupDurationMs).toBe(600);
    expect(row.queryDurationMs).toBe(250);
    expect(row.rawToolResultPayloadBytes).toBe(liveResults.runs[0].toolResultPayloads[0].sizeBytes);
    expect(row.truncatedToolResultCount).toBe(1);
  });

  it('normalizes relative live output and repo-cache paths before setup and OpenCode config', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-relative-out-');
    const repoCache = temp('cg-answer-relative-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const relativeOut = path.relative(repoRoot, out);
    const relativeRepoCache = path.relative(repoRoot, repoCache);
    const expectedRepoPath = path.resolve(repoRoot, relativeRepoCache, 'ky');
    const expectedDataDir = path.resolve(repoRoot, relativeOut, 'setup', 'solidkg', 'ky');
    const relativeSolidKGBin = path.join('.omo', 'local-solidkg.cmd');
    const expectedSolidKGBin = path.resolve(repoRoot, relativeSolidKGBin);
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'relative-paths' });
    const nowValues = [1000, 1600, 2000, 2250];

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out: relativeOut, repoCache: relativeRepoCache, opencodeBin: 'stub-opencode', solidkgBin: relativeSolidKGBin, model: 'stub-model', timeoutMs: 12345, seed: 'relative-paths', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1, fromScenarios: '' },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => ({ status: 'pass', transcriptCapability: { status: 'available' } }),
        nowMs: () => nowValues.shift(),
        runSetupCommand: ({ command, cwd }: { command: string[]; cwd: string }) => {
          expect(cwd).toBe(expectedRepoPath);
          expect(command).toEqual([expectedSolidKGBin, 'init', '-i', expectedRepoPath, '--data-dir', expectedDataDir]);
          return { statusCode: 0, stdout: 'indexed', stderr: '' };
        },
        runOpenCode: ({ argv, runDir, configPaths }: { argv: string[]; runDir: string; configPaths: { opencodeConfigPath: string } }) => {
          expect(runDir.startsWith(path.resolve(repoRoot, relativeOut, 'runs'))).toBe(true);
          expect(argv[argv.indexOf('--dir') + 1]).toBe(expectedRepoPath);
          const config = JSON.parse(fs.readFileSync(configPaths.opencodeConfigPath, 'utf8'));
          expect(config.mcp.solidkg.command).toEqual([expectedSolidKGBin, 'serve', '--mcp', '--path', expectedRepoPath, '--data-dir', expectedDataDir]);
          return { statusCode: 0, stdout: 'stdout copy', stderr: '', transcriptText: '{"type":"final","content":"unused by stub parser"}\n' };
        },
        parseTranscript: () => ({
          status: 'pass',
          finalAnswer: { text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' },
          toolCalls: [{ tool: 'solidkg_trace' }],
          toolResults: [{ seq: 0, tool: 'solidkg_trace', requestId: 'toolu_1', output: { content: 'raw graph payload' }, truncated: false }],
          readCount: 0,
          grepCount: 0,
          bashCount: 0,
          solidkgToolCalls: 1,
          peerWrapperCalls: 0,
          fallbackLoopCount: 0,
          costUsd: 0.01,
        }),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.results.runs[0].repoPath).toBe(expectedRepoPath);
  });

  it('reuses successful setup for repeated runs on the same arm and repo', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-setup-reuse-');
    const repoCache = temp('cg-answer-setup-reuse-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], repeats: 2, seed: 'setup-reuse' });
    const args = { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 12345, seed: 'setup-reuse', confirmLive: true, maxRuns: 2, maxEstimatedCostUsd: 1 };
    const calls: string[] = [];
    const nowValues = [1000, 1500, 2000, 2250, 3000, 3250];

    const result = await orchestrator.executeLiveBenchmark({
      args,
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => { calls.push('preflight'); return { status: 'pass', transcriptCapability: { status: 'available' } }; },
        nowMs: () => nowValues.shift(),
        runSetupCommand: () => { calls.push('setup'); return { statusCode: 0, stdout: 'indexed', stderr: '' }; },
        runOpenCode: () => { calls.push('opencode'); return { statusCode: 0, stdout: 'stdout copy', stderr: '', transcriptText: '{"type":"final","content":"unused by stub parser"}\n' }; },
        parseTranscript: () => {
          calls.push('parse');
          return {
            status: 'pass',
            finalAnswer: { text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' },
            toolCalls: [{ tool: 'solidkg_context' }],
            readCount: 0,
            grepCount: 0,
            bashCount: 0,
            solidkgToolCalls: 1,
            peerWrapperCalls: 0,
            fallbackLoopCount: 0,
            costUsd: 0.01,
          };
        },
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual(['preflight', 'setup', 'opencode', 'parse', 'opencode', 'parse']);
    expect(result.results.runs).toHaveLength(2);
    expect(result.results.runs[0].setupDurationMs).toBe(500);
    expect(result.results.runs[1].setupDurationMs).toBe(0);
    expect(result.results.runs[1].setup.reusedFromRunId).toBe(result.results.runs[0].id);
  });

  it('preserves setup timeout error details in reliability rows', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-setup-timeout-');
    const repoCache = temp('cg-answer-setup-timeout-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'setup-timeout' });

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 12345, seed: 'setup-timeout', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => ({ status: 'pass', transcriptCapability: { status: 'available' } }),
        nowMs: (() => { const values = [1000, 1333]; return () => values.shift(); })(),
        runSetupCommand: () => ({ statusCode: 1, stdout: '', stderr: '', errorCode: 'ETIMEDOUT' }),
        runOpenCode: () => { throw new Error('opencode should not run after setup timeout'); },
        parseTranscript: () => { throw new Error('parse should not run after setup timeout'); },
      },
    });

    expect(result.status).toBe(0);
    expect(result.results.runs[0].status).toBe('setup_failed');
    expect(result.results.runs[0].reason).toContain('solidkg_setup_timeout');
    expect(result.results.runs[0].reason).toContain('ETIMEDOUT');
  });

  it('uses shell execution for default live subprocesses on Windows', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));

    expect(orchestrator.defaultRunCommand({ command: ['node', '--version'], cwd: repoRoot, timeoutMs: 120_000 }).statusCode).toBe(0);
    expect(orchestrator.defaultRunOpenCode({ bin: process.execPath, argv: ['--version'], cwd: repoRoot, timeoutMs: 120_000, env: {} }).statusCode).toBe(0);
  });

  it('runs PATH-resolved CLI shims without leaking literal quotes into arguments', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const out = temp('cg-answer-shim-bin-');
    const commandName = 'fake-benchmark-shim';
    const binPath = path.join(out, process.platform === 'win32' ? `${commandName}.cmd` : commandName);
    const script = process.platform === 'win32'
      ? '@echo off\r\necho %*\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho "$@"\nexit 0\n';
    fs.writeFileSync(binPath, script);
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
    const oldPath = process.env.Path;
    const oldPATH = process.env.PATH;
    process.env.Path = `${out}${path.delimiter}${oldPath ?? oldPATH ?? ''}`;
    process.env.PATH = `${out}${path.delimiter}${oldPATH ?? oldPath ?? ''}`;
    try {
      const result = orchestrator.defaultRunCommand({ command: [commandName, '--yes', 'package-name', '--message', 'two words', 'D:\\tmp\\solidkg-corpus\\ky'], cwd: repoRoot, timeoutMs: 120_000 });

      expect(result.statusCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('--yes package-name --message');
      expect(result.stdout).toContain('two words');
      expect(result.stdout).not.toContain('"--yes"');
      if (process.platform === 'win32') expect(result.stdout).toContain('D:/tmp/solidkg-corpus/ky');
    } finally {
      process.env.Path = oldPath;
      process.env.PATH = oldPATH;
    }
  });

  it('exports printed-log OpenCode sessions and uses the export as transcript text', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const out = temp('cg-answer-opencode-export-');
    const scriptPath = path.join(out, 'fake-opencode.mjs');
    const binPath = path.join(out, process.platform === 'win32' ? 'fake-opencode.cmd' : 'fake-opencode');
    fs.writeFileSync(scriptPath, [
      'const args = process.argv.slice(2);',
      'if (args[0] === "run") {',
      '  console.log("INFO service=session id=ses_export123 title=cgaq-export-test created");',
      '  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "stdout fallback" } }));',
      '  process.exit(0);',
      '}',
      'if (args[0] === "export" && args[1] === "ses_export123") {',
      '  console.log(JSON.stringify({ messages: [{ info: { role: "assistant" }, parts: [{ type: "tool", id: "toolu_1", tool: "solidkg_context", state: { status: "completed", input: { task: "flow" }, output: { content: "raw graph result" } } }, { type: "text", text: "exported final answer" }] }] }));',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
    ].join('\n'));
    if (process.platform === 'win32') fs.writeFileSync(binPath, '@echo off\r\nnode "' + scriptPath + '" %*\r\n');
    else {
      fs.writeFileSync(binPath, '#!/bin/sh\nnode "' + scriptPath + '" "$@"\n');
      fs.chmodSync(binPath, 0o755);
    }

    const result = orchestrator.defaultRunOpenCode({ bin: binPath, argv: ['run', 'message', '--title', 'cgaq-export-test', '--print-logs'], cwd: out, timeoutMs: 120000, env: {} });

    expect(result.statusCode).toBe(0);
    expect(result.sessionId).toBe('ses_export123');
    expect(result.sessionExportText).toContain('exported final answer');
    expect(result.transcriptText).toContain('raw graph result');
    expect(result.transcriptText).not.toContain('stdout fallback');
  });
  it('exports the single new OpenCode session when logs and title lookup do not expose the id', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const out = temp('cg-answer-opencode-session-diff-');
    const statePath = path.join(out, 'session-created.flag').replace(/\\/g, '\\\\');
    const scriptPath = path.join(out, 'fake-opencode.mjs');
    const binPath = path.join(out, process.platform === 'win32' ? 'fake-opencode.cmd' : 'fake-opencode');
    fs.writeFileSync(scriptPath, [
      'import fs from "node:fs";',
      'const args = process.argv.slice(2);',
      `const statePath = "${statePath}";`,
      'if (args[0] === "session" && args[1] === "list") {',
      '  if (fs.existsSync(statePath)) console.log("ses_newdiff123 OpenCode Answer Quality Benchmark Arm 7:01 PM");',
      '  process.exit(0);',
      '}',
      'if (args[0] === "run") {',
      '  fs.writeFileSync(statePath, "created");',
      '  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "stdout fallback" } }));',
      '  process.exit(0);',
      '}',
      'if (args[0] === "export" && args[1] === "ses_newdiff123") {',
      '  console.log(JSON.stringify({ messages: [{ info: { role: "assistant" }, parts: [{ type: "tool", id: "toolu_1", tool: "solidkg_context", state: { status: "completed", input: { task: "flow" }, output: { content: "raw graph result" } } }, { type: "text", text: "exported final answer" }] }] }));',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
    ].join('\n'));
    if (process.platform === 'win32') fs.writeFileSync(binPath, '@echo off\r\nnode "' + scriptPath + '" %*\r\n');
    else {
      fs.writeFileSync(binPath, '#!/bin/sh\nnode "' + scriptPath + '" "$@"\n');
      fs.chmodSync(binPath, 0o755);
    }

    const result = orchestrator.defaultRunOpenCode({ bin: binPath, argv: ['run', 'message', '--title', 'cgaq-title-not-in-list', '--print-logs'], cwd: out, timeoutMs: 120000, env: {} });

    expect(result.statusCode).toBe(0);
    expect(result.sessionId).toBe('ses_newdiff123');
    expect(result.sessionExportText).toContain('exported final answer');
    expect(result.transcriptText).toContain('raw graph result');
  });
  it('normalizes OpenCode stderr tool lines into counted fallback and peer events', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const parser = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'parse-opencode-transcript.mjs')));
    const transcript = orchestrator.transcriptTextFromOpenCode({
      stdout: [
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'Final answer.' } }),
        JSON.stringify({ type: 'step_finish', cost: 0.01 }),
      ].join('\n'),
      stderr: [
        '\u001B[0m→ \u001B[0mRead D:/tmp/solidkg-corpus/ky/source/core/Ky.ts\u001B[90m [offset=1, limit=10]\u001B[0m',
        '\u001B[0m$ \u001B[0mrg -n "retry" D:/tmp/solidkg-corpus/ky/source',
        '\u001B[0m$ \u001B[0mnode D:/tmp/run/peer-wrappers/tilth_wrapper.mjs',
      ].join('\n'),
    });
    const parsed = parser.parseOpenCodeTranscriptText(transcript);

    expect(parsed.status).toBe('pass');
    expect(parsed.readCount).toBe(1);
    expect(parsed.grepCount).toBe(1);
    expect(parsed.bashCount).toBe(1);
    expect(parsed.peerWrapperCalls).toBe(1);
  });

  it('blocks unsafe live calls before invoking stub adapters', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-live-blocked-');
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'blocked' });
    let adapterCalls = 0;

    const result = await orchestrator.executeLiveBenchmark({
      args: {
        profile: 'calibration',
        out,
        repoCache: temp('cg-answer-live-blocked-repos-'),
        opencodeBin: 'stub-opencode',
        model: 'stub-model',
        timeoutMs: 1,
        seed: 'blocked',
        confirmLive: false,
        maxRuns: 1,
        maxEstimatedCostUsd: 1,
      },
      matrix,
      plannedRuns,
      adapters: {
        runSetupCommand: () => { adapterCalls += 1; throw new Error('setup should not run'); },
        runOpenCode: () => { adapterCalls += 1; throw new Error('opencode should not run'); },
        parseTranscript: () => { adapterCalls += 1; throw new Error('parse should not run'); },
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--confirm-live');
    expect(adapterCalls).toBe(0);
  });

  it('runs preflight before setup and blocks live execution when preflight fails', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-preflight-blocked-');
    const repoCache = temp('cg-answer-preflight-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'preflight' });
    const calls: string[] = [];

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 1, seed: 'preflight', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => { calls.push('preflight'); return { status: 'runner_failed', reason: 'fake_preflight_failed' }; },
        runSetupCommand: () => { calls.push('setup'); throw new Error('setup should not run'); },
        runOpenCode: () => { calls.push('opencode'); throw new Error('opencode should not run'); },
        parseTranscript: () => { calls.push('parse'); throw new Error('parse should not run'); },
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OpenCode preflight failed');
    expect(calls).toEqual(['preflight']);
  });

  it('resumes completed live runs from partial results without rerunning them', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-resume-partial-');
    const repoCache = temp('cg-answer-resume-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'resume-partial' });
    fs.writeFileSync(path.join(out, 'live-results.partial.json'), JSON.stringify({
      schemaName: 'solidkg.llm-answer-quality.results.v1',
      profile: 'calibration',
      seed: 'resume-partial',
      runs: [{
        ...plannedRuns[0],
        status: 'pass',
        reliabilityStatus: 'pass',
        repoPath: path.join(repoCache, 'ky'),
        setupDurationMs: 1,
        queryDurationMs: 1,
        costUsd: 0,
        answer: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/utils/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.',
        toolCalls: [{ tool: 'solidkg_context' }],
        readCount: 0,
        grepCount: 0,
        bashCount: 0,
        solidkgToolCalls: 1,
        peerWrapperCalls: 0,
        fallbackLoopCount: 0,
      }],
    }));
    const calls: string[] = [];

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 1, seed: 'resume-partial', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => { calls.push('preflight'); return { status: 'pass', transcriptCapability: { status: 'available' } }; },
        runSetupCommand: () => { calls.push('setup'); throw new Error('setup should not rerun'); },
        runOpenCode: () => { calls.push('opencode'); throw new Error('opencode should not rerun'); },
        parseTranscript: () => { calls.push('parse'); throw new Error('parse should not rerun'); },
      },
    });

    expect(result.status).toBe(0);
    expect(calls).toEqual(['preflight']);
    expect(result.results.runs[0].status).toBe('pass');
    expect(fs.existsSync(path.join(out, 'live-results.json'))).toBe(true);
  });

  it('marks missing repo cache as setup_failed without setup OpenCode or parser calls', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-missing-repo-');
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'missing-repo' });
    const calls: string[] = [];

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache: temp('cg-answer-empty-repos-'), opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 1, seed: 'missing-repo', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => { calls.push('preflight'); return { status: 'pass', transcriptCapability: { status: 'available' } }; },
        runSetupCommand: () => { calls.push('setup'); throw new Error('setup should not run'); },
        runOpenCode: () => { calls.push('opencode'); throw new Error('opencode should not run'); },
        parseTranscript: () => { calls.push('parse'); throw new Error('parse should not run'); },
      },
    });

    expect(result.status).toBe(0);
    expect(calls).toEqual(['preflight']);
    expect(result.results.runs[0].status).toBe('setup_failed');
  });

  it('allows smoke guard when calibration-success evidence exists in the output directory', () => {
    const out = temp('cg-answer-smoke-with-calibration-');
    fs.writeFileSync(path.join(out, 'calibration-success.json'), JSON.stringify({ status: 'successful' }));
    const result = runNode('--profile', 'smoke', '--confirm-live', '--max-runs', '1', '--max-estimated-cost-usd', '1', '--out', out);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('calibration evidence');
  });

  it('writes evidence dossiers and raw payload sidecars from completed OpenCode tool_use output', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const contract = await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-evidence-contract.mjs')));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-evidence-live-');
    const repoCache = temp('cg-answer-evidence-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'evidence-live' });
    const nowValues = [1000, 1600, 2000, 2250];

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 12345, seed: 'evidence-live', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => ({ status: 'pass', artifact: path.join(out, 'opencode-capabilities.json'), transcriptCapability: { status: 'available' } }),
        nowMs: () => nowValues.shift(),
        runSetupCommand: () => ({ statusCode: 0, stdout: 'indexed', stderr: '' }),
        runOpenCode: () => ({
          statusCode: 0,
          stdout: [
            JSON.stringify({ type: 'tool_use', part: { id: 'toolu_1', tool: 'solidkg_trace', state: { status: 'completed', input: { from: 'dispatch', to: 'execute' }, output: { content: 'source/core/Ky.ts dispatch source/core/normalize.ts execute ky-architecture_flow-ev1 ky-architecture_flow-ev2' } } } }),
            JSON.stringify({ type: 'text', part: { type: 'text', text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' } }),
          ].join('\n'),
          stderr: '',
        }),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const run = result.results.runs[0];
    expect(run.evidenceDossierPath).toBeTruthy();
    expect(fs.existsSync(run.evidenceDossierPath)).toBe(true);
    expect(fs.existsSync(run.rawEventsPath)).toBe(true);
    const dossier = JSON.parse(fs.readFileSync(run.evidenceDossierPath, 'utf8'));
    expect(dossier.toolResults).toHaveLength(1);
    expect(fs.existsSync(dossier.toolResults[0].rawPayloadPath)).toBe(true);
    expect(dossier.metricsLedger.rawToolResultPayloadBytes).toBe(dossier.toolResults[0].sizeBytes);
    expect(contract.validateEvidenceDossier(dossier)).toMatchObject({ ok: true, toolResultPayloadsAvailable: true });
  });

  it('wires explicit SolidKG binary provenance into dry-run setup and MCP config', () => {
    const out = temp('cg-answer-solidkg-bin-');
    const solidkgBin = process.platform === 'win32' ? 'D:/tools/solidkg.cmd' : '/opt/solidkg/bin/solidkg';
    const result = runNode('--profile', 'calibration', '--dry-run', '--arm', 'solidkg', '--solidkg-bin', solidkgBin, '--out', out);
    const expectedSolidKGBin = path.resolve(repoRoot, solidkgBin);

    expect(result.status, result.stderr).toBe(0);
    const dryResults = JSON.parse(fs.readFileSync(path.join(out, 'dry-run-results.json'), 'utf8'));
    const solidkgRun = dryResults.runs.find((run: { armId: string }) => run.armId === 'solidkg');
    expect(solidkgRun.setup.setupCommand[0]).toBe(expectedSolidKGBin);
    expect(dryResults.benchmarkPassport.solidkg.configuredBin).toBe(expectedSolidKGBin);
    expect(dryResults.benchmarkPassport.readiness.claimGrade).toBe(false);
    const config = JSON.parse(fs.readFileSync(solidkgRun.opencodePlan.opencodeConfigPath, 'utf8'));
    expect(config.mcp.solidkg.command[0]).toBe(expectedSolidKGBin);
  });

  it('uses sidecar raw payload metrics when parser metrics are zero but session export has completed tool results', async () => {
    const orchestrator = await import(pathToFileUrl(benchScript));
    const matrix = (await import(pathToFileUrl(path.join(repoRoot, 'scripts', 'agent-eval', 'answer-scenarios.mjs')))).loadScenarioMatrix();
    const out = temp('cg-answer-sidecar-metrics-');
    const repoCache = temp('cg-answer-sidecar-metrics-repos-');
    fs.mkdirSync(path.join(repoCache, 'ky'), { recursive: true });
    const plannedRuns = orchestrator.planRuns({ matrix, profile: 'calibration', arms: ['solidkg'], seed: 'sidecar-metrics' });
    const nowValues = [1000, 1600, 2000, 2250];
    const sessionExportText = [
      JSON.stringify({ type: 'tool_use', part: { id: 'toolu_1', tool: 'solidkg_trace', state: { status: 'completed', input: { from: 'dispatch', to: 'execute' }, output: { content: 'raw graph payload with source/core/Ky.ts dispatch source/core/normalize.ts execute' } } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' } }),
    ].join('\n');

    const result = await orchestrator.executeLiveBenchmark({
      args: { profile: 'calibration', out, repoCache, opencodeBin: 'stub-opencode', model: 'stub-model', timeoutMs: 12345, seed: 'sidecar-metrics', confirmLive: true, maxRuns: 1, maxEstimatedCostUsd: 1 },
      matrix,
      plannedRuns,
      adapters: {
        runPreflight: () => ({ status: 'pass', transcriptCapability: { status: 'available' } }),
        nowMs: () => nowValues.shift(),
        runSetupCommand: () => ({ statusCode: 0, stdout: 'indexed', stderr: '' }),
        runOpenCode: () => ({ statusCode: 0, stdout: '', stderr: '', transcriptText: '{"type":"final","content":"parser fixture"}\n', sessionExportText }),
        parseTranscript: () => ({
          status: 'pass',
          finalAnswer: { text: 'Describe the primary cross-file flow in order. Name the core dispatch or orchestration symbol. Evidence: source/core/Ky.ts dispatch and source/core/normalize.ts execute. ky-architecture_flow-ev1 ky-architecture_flow-ev2.' },
          toolCalls: [{ tool: 'solidkg_trace' }],
          readCount: 0,
          grepCount: 0,
          bashCount: 0,
          solidkgToolCalls: 1,
          peerWrapperCalls: 0,
          fallbackLoopCount: 0,
          rawToolResultPayloadBytes: 0,
          truncatedToolResultCount: 0,
          costUsd: 0.01,
        }),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const run = result.results.runs[0];
    const dossier = JSON.parse(fs.readFileSync(run.evidenceDossierPath, 'utf8'));
    expect(dossier.toolResults).toHaveLength(1);
    expect(dossier.metricsLedger.rawToolResultPayloadBytes).toBeGreaterThan(0);
    expect(run.rawToolResultPayloadBytes).toBe(dossier.metricsLedger.rawToolResultPayloadBytes);
    expect(run.truncatedToolResultCount).toBe(dossier.metricsLedger.truncatedToolResultCount);
  });
});
