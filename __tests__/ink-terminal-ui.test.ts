import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTerminalPresenter,
  renderProgressCompletionText,
  renderGraphProgressText,
} from '../src/ui/terminal';
import type { ProgressCompletionSummary } from '../src/ui/terminal';
import type { IndexProgress } from '../src/extraction';

function createCaptureStream(isTTY: boolean): { isTTY: boolean; chunks: string[]; write(chunk: string): boolean } {
  const chunks: string[] = [];

  return {
    isTTY,
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
}

function expectNoInkControlOutput(output: string): void {
  expect(output).not.toContain('\u001B[');
  expect(output).not.toContain('graph console');
  expect(output).not.toContain('ledger ');
  expect(output).not.toContain('index graph facts');
}

const PHASE_PROGRESS: IndexProgress[] = [
  { phase: 'scanning', current: 3, total: 10 },
  { phase: 'parsing', current: 4, total: 10 },
  { phase: 'storing', current: 7, total: 10 },
  { phase: 'scip', current: 2, total: 0 },
  { phase: 'resolving', current: 10, total: 10 },
  { phase: 'synthesis', current: 2, total: 2 },
];

const EXPECTED_PHASE_LABELS = [
  'Scanning files',
  'Parsing code',
  'Saving graph',
  'SCIP indexing',
  'Linking references',
  'Synthesizing relations',
];

describe('terminal presenter without Ink', () => {
  it('non-TTY uses plain presenter', () => {
    const stdout = createCaptureStream(false);
    const stderr = createCaptureStream(false);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env: {},
      isTTY: false,
    });

    expect(presenter.environment.mode).toBe('plain');
    expect(presenter.environment.isTTY).toBe(false);
    expect(presenter.environment.quiet).toBe(false);
  });

  it('quiet mode returns silent output', async () => {
    const stdout = createCaptureStream(true);
    const stderr = createCaptureStream(true);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env: {},
      isTTY: true,
      quiet: true,
    });

    expect(presenter.environment.mode).toBe('silent');

    const progress = presenter.progress();
    progress.onProgress({ phase: 'scanning', current: 1, total: 10 });
    await progress.stop('done');

    presenter.intro('hello');
    presenter.status('world');
    presenter.warn('warn');
    presenter.error('error');
    presenter.success('done');
    await presenter.prompt('prompt');

    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks).toEqual([]);
  });

  it('plain presenter writes human output and progress to injected stderr only', async () => {
    const stdout = createCaptureStream(false);
    const stderr = createCaptureStream(false);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env: {},
      isTTY: false,
    });

    presenter.intro('start');
    presenter.message('plain message');
    presenter.status('checking graph');
    presenter.note('next step', 'setup');
    presenter.warn('heads up');
    presenter.error('bad input');
    presenter.success('finished');
    await presenter.prompt('prompt text');
    await expect(presenter.confirm({ message: 'continue?', initialValue: false })).resolves.toBe(false);
    await expect(presenter.select({
      message: 'choose one',
      options: [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b', hint: 'default' }],
      initialValue: 'b',
    })).resolves.toBe('b');
    await expect(presenter.multiSelect({
      message: 'choose many',
      options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }],
      initialValues: [2],
    })).resolves.toEqual([2]);

    const spinner = presenter.spinner('installing');
    spinner.start();
    spinner.start('ignored duplicate');
    await spinner.stop('installed');

    const progress = presenter.progress();
    progress.onProgress({ phase: 'scanning', current: 1, total: 2 });
    await progress.stop();
    progress.onProgress({ phase: 'parsing', current: 2, total: 2 });

    const output = stderr.chunks.join('');
    expect(stdout.chunks).toEqual([]);
    expect(output).toContain('start');
    expect(output).toContain('plain message');
    expect(output).toContain('status: checking graph');
    expect(output).toContain('note: setup\nnext step');
    expect(output).toContain('warn: heads up');
    expect(output).toContain('error: bad input');
    expect(output).toContain('success: finished');
    expect(output).toContain('continue? [no]');
    expect(output).toContain('selected: Beta (default)');
    expect(output).toContain('selected: Two');
    expect(output).toContain('spinner: installing');
    expect(output).not.toContain('ignored duplicate');
    expect(output).toContain('installed');
    expect(output).toContain('progress: scanning 1/2');
    expect(output).not.toContain('progress: parsing 2/2');
    expectNoInkControlOutput(output);
  });

  it('interactive TTY updates progress in place instead of logging every event', async () => {
    const stdout = createCaptureStream(true);
    const stderr = createCaptureStream(true);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env: {},
      isTTY: true,
    });

    const progress = presenter.progress();
    progress.onProgress({ phase: 'resolving', current: 8, total: 10 });
    progress.onProgress({ phase: 'resolving', current: 9, total: 10 });
    await progress.stop('indexed');

    const output = stderr.chunks.join('');
    expect(presenter.environment.mode).toBe('interactive-tty');
    expect(presenter.environment.isTTY).toBe(true);
    expect(stdout.chunks).toEqual([]);
    expect(output).toContain('SolidKG');
    expect(output).toContain('Linking references');
    expect(output).toContain('indexed');
    expect(output).not.toContain('progress:');
    expect(output.match(/\n/g)?.length ?? 0).toBe(1);
    expect(output.match(/\r/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expectNoInkControlOutput(output);
  });

  it.each([
    ['CI', { CI: '1' }],
    ['TERM=dumb', { TERM: 'dumb' }],
    ['NO_COLOR', { NO_COLOR: '1' }],
  ])('%s uses plain presenter', (_label, env) => {
    const stdout = createCaptureStream(true);
    const stderr = createCaptureStream(true);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env,
      isTTY: true,
    });

    expect(presenter.environment.mode).toBe('plain');
  });

  it.each([
    ['TERM=dumb', { TERM: 'dumb' }],
    ['NO_COLOR=1', { NO_COLOR: '1' }],
  ])('%s keeps progress in plain stderr output with no Ink frames', async (_label, env) => {
    const stdout = createCaptureStream(true);
    const stderr = createCaptureStream(true);

    const presenter = createTerminalPresenter({
      stdout,
      stderr,
      env,
      isTTY: true,
    });

    const progress = presenter.progress();
    progress.onProgress({ phase: 'resolving', current: 8, total: 10 });
    await progress.stop();

    const output = stderr.chunks.join('');
    expect(presenter.environment.mode).toBe('plain');
    expect(stdout.chunks).toEqual([]);
    expect(output).toContain('progress: resolving 8/10');
    expectNoInkControlOutput(output);
  });

  it('renders single-line progress labels', () => {
    const textFrames = PHASE_PROGRESS.map((progress) => renderGraphProgressText(progress, { frame: 0, unicode: true })).join('\n');

    for (const label of EXPECTED_PHASE_LABELS) {
      expect(textFrames).toContain(label);
    }

    expect(renderGraphProgressText({ phase: 'scip', current: 0, total: 0 }, { frame: 0, unicode: true })).toBe('◐ SolidKG ▸ SCIP indexing · [──────────] starting');
    expect(renderGraphProgressText({ phase: 'scanning', current: 3, total: 10 }, { frame: 0, unicode: true })).toBe('◐ SolidKG ▸ Scanning files · [━━━───────] 3/10 30%');
    expect(renderGraphProgressText({ phase: 'scip', current: 0, total: 0 }, { frame: 0, unicode: false })).toBe('o SolidKG > SCIP indexing - [----------] starting');
    expect(renderGraphProgressText({ phase: 'scanning', current: 3, total: 10 }, { frame: 0, unicode: true })).not.toContain('\n');
  });

  it('renders a single-line completion receipt', () => {
    const summary: ProgressCompletionSummary = {
      status: 'success',
      title: 'complete',
      segments: ['initialized and indexed 101 files', '3,575 nodes', '12,504 edges', '1.3s', '0 errors', '0 warnings'],
    };

    expect(renderProgressCompletionText(summary, { unicode: true })).toBe('◆ SolidKG complete · initialized and indexed 101 files · 3,575 nodes · 12,504 edges · 1.3s · 0 errors · 0 warnings');
    expect(renderProgressCompletionText(summary, { unicode: false })).toBe('* SolidKG complete - initialized and indexed 101 files - 3,575 nodes - 12,504 edges - 1.3s - 0 errors - 0 warnings');
  });

  it('writes completion summaries when progress stops', async () => {
    const stdout = createCaptureStream(true);
    const stderr = createCaptureStream(true);
    const presenter = createTerminalPresenter({ stdout, stderr, env: {}, isTTY: true });
    const progress = presenter.progress();
    const summary: ProgressCompletionSummary = {
      status: 'success',
      title: 'complete',
      segments: ['indexed 1 file', '2 nodes'],
    };

    progress.onProgress({ phase: 'parsing', current: 1, total: 2 });
    await progress.stop(summary);

    const output = stderr.chunks.join('');
    expect(stdout.chunks).toEqual([]);
    expect(output).toContain('SolidKG');
    expect(output).toContain('Parsing code');
    expect(output).toContain('SolidKG complete');
    expect(output).toContain('indexed 1 file');
    expect(output).not.toContain('progress:');
    expect(output.match(/\n/g)?.length ?? 0).toBe(1);
    expectNoInkControlOutput(output);
  });

  it('keeps narrow terminal rendering readable', () => {
    const frame = renderGraphProgressText(
      { phase: 'scanning', current: 1, total: 100 },
      { unicode: false, columns: 24 },
    );

    expect(frame).toBe('o SolidKG > Scanning ~');
    expect(frame).not.toContain('undefined');
    expect(frame).toMatch(/^[\x00-\x7F]*$/);
  });

  it('renders only seven bit characters when unicode is disabled', () => {
    const combined = [
      renderGraphProgressText({ phase: 'scip', current: 12, total: 0 }, { frame: 0, unicode: false }),
      renderProgressCompletionText({ status: 'warning', title: 'complete', segments: ['1 warning'] }, { unicode: false }),
    ].join('\n');

    expect(combined).toContain('SCIP indexing');
    expect(combined).toMatch(/^[\x00-\x7F\n]*$/);
  });

  it('keeps before and after status lines intact around synchronous blocking work', async () => {
    const stdout = createCaptureStream(false);
    const stderr = createCaptureStream(false);
    const presenter = createTerminalPresenter({ stdout, stderr, env: {}, isTTY: false });
    const progress = presenter.progress();

    presenter.status('before blocking sync');
    progress.onProgress({ phase: 'parsing', current: 1, total: 2 });
    for (let i = 0; i < 50_000; i++) {
      Math.sqrt(i);
    }
    progress.onProgress({ phase: 'storing', current: 2, total: 2 });
    presenter.status('after blocking sync');
    await progress.stop();

    const output = stderr.chunks.join('');
    expect(stdout.chunks).toEqual([]);
    expect(output).toMatch(/status: before blocking sync[\s\S]*progress: parsing 1\/2[\s\S]*progress: storing 2\/2[\s\S]*status: after blocking sync/);
    expectNoInkControlOutput(output);
  });

  it('does not declare Ink or React terminal dependencies', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).not.toHaveProperty('ink');
    expect(packageJson.dependencies ?? {}).not.toHaveProperty('react');
    expect(packageJson.devDependencies ?? {}).not.toHaveProperty('ink-testing-library');
    expect(packageJson.devDependencies ?? {}).not.toHaveProperty('@types/react');
  });
});
