import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG, { getDatabasePath } from '../src/index';
import packageJson from '../package.json';

const BIN = path.resolve(__dirname, '../dist/bin/solidkg.js');
const ALLOWED_CONTEXT_BUDGET_BASELINES = ['changed_files', 'candidate_files', 'candidate_symbols', 'diff', 'not_available'];
const TERMINAL_FRAME_FRAGMENTS = ['\u001B[', 'graph console', 'ledger ', 'index graph facts', 'progress:', 'Scan files', 'Parse code', 'Store graph', 'Resolve refs'];
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/;

function expectSourceCompletenessMetadata(value: unknown): void {
  expect(value).toEqual(expect.objectContaining({
    status: expect.any(String),
    candidateBlocks: expect.any(Number),
    returnedBlocks: expect.any(Number),
    completeBlocks: expect.any(Number),
    truncatedBlocks: expect.any(Number),
    omittedBlocks: expect.any(Number),
    unreadableBlocks: expect.any(Number),
    maxBlocks: expect.any(Number),
    maxBlockSize: expect.any(Number),
  }));
}

function runCli(args: string[], cwd?: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectNoTerminalFrames(output: string): void {
  for (const fragment of TERMINAL_FRAME_FRAGMENTS) {
    expect(output).not.toContain(fragment);
  }
}

function expectNoAnsiEscapeSequences(output: string): void {
  expect(output).not.toMatch(ANSI_ESCAPE_SEQUENCE);
}

function nonEmptyLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

describe('standalone CLI JSON contracts', () => {
  let testDir: string;
  let cg: SolidKG | undefined;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-contract-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      `export function helper(): string { return 'ok'; }\nexport function entry(): string { return helper(); }\n`
    );
    cg = SolidKG.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();
    cg = undefined;
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('keeps CLI human rendering behind the terminal presenter boundary', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');

    expect(cliSource).not.toContain('@clack/prompts');
    expect(cliSource).not.toContain('createShimmerProgress');
    expect(cliSource).not.toMatch(/from ['"]ink['"]/);
    expect(cliSource).not.toMatch(/from ['"]react['"]/);
    expect(cliSource).toContain('createTerminalPresenter');
  });

  it('settles interactive sync progress to the final summary before plain fallback output', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');
    const syncCommandIndex = cliSource.indexOf(".command('sync [path]')");
    const finalMessageIndex = cliSource.indexOf('const finalMessage = formatSyncSuccessLine(result);', syncCommandIndex);
    const finalCompletionIndex = cliSource.indexOf('const finalCompletion = formatSyncCompletionSummary(result);', finalMessageIndex);
    const stopIndex = cliSource.indexOf('await progress?.stop(finalCompletion);', finalCompletionIndex);
    const fallbackIndex = cliSource.indexOf('if (progress === undefined)', stopIndex);

    expect(syncCommandIndex).toBeGreaterThan(-1);
    expect(finalMessageIndex).toBeGreaterThan(-1);
    expect(finalCompletionIndex).toBeGreaterThan(finalMessageIndex);
    expect(stopIndex).toBeGreaterThan(finalCompletionIndex);
    expect(fallbackIndex).toBeGreaterThan(stopIndex);
    expect(cliSource).toContain('presenter.message(finalMessage);');
  });

  it('keeps error and warning receipt counts tied to the saved log path', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');

    expect(cliSource).toContain("`${plural(errors, 'error')}`");
    expect(cliSource).toContain("`${plural(warnings, 'warning')} saved to ${errorLogReference(projectPath, dataDir)}`");
    expect(cliSource).toContain("diagnostic.severity !== 'error' && diagnostic.severity !== 'warning'");
    expect(cliSource).toContain('files with diagnostics');
    expect(cliSource).toContain("...issueSegments");
  });

  it('renders verbose source-chunk progress when detail changes within one phase', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');
    const indexSource = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');

    expect(cliSource).toContain('const progressLabel = progress.detail ?? progress.phase;');
    expect(cliSource).toContain('if (progressLabel !== lastPhase)');
    expect(cliSource).toContain('PROGRESS_PHASE_LABELS[progressLabel]');
    expect(indexSource).toContain('phase: "storing",\n      detail: "source_chunks",');
    expect(indexSource).not.toContain('phase: "indexing",\n      detail: "source_chunks",');
  });

  it('reports bounded graph cleanup failures without exposing raw error details', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');
    const destroyIndex = cliSource.indexOf('function destroyIndexGraph');
    const destroySource = cliSource.slice(destroyIndex, cliSource.indexOf('\n}\n', destroyIndex) + 3);

    expect(destroySource).toContain('logWarn(');
    expect(destroySource).toContain('process.stderr.write(');
    expect(destroySource).toContain('Graph cleanup failed');
    expect(destroySource).not.toContain('error.stack');
    expect(destroySource).not.toContain('String(error)');
  });

  it('keeps include-vendored CLI help aligned with vendor and vendored behavior', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');

    expect(cliSource.match(/Include vendor\/ and vendored\/ source instead of the default dependency-source exclusion/g)).toHaveLength(3);
    expect(cliSource).not.toContain('Include vendored/ source instead of the default vendored exclusion');
  });

  it('exits nonzero from global CLI exception handlers', () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../src/bin/solidkg.ts'), 'utf8');
    const uncaughtIndex = cliSource.indexOf("process.on('uncaughtException'");
    const rejectionIndex = cliSource.indexOf("process.on('unhandledRejection'");
    const mainIndex = cliSource.indexOf('function main()');

    expect(uncaughtIndex).toBeGreaterThan(-1);
    expect(rejectionIndex).toBeGreaterThan(uncaughtIndex);
    expect(mainIndex).toBeGreaterThan(rejectionIndex);
    expect(cliSource.slice(uncaughtIndex, rejectionIndex)).toContain('process.exit(1);');
    expect(cliSource.slice(rejectionIndex, mainIndex)).toContain('process.exit(1);');
  });

  it('emits versioned status JSON for initialized projects', () => {
    const result = runCli(['status', '--json', testDir]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(result.stderr).toBe('');
    expectNoTerminalFrames(result.stdout);

    expect(parsed).toMatchObject({
      schemaVersion: 'solidkg.status.v1',
      initialized: true,
      projectPath: testDir,
      counts: {
        files: expect.any(Number),
        nodes: expect.any(Number),
        edges: expect.any(Number),
        semanticRelations: expect.any(Number),
      },
      semanticRelations: {
        total: expect.any(Number),
        byKind: expect.any(Object),
      },
      backend: expect.any(String),
      journalMode: expect.any(String),
      solidkgVersion: packageJson.version,
      scip: expect.any(Object),
    });
    expect(parsed.fileCount).toBe(parsed.counts.files);
    expect(parsed.nodeCount).toBe(parsed.counts.nodes);
    expect(parsed.edgeCount).toBe(parsed.counts.edges);
  });

  it('emits plain non-TTY human status output without ANSI escapes', () => {
    const result = runCli(['status', testDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SolidKG Status');
    expect(result.stdout).toContain('Project:');
    expectNoAnsiEscapeSequences(result.stdout);
    expectNoAnsiEscapeSequences(result.stderr);
    expectNoTerminalFrames(result.stdout);
    expectNoTerminalFrames(result.stderr);
  });

  it('renders human query scores as raw relevance scores instead of percentages', () => {
    const result = runCli(['query', 'entry', '--path', testDir]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Search Results for "entry"');
    expect(result.stdout).toContain('score ');
    expect(result.stdout).not.toMatch(/\(\d+%\)/);
    expectNoAnsiEscapeSequences(result.stdout);
    expectNoTerminalFrames(result.stdout);
  });

  it('renders indexed repository overview through files command', () => {
    const result = runCli(['files', '--path', testDir, '--format', 'overview', '--max-depth', '2']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('## Repository Overview');
    expect(result.stdout).toContain('src/');
    expect(result.stdout).toContain('service.ts');
    expect(result.stdout).toContain('symbols');
    expectNoAnsiEscapeSequences(result.stdout);
    expectNoTerminalFrames(result.stdout);
  });

  it('renders indexed repository overview through overview command', () => {
    const result = runCli(['overview', testDir, '--max-depth', '2']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('## Repository Overview');
    expect(result.stdout).toContain('src/');
    expect(result.stdout).toContain('service.ts');
    expect(result.stdout).toContain('symbols');
    expectNoAnsiEscapeSequences(result.stdout);
    expectNoTerminalFrames(result.stdout);
  });

  it('architecture health emits API-equivalent clean JSON and bounded human output', async () => {
    const layers = [{ name: 'source', paths: ['src/**'] }];
    const readOnly = await SolidKG.open(testDir, { readOnly: true });
    let expected: unknown;
    try {
      expected = readOnly.getArchitectureHealth({ layers });
      const db = (readOnly as unknown as { db: { getDb(): { prepare(sql: string): { run(): void } } } }).db.getDb();
      expect(() => db.prepare('CREATE TABLE cli_read_only_rejection (id INTEGER)').run()).toThrow();
    } finally {
      readOnly.destroy();
    }

    const json = runCli(['architecture', 'health', '--path', testDir, '--layers', JSON.stringify(layers), '--json']);
    const human = runCli(['architecture', 'health', '--path', testDir, '--layers', JSON.stringify(layers)]);

    expect(json.status).toBe(0);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toEqual(expected);
    expectNoAnsiEscapeSequences(json.stdout);
    expectNoTerminalFrames(json.stdout);
    expect(human.status).toBe(0);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain('## Architecture Health');
    expectNoAnsiEscapeSequences(human.stdout);
    expectNoTerminalFrames(human.stdout);
  });

  it.each([
    { command: ['architecture', 'health'], name: 'architecture health' },
    { command: ['snapshot', 'drift', 'baseline'], name: 'snapshot drift' },
  ])('$name reports schema 10 remediation without changing database bytes', async ({ command }) => {
    const writable = await SolidKG.open(testDir);
    try {
      const db = (writable as unknown as { db: { getDb(): { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): void } } } }).db.getDb();
      db.exec('DELETE FROM schema_versions');
      db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(10, Date.now(), 'test schema');
    } finally {
      writable.destroy();
    }
    const dbPath = getDatabasePath(testDir);
    const before = fs.readFileSync(dbPath);
    const result = runCli([...command, '--path', testDir, '--json']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('SolidKG schema 10 must be upgraded to 11 before architecture health or snapshot drift can be read. Run "solidkg sync <project>" once with write access, then retry.\n');
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });

  it('snapshot create layers persists normalized options for API-equivalent drift', async () => {
    const layers = [{ name: 'source', paths: ['./src/**', 'src/**'] }];
    const create = runCli(['snapshot', 'create', 'baseline', '--path', testDir, '--layers', JSON.stringify(layers), '--json']);

    expect(create.status).toBe(0);
    expect(create.stderr).toBe('');
    expect(JSON.parse(create.stdout)).toMatchObject({ label: 'baseline' });

    fs.appendFileSync(path.join(testDir, 'src', 'service.ts'), 'export const changed = entry();\n');
    const writable = await SolidKG.open(testDir);
    try {
      await writable.sync();
    } finally {
      writable.destroy();
    }
    const readOnly = await SolidKG.open(testDir, { readOnly: true });
    let expected: unknown;
    try {
      expected = await readOnly.getSnapshotHealthDrift('baseline');
    } finally {
      readOnly.destroy();
    }

    const drift = runCli(['snapshot', 'drift', 'baseline', '--path', testDir, '--json']);

    expect(drift.status).toBe(0);
    expect(drift.stderr).toBe('');
    expect(JSON.parse(drift.stdout)).toEqual(expected);
    expectNoAnsiEscapeSequences(drift.stdout);
    expectNoTerminalFrames(drift.stdout);
  });

  it('snapshot drift rejects layers and architecture health rejects malformed layers', () => {
    const drift = runCli(['snapshot', 'diff', 'baseline', '--path', testDir, '--layers', '[]']);
    const malformed = runCli(['architecture', 'health', '--path', testDir, '--layers', '[']);
    const duplicate = runCli(['architecture', 'health', '--path', testDir, '--layers', '[{"name":"source","paths":["src/**"]},{"name":"source","paths":["lib/**"]}]']);

    expect(drift.status).toBe(1);
    expect(drift.stdout).toBe('');
    expect(drift.stderr).toContain('--layers is only supported for snapshot create');
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toContain('layersJson is invalid JSON:');
    expect(duplicate.status).toBe(1);
    expect(duplicate.stdout).toBe('');
    expect(duplicate.stderr).toContain('duplicate layer name: source');
  });

  it('rejects too many overview expand paths through files command', () => {
    const args = ['files', '--path', testDir, '--format', 'overview'];
    for (let index = 0; index < 51; index += 1) {
      args.push('--expand', `src/${index}`);
    }

    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Too many --expand paths. Expected at most 50.');
  });

  it('rejects too many overview expand paths through overview command', () => {
    const args = ['overview', testDir];
    for (let index = 0; index < 51; index += 1) {
      args.push('--expand', `src/${index}`);
    }

    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Too many --expand paths. Expected at most 50.');
  });

  it('emits versioned status JSON for uninitialized projects', () => {
    const uninitialized = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-uninit-'));
    try {
      const result = runCli(['status', '--json', uninitialized]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expectNoTerminalFrames(result.stdout);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 'solidkg.status.v1',
        initialized: false,
        projectPath: uninitialized,
        counts: {
          files: 0,
          nodes: 0,
          edges: 0,
          semanticRelations: 0,
        },
        backend: null,
        journalMode: null,
        scip: null,
      });
    } finally {
      fs.rmSync(uninitialized, { recursive: true, force: true });
    }
  });

  it('emits versioned context JSON without changing markdown mode', () => {
    const jsonResult = runCli(['context', 'entry helper', '--format', 'json', '--path', testDir, '--max-code', '4']);
    expect(jsonResult.status).toBe(0);
    const parsed = JSON.parse(jsonResult.stdout);
    expect(jsonResult.stderr).toBe('');
    expectNoTerminalFrames(jsonResult.stdout);
    expect(parsed.schemaVersion).toBe('solidkg.context.v1');
    expect(parsed.solidkgVersion).toBe(packageJson.version);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.stats).toEqual(expect.objectContaining({ nodeCount: expect.any(Number) }));
    expectSourceCompletenessMetadata(parsed.sourceCompleteness);
    expect(parsed.contextBudget).toEqual(expect.objectContaining({
      estimated: true,
      baselineKind: expect.any(String),
    }));
    expect(ALLOWED_CONTEXT_BUDGET_BASELINES).toContain(parsed.contextBudget.baselineKind);
    expect(parsed.contextBudget.baselineKind).not.toBe('whole_repo');
    expect(parsed.answerPacket).toMatchObject({
      schemaVersion: 'solidkg.answer-packet.v1',
      sufficiency: {
        canAnswerFromReturnedContext: true,
      },
    });
    expect(parsed.answerPacket.evidence[0].sourceAnchor).toEqual(expect.objectContaining({
      filePath: expect.any(String),
      startLine: expect.any(Number),
      endLine: expect.any(Number),
    }));
    expect(parsed.answerPacket.rankingReasons.length).toBeGreaterThan(0);

    const markdownResult = runCli(['context', 'entry helper', '--path', testDir, '--max-code', '4']);
    expect(markdownResult.status).toBe(0);
    expect(markdownResult.stdout).toContain('## Code Context');
    expect(markdownResult.stdout).toContain('### Answer Packet');
    expect(markdownResult.stdout).not.toContain('schemaVersion');
    expectNoTerminalFrames(markdownResult.stdout);
  });

  it('supports minimal context detail with explicit code opt-in', () => {
    const minimalResult = runCli(['context', 'entry helper', '--format', 'json', '--detail', 'minimal', '--path', testDir]);
    expect(minimalResult.status).toBe(0);
    const minimal = JSON.parse(minimalResult.stdout);
    expect(minimalResult.stderr).toBe('');
    expectNoTerminalFrames(minimalResult.stdout);
    expect(minimal.schemaVersion).toBe('solidkg.context.v1');
    expect(minimal.solidkgVersion).toBe(packageJson.version);
    expect(minimal.detailLevel).toBe('minimal');
    expectSourceCompletenessMetadata(minimal.sourceCompleteness);
    expect(minimal.codeBlocks).toEqual([]);
    expect(minimal.suggestedTools.some((tool: string) => tool.includes('solidkg_explore'))).toBe(true);
    expect(minimal.contextBudget).toEqual(expect.objectContaining({
      estimated: true,
      baselineKind: expect.any(String),
    }));
    expect(ALLOWED_CONTEXT_BUDGET_BASELINES).toContain(minimal.contextBudget.baselineKind);
    expect(minimal.contextBudget.baselineKind).not.toBe('whole_repo');

    const explicitCodeResult = runCli(['context', 'entry helper', '--format', 'json', '--detail', 'minimal', '--path', testDir, '--max-code', '1']);
    expect(explicitCodeResult.status).toBe(0);
    const explicitCode = JSON.parse(explicitCodeResult.stdout);
    expect(explicitCode.detailLevel).toBe('minimal');
    expect(explicitCode.codeBlocks.length).toBeGreaterThan(0);
  });

  it('rejects invalid context detail values clearly', () => {
    const result = runCli(['context', 'entry helper', '--detail', 'verbose', '--path', testDir]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid context detail "verbose"');
    expect(result.stderr.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result.stderr).not.toContain('Error: Invalid context detail');
    expect(result.stderr).not.toContain('Command.parseOptions');
    expect(result.stderr).not.toContain('at ');
    expect(result.stderr).not.toContain('graph console');
    expectNoAnsiEscapeSequences(result.stderr);
  });

  it('rejects invalid context budget values clearly', () => {
    const invalidMaxNodes = runCli(['context', 'entry helper', '--path', testDir, '--max-nodes', 'abc']);
    expect(invalidMaxNodes.status).not.toBe(0);
    expect(invalidMaxNodes.stdout).toBe('');
    expect(invalidMaxNodes.stderr).toContain('Invalid context max nodes "abc"');
    expectNoAnsiEscapeSequences(invalidMaxNodes.stderr);

    const unsafeMaxCode = runCli(['context', 'entry helper', '--path', testDir, '--max-code', '10000']);
    expect(unsafeMaxCode.status).not.toBe(0);
    expect(unsafeMaxCode.stdout).toBe('');
    expect(unsafeMaxCode.stderr).toContain('Invalid context max code blocks "10000"');
    expectNoAnsiEscapeSequences(unsafeMaxCode.stderr);
  });

  it('rejects invalid query limit and kind values clearly', () => {
    const invalidLimit = runCli(['query', 'entry', '--path', testDir, '--limit', 'abc']);
    expect(invalidLimit.status).not.toBe(0);
    expect(invalidLimit.stdout).toBe('');
    expect(invalidLimit.stderr).toContain('Invalid query limit "abc"');
    expectNoAnsiEscapeSequences(invalidLimit.stderr);

    const invalidKind = runCli(['query', 'entry', '--path', testDir, '--kind', 'banana']);
    expect(invalidKind.status).not.toBe(0);
    expect(invalidKind.stdout).toBe('');
    expect(invalidKind.stderr).toContain('Invalid node kind "banana"');
    expectNoAnsiEscapeSequences(invalidKind.stderr);
  });

  it('rejects invalid indexing byte sizes clearly', () => {
    const result = runCli(['index', testDir, '--max-file-size', 'nope']);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid size "nope"');
    expect(result.stderr).not.toContain('Unhandled rejection');
    expect(result.stderr).not.toContain(' at ');
    expectNoAnsiEscapeSequences(result.stderr);
  });

  it('normalizes affected file inputs before traversing dependents', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'service.test.ts'),
      `import { entry } from './service';
it('uses entry', () => { entry(); });
`
    );
    cg = SolidKG.openSync(testDir);
    await cg.indexAll();
    cg.destroy();
    cg = undefined;

    const dotRelative = runCli(['affected', './src/service.ts', '--path', testDir, '--json']);
    expect(dotRelative.status).toBe(0);
    expect(dotRelative.stderr).toBe('');
    expect(JSON.parse(dotRelative.stdout)).toMatchObject({
      changedFiles: ['src/service.ts'],
      affectedTests: ['src/service.test.ts'],
    });

    const absolute = runCli(['affected', path.join(testDir, 'src', 'service.ts'), '--path', testDir, '--quiet']);
    expect(absolute.status).toBe(0);
    expect(absolute.stderr).toBe('');
    expect(nonEmptyLines(absolute.stdout)).toEqual(['src/service.test.ts']);

    const stdin = runCli(['affected', '--path', testDir, '--stdin', '--json'], undefined, './src/service.ts\n');
    expect(stdin.status).toBe(0);
    expect(stdin.stderr).toBe('');
    expect(JSON.parse(stdin.stdout)).toMatchObject({
      changedFiles: ['src/service.ts'],
      affectedTests: ['src/service.test.ts'],
    });
  });

  it('sync success is one concise final line when already current', () => {
    const result = runCli(['sync', testDir]);
    const lines = nonEmptyLines(result.stderr);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('SolidKG synced: already up to date');
    expect(result.stderr).not.toContain('Syncing SolidKG');
    expect(result.stderr).not.toContain('Already up to date\nDone');
    expect(result.stderr).not.toContain('Done');
    expectNoTerminalFrames(result.stderr);
    expectNoAnsiEscapeSequences(result.stderr);
  });

  it('sync changed-file success is one concise line with progress suppressed outside TTY', () => {
    fs.writeFileSync(path.join(testDir, 'src', 'new-service.ts'), 'export const value = 1;\n');

    const result = runCli(['sync', testDir]);
    const lines = nonEmptyLines(result.stderr);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SolidKG synced: 1 changed file');
    expect(lines[0]).not.toMatch(/^(success|status):/);
    expect(lines[0]).toContain('1 added file');
    expect(lines[0]).toContain('nodes');
    expect(result.stderr).not.toContain('Syncing SolidKG');
    expect(result.stderr).not.toContain('Done');
    expectNoTerminalFrames(result.stderr);
    expectNoAnsiEscapeSequences(result.stderr);
  });

  it('index success is one concise final line with progress suppressed outside TTY', () => {
    const result = runCli(['index', testDir, '--include', '**/*.ts']);
    const lines = nonEmptyLines(result.stderr);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SolidKG indexed 1 file');
    expect(lines[0]).not.toMatch(/^(success|status):/);
    expect(lines[0]).toContain('nodes');
    expect(result.stderr).not.toContain('Indexing project');
    expect(result.stderr).not.toContain('Done');
    expectNoTerminalFrames(result.stderr);
    expectNoAnsiEscapeSequences(result.stderr);
  });

  it('persists a terminal lifecycle diagnostic across index CLI output modes', () => {
    // Given
    const dataDir = path.join(testDir, '.solidkg');
    const diagnosticPath = path.join(dataDir, 'index-lifecycle.json');
    const modes = [
      ['index', testDir, '--quiet'],
      ['index', testDir, '--profile-json'],
      ['index', testDir],
      ['index', testDir, '--verbose'],
    ];

    // When
    for (const args of modes) {
      const result = runCli(args);

      // Then
      expect(result.status).toBe(0);
      const diagnostic: unknown = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
      expect(diagnostic).toMatchObject({
        schemaVersion: 'solidkg.indexLifecycleDiagnostic.v1',
        operation: 'indexAll',
        status: 'succeeded',
        counts: {
          filesScanned: expect.any(Number),
          filesIndexed: expect.any(Number),
          filesSkipped: expect.any(Number),
          filesErrored: expect.any(Number),
          nodesCreated: expect.any(Number),
          edgesCreated: expect.any(Number),
        },
        activeResources: expect.any(Array),
        process: { pid: expect.any(Number), runtime: 'node' },
      });
      expect(fs.readdirSync(dataDir).filter((entry) => entry.startsWith('index-lifecycle.json.'))).toEqual([]);
    }
  });

  it('init with indexing emits one concise success line on normal success', () => {
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-init-terse-'));
    try {
      fs.writeFileSync(path.join(initDir, 'service.ts'), 'export const value = 1;\n');
      const result = runCli(['init', '-i', initDir, '--include', '**/*.ts']);
      const lines = nonEmptyLines(result.stderr);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('SolidKG initialized and indexed 1 file');
      expect(lines[0]).not.toMatch(/^(success|status):/);
      expect(lines[0]).toContain('nodes');
      expect(result.stderr).not.toContain('Initializing SolidKG');
      expect(result.stderr).not.toContain('Data directory:');
      expect(result.stderr).not.toContain('Done');
      expect(fs.existsSync(path.join(initDir, '.solidkg', 'errors.log'))).toBe(false);
      expectNoTerminalFrames(result.stderr);
      expectNoAnsiEscapeSequences(result.stderr);
    } finally {
      fs.rmSync(initDir, { recursive: true, force: true });
    }
  });

  it('persists a successful lifecycle diagnostic when init indexes a project', () => {
    // Given: a new project initialized and indexed through the public CLI lifecycle.
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-init-lifecycle-'));
    try {
      fs.writeFileSync(path.join(initDir, 'service.ts'), 'export const value = 1;\n');

      // When: init performs its optional indexing pass.
      const result = runCli(['init', '-i', initDir, '--include', '**/*.ts']);
      const dataDir = path.join(initDir, '.solidkg');
      const diagnosticPath = path.join(dataDir, 'index-lifecycle.json');

      // Then: init produces the same completed index diagnostic contract as index.
      expect(result.status).toBe(0);
      const diagnostic: unknown = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
      expect(diagnostic).toMatchObject({
        schemaVersion: 'solidkg.indexLifecycleDiagnostic.v1',
        operation: 'indexAll',
        status: 'succeeded',
        counts: {
          filesScanned: expect.any(Number),
          filesIndexed: expect.any(Number),
          filesSkipped: expect.any(Number),
          filesErrored: expect.any(Number),
          nodesCreated: expect.any(Number),
          edgesCreated: expect.any(Number),
        },
        activeResources: expect.any(Array),
        process: { pid: expect.any(Number), runtime: 'node' },
        completedAt: expect.any(String),
      });
      expect(fs.readdirSync(dataDir).filter((entry) => entry.startsWith('index-lifecycle.json.'))).toEqual([]);
    } finally {
      fs.rmSync(initDir, { recursive: true, force: true });
    }
  });

  it('init with indexing keeps skipped files visible as one compact extra line', () => {
    const initDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-cli-init-skip-terse-'));
    try {
      fs.writeFileSync(path.join(initDir, 'small.ts'), 'export const x=1;\n');
      fs.writeFileSync(path.join(initDir, 'large.ts'), `export const large = '${'x'.repeat(100)}';\n`);
      const result = runCli(['init', '-i', initDir, '--include', '**/*.ts', '--max-file-size', '20b']);
      const lines = nonEmptyLines(result.stderr);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('SolidKG initialized and indexed 1 file');
      expect(lines[0]).not.toMatch(/^(success|status):/);
      expect(lines[1]).toContain('Skipped 1 file over max size');
      expect(lines[1]).not.toMatch(/^(success|status|note):/);
      expect(result.stderr).not.toContain('note: Skipped files');
      expect(result.stderr).not.toContain('Data directory:');
      expect(result.stderr).not.toContain('Done');
      expectNoTerminalFrames(result.stderr);
      expectNoAnsiEscapeSequences(result.stderr);
    } finally {
      fs.rmSync(initDir, { recursive: true, force: true });
    }
  });
});
