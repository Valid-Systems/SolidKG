export type {
  ConfirmPromptOptions,
  MultiSelectPromptOptions,
  PromptOption,
  ProgressCompletion,
  ProgressCompletionSummary,
  ProgressPresenter,
  SelectPromptOptions,
  SpinnerPresenter,
  TerminalEnvironment,
  TerminalMode,
  TerminalPresenter,
  TerminalPresenterOptions,
  TerminalStream,
} from './types';

import { createTerminalEnvironment } from './environment';
import { createPlainTerminalPresenter, createSilentTerminalPresenter } from './plain-presenter';
import type { TerminalPresenter, TerminalPresenterOptions } from './types';

export {
  renderGraphProgressText,
  renderProgressCompletionText,
  PROGRESS_PHASE_LABELS,
  PROGRESS_SPINNER_FRAMES,
  ASCII_PROGRESS_SPINNER_FRAMES,
} from './components';
export { createTerminalEnvironment, createPlainTerminalPresenter, createSilentTerminalPresenter };

export function createTerminalPresenter(options: TerminalPresenterOptions = {}): TerminalPresenter {
  const environment = createTerminalEnvironment(options);

  if (environment.mode === 'silent') {
    return createSilentTerminalPresenter(environment);
  }

  return createPlainTerminalPresenter(environment, options);
}
