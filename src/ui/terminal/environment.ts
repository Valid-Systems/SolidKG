import type { TerminalEnvironment, TerminalPresenterOptions, TerminalStream } from './types';

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

function hasNoColor(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR !== undefined;
}

function resolveTTY(options: TerminalPresenterOptions, stdout: TerminalStream, stderr: TerminalStream): boolean {
  if (options.isTTY !== undefined) return options.isTTY;
  return stdout.isTTY === true || stderr.isTTY === true;
}

export function createTerminalEnvironment(options: TerminalPresenterOptions = {}): TerminalEnvironment {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const quiet = options.quiet === true;
  const isTTY = resolveTTY(options, stdout, stderr);
  const ci = isTruthyFlag(env.CI);
  const term = env.TERM;
  const plain = !isTTY || ci || term?.toLowerCase() === 'dumb' || hasNoColor(env);

  return {
    mode: quiet ? 'silent' : plain ? 'plain' : 'interactive-tty',
    isTTY,
    ci,
    term,
    noColor: hasNoColor(env),
    quiet,
  };
}
