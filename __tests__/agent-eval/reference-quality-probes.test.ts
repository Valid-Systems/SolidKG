import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality', 'probe-runner.mjs');
const workerPath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality', 'worker.mjs');
const moduleUrl = new URL(`file://${modulePath.replace(/\\/g, '/')}`).href;
const hasBuiltEngine = existsSync(path.join(repoRoot, 'dist', 'index.js'));

function evaluate(expression: string): unknown {
  const source = `import * as probes from ${JSON.stringify(moduleUrl)};\nconsole.log(JSON.stringify(await (${expression})));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function indexedProbeExpression(action: string): string {
  return `(async () => {
    const fs = process.getBuiltinModule('node:fs');
    const os = process.getBuiltinModule('node:os');
    const path = process.getBuiltinModule('node:path');
    const url = process.getBuiltinModule('node:url');
    const crypto = process.getBuiltinModule('node:crypto');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-current-probe-'));
    const sourcePath = path.join(root, 'fixture.ts');
    const sourceText = 'export function referenceQualityFixture() { return 7; }\\n';
    fs.writeFileSync(sourcePath, sourceText);
    const indexDir = path.join(root, '.solidkg');
    fs.mkdirSync(indexDir);
    const sqlite = await import('node:sqlite');
    const sourceDb = new sqlite.DatabaseSync(path.join(indexDir, 'solidkg.db'));
    sourceDb.exec(fs.readFileSync(path.join(${JSON.stringify(repoRoot)}, 'src', 'db', 'schema.sql'), 'utf8'));
    const migrations = await import(url.pathToFileURL(path.join(${JSON.stringify(repoRoot)}, 'dist', 'db', 'migrations.js')).href);
    const version = await import(url.pathToFileURL(path.join(${JSON.stringify(repoRoot)}, 'dist', 'version.js')).href);
    sourceDb.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(migrations.CURRENT_SCHEMA_VERSION, Date.now(), 'current test schema');
    sourceDb.prepare('INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('solidkg:version', version.SOLIDKG_VERSION, Date.now());
    const sourceHash = crypto.createHash('sha256').update(sourceText).digest('hex');
    sourceDb.prepare('INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('fixture.ts', sourceHash, 'typescript', Buffer.byteLength(sourceText), Date.now(), Date.now(), 1, null);
    sourceDb.prepare('INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('function:fixture', 'function', 'referenceQualityFixture', 'referenceQualityFixture', 'fixture.ts', 'typescript', 1, 1, 0, 58, 1, Date.now());
    sourceDb.close();
    const parentTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-parent-probe-'));
    const before = probes.snapshotIndexArtifacts(path.join(root, '.solidkg'));
    try {
      ${action}
    } finally {
      fs.rmSync(parentTempRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  })()`;
}

const baseProbe = `{
  id: 'fixture-search', repoId: 'fixture', tool: 'solidkg_search',
  arguments: { query: 'referenceQualityFixture' }, expectedFiles: ['fixture.ts'],
  expectedLanguage: 'typescript', expectations: [{ section: '## Search Results', includes: 'referenceQualityFixture' }]
}`;

describe('reference quality probe diagnostics', () => {
  it('summarizes payload bytes and hash without retaining payload text', () => {
    const summary = evaluate(`probes.summarizeProbeRepeats([
      { executeMs: 7, payloadBytes: 6, outputHash: 'same', status: 'measured', evidence: { expectationResults: [] } },
      { executeMs: 3, payloadBytes: 6, outputHash: 'same', status: 'measured', evidence: { expectationResults: [] } },
      { executeMs: 5, payloadBytes: 6, outputHash: 'same', status: 'measured', evidence: { expectationResults: [] } },
    ])`) as Record<string, unknown>;

    expect(summary).toEqual({
      repeatCount: 3,
      latencyMs: { p50: 5, min: 3, max: 7 },
      payloadBytes: 6,
      outputHashes: ['same'],
      deterministic: true,
      statuses: { measured: 3 },
      expectationCount: 0,
      expectationMissCount: 0,
      relevance: {
        requiredRecall: null,
        usefulRecall: null,
        misleadingIntrusionRate: null,
      },
    });
    expect(JSON.stringify(summary)).not.toContain('payloadText');
  });

  it('bounds expectation matching to the named markdown section', () => {
    const evidence = evaluate(`probes.parseToolOutput(
      '## First\\nlocal value\\n## Second\\ntarget value\\n',
      [{ section: '## First', includes: 'target value' }, { section: '## Second', includes: 'target value' }]
    )`) as { expectationResults: Array<{ matched: boolean }> };

    expect(evidence.expectationResults.map((item) => item.matched)).toEqual([false, true]);
  });

  it('summarizes ranking reasons and explicit packet availability', () => {
    const evidence = evaluate(`probes.parseToolOutput(
      '### Answer Packet\\n- Schema: solidkg.answer-packet.v1\\n- Ranking reasons:\\n  - exact_symbol: exact match\\n  - source_body_chunk: local source body\\n',
      []
    )`) as { answerPacketAvailability: string; sourceCompletenessAvailability: string; rankingReasons: Array<{ kind: string; label: string }> };
    expect(evidence).toMatchObject({ answerPacketAvailability: 'available', sourceCompletenessAvailability: 'unavailable' });
    expect(evidence.rankingReasons).toEqual([{ kind: 'exact_symbol', label: 'exact match' }, { kind: 'source_body_chunk', label: 'local source body' }]);
  });

  it('grades required, useful, and misleading source evidence independently', () => {
    const evidence = evaluate(`probes.parseToolOutput(
      ${JSON.stringify('#### src/required.ts — run(function)\n#### src/useful.ts — helper(function)\n')},
      [],
      [
        { file: 'src/required.ts', relevance: 'required' },
        { file: 'src/useful.ts', relevance: 'useful' },
        { file: 'test/required.test.ts', relevance: 'misleading' }
      ]
    )`) as {
      relevanceResults: Array<{ file: string; relevance: string; matched: boolean }>;
      relevance: { requiredRecall: number; usefulRecall: number; misleadingIntrusionRate: number };
    };

    expect(evidence.relevanceResults).toEqual([
      { file: 'src/required.ts', relevance: 'required', matched: true },
      { file: 'src/useful.ts', relevance: 'useful', matched: true },
      { file: 'test/required.test.ts', relevance: 'misleading', matched: false },
    ]);
    expect(evidence.relevance).toEqual({
      requiredRecall: 1,
      usefulRecall: 1,
      misleadingIntrusionRate: 0,
    });
  });

  it('does not count peripheral file mentions as returned source evidence', () => {
    const evidence = evaluate(`probes.parseToolOutput(
      ${JSON.stringify('#### src/required.ts [complete] — run(function)\n### Not shown above\n- tests/required.test.ts [omitted]: testRun:4\n')},
      [],
      [
        { file: 'src/required.ts', relevance: 'required' },
        { file: 'tests/required.test.ts', relevance: 'misleading' }
      ]
    )`) as { relevanceResults: Array<{ file: string; matched: boolean }> };

    expect(evidence.relevanceResults).toEqual([
      { file: 'src/required.ts', relevance: 'required', matched: true },
      { file: 'tests/required.test.ts', relevance: 'misleading', matched: false },
    ]);
  });

  it('classifies a missing required source judgment as a miss', () => {
    const status = evaluate(`probes.classifyProbeRepeats([{
      status: 'measured', executeMs: 1, payloadBytes: 10, outputHash: 'same',
      evidence: probes.parseToolOutput(
        '#### src/other.ts — other(function)',
        [],
        [{ file: 'src/required.ts', relevance: 'required' }]
      )
    }])`);

    expect(status).toBe('miss');
  });

  it('classifies a truthful partial packet with missing required source as an abstention', () => {
    const status = evaluate(`probes.classifyProbeRepeats([{
      status: 'measured', executeMs: 1, payloadBytes: 10, outputHash: 'same',
      evidence: {
        ...probes.parseToolOutput(
          '#### src/other.ts — other(function)',
          [],
          [{ file: 'src/required.ts', relevance: 'required' }]
        ),
        sufficiency: 'partial'
      }
    }])`);

    expect(status).toBe('abstained');
  });

  it('classifies an expectation miss as miss', () => {
    const status = evaluate(`probes.classifyProbeRepeats([{
      status: 'measured', executeMs: 1, payloadBytes: 10, outputHash: 'same',
      evidence: probes.parseToolOutput('## Results\\nother', [{ section: '## Results', includes: 'wanted' }])
    }])`);

    expect(status).toBe('miss');
  });

  it('classifies execution errors and nondeterministic output explicitly', () => {
    const statuses = evaluate(`({
      error: probes.classifyProbeRepeats([
        { status: 'measured', executeMs: 1, payloadBytes: 1, outputHash: 'one', evidence: { expectationResults: [] } },
        { status: 'error', executeMs: 2, payloadBytes: 0, outputHash: null, evidence: { expectationResults: [] } }
      ]),
      nondeterministic: probes.classifyProbeRepeats([
        { status: 'measured', executeMs: 1, payloadBytes: 1, outputHash: 'one', evidence: { expectationResults: [] } },
        { status: 'measured', executeMs: 2, payloadBytes: 1, outputHash: 'two', evidence: { expectationResults: [] } }
      ])
    })`) as Record<string, string>;

    expect(statuses).toEqual({ error: 'error', nondeterministic: 'nondeterministic' });
  });

  it('cleans its allocated temp root when copying fails', () => {
    const result = evaluate(`(() => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const os = process.getBuiltinModule('node:os');
      const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-copy-parent-')), 'owned-probe');
      try { probes.copyIndexArtifacts(path.join(root, 'missing'), root); } catch { return fs.existsSync(root); }
      return true;
    })()`);

    expect(result).toBe(false);
  });

  it('requires the parent to own the worker temp path', () => {
    const result = spawnSync(process.execPath, [workerPath, 'probe'], {
      cwd: repoRoot,
      input: JSON.stringify({ repoPath: repoRoot, probe: { repoId: 'fixture', id: 'fixture' } }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('absolute tempRoot');
  });

  it('copies index sidecars without mutating the originals', () => {
    const result = evaluate(`(() => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const os = process.getBuiltinModule('node:os');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-copy-contract-'));
      try {
        fs.writeFileSync(path.join(root, 'solidkg.db'), 'db');
        fs.writeFileSync(path.join(root, 'solidkg.db-wal'), 'wal');
        fs.writeFileSync(path.join(root, 'solidkg.db-shm'), 'shm');
        const before = probes.snapshotIndexArtifacts(root);
        const copied = probes.copyIndexArtifacts(root);
        fs.writeFileSync(path.join(copied.copyDir, 'solidkg.db'), 'changed-copy');
        fs.rmSync(copied.tempRoot, { recursive: true, force: true });
        const after = probes.snapshotIndexArtifacts(root);
        return { same: JSON.stringify(before) === JSON.stringify(after), names: before.map((item) => item.name) };
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    })()`) as { same: boolean; names: string[] };

    expect(result.same).toBe(true);
    expect(result.names).toEqual(['solidkg.db', 'solidkg.db-shm', 'solidkg.db-wal']);
  });

  it('rejects non-regular index artifacts before copying', () => {
    const result = evaluate(`(() => {
      const fs = process.getBuiltinModule('node:fs'); const path = process.getBuiltinModule('node:path'); const os = process.getBuiltinModule('node:os');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-copy-contract-'));
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-copy-parent-'));
      try {
        fs.mkdirSync(path.join(root, 'solidkg.db'));
        try { probes.copyIndexArtifacts(root, parent); return 'accepted'; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(parent, { recursive: true, force: true }); }
    })()`);
    expect(result).toContain('regular file');
  });

  it.runIf(hasBuiltEngine)('executes a copied current-schema index and returns summaries only', () => {
    const result = evaluate(indexedProbeExpression(`
      const result = await probes.runProbeCase({ repoPath: root, engineRoot: ${JSON.stringify(repoRoot)}, repeatCount: 2, tempRoot: parentTempRoot, probe: ${baseProbe} });
      const after = probes.snapshotIndexArtifacts(path.join(root, '.solidkg'));
      return { result, originalsSame: JSON.stringify(before) === JSON.stringify(after), tempExists: fs.existsSync(parentTempRoot) };
    `)) as { result: Record<string, unknown> & { repeats: Array<Record<string, unknown>>; summary: Record<string, unknown> }; originalsSame: boolean; tempExists: boolean };

    expect(result.result.status).toBe('measured');
    expect(result.result.summary.payloadBytes).toBeGreaterThan(0);
    expect(result.result.summary.outputHashes).toHaveLength(1);
    expect(result.result.repeats.every((repeat) => !Object.hasOwn(repeat, 'payload'))).toBe(true);
    expect(result.originalsSame).toBe(true);
    expect(result.tempExists).toBe(false);
  });

  it.runIf(hasBuiltEngine)('reports parser absence explicitly', () => {
    const result = evaluate(indexedProbeExpression(`
      const probe = { ...${baseProbe}, expectedLanguage: 'missing-parser' };
      return await probes.runProbeCase({ repoPath: root, engineRoot: ${JSON.stringify(repoRoot)}, repeatCount: 1, tempRoot: parentTempRoot, probe });
    `)) as { status: string; preflight: { parser: { available: boolean; language: string } } };

    expect(result.status, JSON.stringify(result)).toBe('unavailable');
    expect(result.preflight.parser).toEqual({ available: false, language: 'missing-parser' });
  });

  it.runIf(hasBuiltEngine)('classifies source changes after indexing as stale', () => {
    const result = evaluate(indexedProbeExpression(`
      fs.writeFileSync(sourcePath, 'export function referenceQualityFixture() { return 8; }\\n');
      return await probes.runProbeCase({ repoPath: root, engineRoot: ${JSON.stringify(repoRoot)}, repeatCount: 1, tempRoot: parentTempRoot, probe: ${baseProbe} });
    `)) as { status: string; preflight: { freshness: { fresh: boolean } } };

    expect(result.status, JSON.stringify(result)).toBe('stale');
    expect(result.preflight.freshness.fresh).toBe(false);
  });
});
