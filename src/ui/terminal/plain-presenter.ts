import { supportsUnicode } from '../glyphs';
import { renderGraphProgressText, renderProgressCompletionText } from './components';
import type {
  ConfirmPromptOptions,
  MultiSelectPromptOptions,
  PromptOption,
  ProgressCompletion,
  ProgressPresenter,
  SelectPromptOptions,
  SpinnerPresenter,
  TerminalEnvironment,
  TerminalPresenter,
  TerminalPresenterOptions,
  TerminalStream,
} from './types';

type StreamPair = {
  stdout: TerminalStream;
  stderr: TerminalStream;
};

function writeLine(stream: TerminalStream, message: string): void {
  stream.write(`${message}\n`);
}

function formatProgressLine(phase: string, current: number, total: number): string {
  if (total > 0) {
    return `progress: ${phase} ${current}/${total}`;
  }

  if (current > 0) {
    return `progress: ${phase} ${current}`;
  }

  return `progress: ${phase}`;
}

function createNoopProgressPresenter(): ProgressPresenter {
  return {
    onProgress() {},
    async stop() {},
  };
}

function createSilentSpinner(): SpinnerPresenter {
  return {
    start() {},
    async stop() {},
  };
}

function createPlainProgressPresenter(streams: StreamPair): ProgressPresenter {
  let stopped = false;

  return {
    onProgress(progress) {
      if (stopped) return;
      writeLine(streams.stderr, formatProgressLine(progress.phase, progress.current, progress.total));
    },
    async stop(finalCompletion?: ProgressCompletion) {
      if (stopped) return;
      stopped = true;
      if (typeof finalCompletion === 'string') {
        writeLine(streams.stderr, finalCompletion);
      } else if (finalCompletion) {
        writeLine(streams.stderr, renderProgressCompletionText(finalCompletion, { unicode: false }));
      }
    },
  };
}

function createInteractiveProgressPresenter(streams: StreamPair): ProgressPresenter {
  let stopped = false;
  let frame = 0;
  let active = false;
  let lastLength = 0;
  const unicode = supportsUnicode();

  function writeDynamicLine(line: string): void {
    const padding = lastLength > line.length ? ' '.repeat(lastLength - line.length) : '';
    streams.stderr.write(`\r${line}${padding}`);
    lastLength = line.length;
    active = true;
  }

  function writeFinalLine(line: string): void {
    const padding = lastLength > line.length ? ' '.repeat(lastLength - line.length) : '';
    streams.stderr.write(`${active ? '\r' : ''}${line}${padding}\n`);
    active = false;
    lastLength = 0;
  }

  return {
    onProgress(progress) {
      if (stopped) return;
      writeDynamicLine(renderGraphProgressText(progress, {
        frame: frame++,
        unicode,
        columns: streams.stderr.columns,
      }));
    },
    async stop(finalCompletion?: ProgressCompletion) {
      if (stopped) return;
      stopped = true;
      if (typeof finalCompletion === 'string') {
        writeFinalLine(finalCompletion);
      } else if (finalCompletion) {
        writeFinalLine(renderProgressCompletionText(finalCompletion, {
          unicode,
          columns: streams.stderr.columns,
        }));
      } else if (active) {
        writeFinalLine('');
      }
    },
  };
}

function createPlainSpinner(streams: StreamPair, message: string): SpinnerPresenter {
  let active = false;

  return {
    start(nextMessage = message) {
      if (active) return;
      active = true;
      writeLine(streams.stderr, `spinner: ${nextMessage}`);
    },
    async stop(doneMessage) {
      if (!active) return;
      active = false;
      if (doneMessage) {
        writeLine(streams.stderr, doneMessage);
      }
    },
  };
}

function createPlainPrompt(streams: StreamPair, message: string): Promise<string | undefined> {
  writeLine(streams.stderr, message);
  return Promise.resolve(undefined);
}

