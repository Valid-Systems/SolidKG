import type { IndexProgress } from '../../extraction';

export type TerminalMode = 'interactive-tty' | 'plain' | 'silent';

export interface TerminalStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
}

export interface TerminalEnvironment {
  mode: TerminalMode;
  isTTY: boolean;
  ci: boolean;
  term: string | undefined;
  noColor: boolean;
  quiet: boolean;
}

export interface TerminalPresenterOptions {
  quiet?: boolean;
  stdout?: TerminalStream;
  stderr?: TerminalStream;
  stdin?: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

export interface PromptOption<Value> {
  value: Value;
  label: string;
  hint?: string;
}

export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
}

export interface SelectPromptOptions<Value> {
  message: string;
  options: PromptOption<Value>[];
  initialValue?: Value;
}

export interface MultiSelectPromptOptions<Value> {
  message: string;
  options: PromptOption<Value>[];
  initialValues?: Value[];
  required?: boolean;
}

export interface ProgressCompletionSummary {
  status: 'success' | 'warning' | 'error';
  title: string;
  segments: string[];
}

export type ProgressCompletion = string | ProgressCompletionSummary;

export interface ProgressPresenter {
  onProgress(progress: IndexProgress): void;
  stop(finalCompletion?: ProgressCompletion): Promise<void>;
}

export interface SpinnerPresenter {
  start(message?: string): void;
  stop(message?: string): Promise<void>;
}

export interface TerminalPresenter {
  environment: TerminalEnvironment;
  intro(message: string): void;
  outro(message: string): void;
  message(message: string): void;
  status(message: string): void;
  note(message: string, title?: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  progress(): ProgressPresenter;
  spinner(message: string): SpinnerPresenter;
  prompt(message: string): Promise<string | undefined>;
  confirm(options: ConfirmPromptOptions): Promise<boolean | undefined>;
  select<Value>(options: SelectPromptOptions<Value>): Promise<Value | undefined>;
  multiSelect<Value>(options: MultiSelectPromptOptions<Value>): Promise<Value[] | undefined>;
}