function formatPromptOption<Value>(option: PromptOption<Value>): string {
  return option.hint ? `${option.label} (${option.hint})` : option.label;
}

function createPlainConfirm(streams: StreamPair, options: ConfirmPromptOptions): Promise<boolean | undefined> {
  const initial = options.initialValue ?? true;
  writeLine(streams.stderr, `${options.message} [${initial ? 'yes' : 'no'}]`);
  return Promise.resolve(initial);
}

function createPlainSelect<Value>(streams: StreamPair, options: SelectPromptOptions<Value>): Promise<Value | undefined> {
  const initialOption = options.options.find((option) => Object.is(option.value, options.initialValue)) ?? options.options[0];
  writeLine(streams.stderr, options.message);
  if (initialOption) {
    writeLine(streams.stderr, `selected: ${formatPromptOption(initialOption)}`);
    return Promise.resolve(initialOption.value);
  }

  return Promise.resolve(undefined);
}

function createPlainMultiSelect<Value>(streams: StreamPair, options: MultiSelectPromptOptions<Value>): Promise<Value[] | undefined> {
  const initialValues = options.initialValues ?? [];
  const selected = options.options.filter((option) => initialValues.some((value) => Object.is(value, option.value)));

  writeLine(streams.stderr, options.message);
  if (selected.length > 0) {
    writeLine(streams.stderr, `selected: ${selected.map(formatPromptOption).join(', ')}`);
    return Promise.resolve(selected.map((option) => option.value));
  }

  if (options.required && options.options[0]) {
    writeLine(streams.stderr, `selected: ${formatPromptOption(options.options[0])}`);
    return Promise.resolve([options.options[0].value]);
  }

  writeLine(streams.stderr, 'selected: none');
  return Promise.resolve([]);
}

function createOutputPresenter(environment: TerminalEnvironment, streams: StreamPair): TerminalPresenter {
  return {
    environment,
    intro(message: string) {
      writeLine(streams.stderr, message);
    },
    outro(message: string) {
      writeLine(streams.stderr, message);
    },
    message(message: string) {
      writeLine(streams.stderr, message);
    },
    status(message: string) {
      writeLine(streams.stderr, `status: ${message}`);
    },
    note(message: string, title?: string) {
      writeLine(streams.stderr, title ? `note: ${title}\n${message}` : `note: ${message}`);
    },
    warn(message: string) {
      writeLine(streams.stderr, `warn: ${message}`);
    },
    error(message: string) {
      writeLine(streams.stderr, `error: ${message}`);
    },
    success(message: string) {
      writeLine(streams.stderr, `success: ${message}`);
    },
    progress() {
      return environment.mode === 'interactive-tty'
        ? createInteractiveProgressPresenter(streams)
        : createPlainProgressPresenter(streams);
    },
    spinner(message: string) {
      return createPlainSpinner(streams, message);
    },
    prompt(message: string) {
      return createPlainPrompt(streams, message);
    },
    confirm(options) {
      return createPlainConfirm(streams, options);
    },
    select(options) {
      return createPlainSelect(streams, options);
    },
    multiSelect(options) {
      return createPlainMultiSelect(streams, options);
    },
  };
}

export function createSilentTerminalPresenter(environment: TerminalEnvironment): TerminalPresenter {
  const progress = createNoopProgressPresenter();
  const spinner = createSilentSpinner();

  return {
    environment,
    intro() {},
    outro() {},
    message() {},
    status() {},
    note() {},
    warn() {},
    error() {},
    success() {},
    progress() {
      return progress;
    },
    spinner() {
      return spinner;
    },
    async prompt() {
      return undefined;
    },
    async confirm() {
      return undefined;
    },
    async select() {
      return undefined;
    },
    async multiSelect() {
      return undefined;
    },
  };
}

export function createPlainTerminalPresenter(
  environment: TerminalEnvironment,
  options: TerminalPresenterOptions = {},
): TerminalPresenter {
  const streams: StreamPair = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };

  return createOutputPresenter(environment, streams);
}
