import type { IndexProgress } from '../../extraction';
import type { ProgressCompletionSummary } from './types';

export const PROGRESS_PHASE_LABELS: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Saving graph',
  scip: 'SCIP indexing',
  resolving: 'Linking references',
  synthesis: 'Synthesizing relations',
};

export const PROGRESS_SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
export const ASCII_PROGRESS_SPINNER_FRAMES = ['o'];
const BRAND_WORD = 'SolidKG';
const PROGRESS_BAR_WIDTH = 10;

export interface GraphProgressRenderOptions {
  frame?: number;
  unicode?: boolean;
  columns?: number;
}

interface GraphProgressModel {
  spinner: string;
  phaseLabel: string;
  detail: string;
  line: string;
}

interface ProgressCompletionModel {
  glyph: string;
  line: string;
}

function phaseLabel(phase: string): string {
  return PROGRESS_PHASE_LABELS[phase] ?? phase;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function progressBar(current: number, total: number, frame: number, unicode: boolean): string {
  const safeTotal = Math.max(0, total);
  const safeCurrent = Math.max(0, current);
  const fill = safeTotal > 0
    ? Math.max(0, Math.min(PROGRESS_BAR_WIDTH, Math.round((safeCurrent / safeTotal) * PROGRESS_BAR_WIDTH)))
    : Math.abs(frame) % (PROGRESS_BAR_WIDTH + 1);
  const filled = unicode ? '━' : '#';
  const empty = unicode ? '─' : '-';

  return `[${filled.repeat(fill)}${empty.repeat(PROGRESS_BAR_WIDTH - fill)}]`;
}

function formatProgressDetail(progress: IndexProgress, frame: number, unicode: boolean): string {
  const bar = progressBar(progress.current, progress.total, frame, unicode);

  if (progress.total > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
    return `${bar} ${formatNumber(progress.current)}/${formatNumber(progress.total)} ${percent}%`;
  }

  if (progress.current > 0) {
    return `${bar} ${formatNumber(progress.current)} seen`;
  }

  return `${bar} starting`;
}

function spinnerFrame(frame: number, unicode: boolean): string {
  const frames = unicode ? PROGRESS_SPINNER_FRAMES : ASCII_PROGRESS_SPINNER_FRAMES;
  return frames[Math.abs(frame) % frames.length] ?? frames[0] ?? 'o..';
}

function progressLine(spinner: string, phase: string, detail: string, unicode: boolean): string {
  if (unicode) {
    return `${spinner} ${BRAND_WORD} ▸ ${phase} · ${detail}`;
  }

  return `${spinner} ${BRAND_WORD} > ${phase} - ${detail}`;
}

function completionGlyph(status: ProgressCompletionSummary['status'], unicode: boolean): string {
  if (!unicode) return status === 'success' ? '*' : '!';
  if (status === 'success') return '◆';
  if (status === 'warning') return '◇';
  return '✖';
}

function completionLine(summary: ProgressCompletionSummary, glyph: string, unicode: boolean): string {
  const separator = unicode ? ' · ' : ' - ';
  return `${glyph} ${BRAND_WORD} ${summary.title}${separator}${summary.segments.join(separator)}`;
}

function truncateLine(line: string, columns: number | undefined, unicode: boolean): string {
  if (columns === undefined || columns <= 0 || line.length <= columns) return line;
  if (columns === 1) return unicode ? '…' : '~';

  const marker = unicode ? '…' : '~';
  const lastSeparator = line.lastIndexOf(' ', columns - marker.length - 1);
  if (lastSeparator > 0) return `${line.slice(0, lastSeparator + 1)}${marker}`;
  return `${line.slice(0, columns - marker.length)}${marker}`;
}

function graphProgressModel(progress: IndexProgress, options: Required<Pick<GraphProgressRenderOptions, 'frame' | 'unicode'>> & Pick<GraphProgressRenderOptions, 'columns'>): GraphProgressModel {
  const spinner = spinnerFrame(options.frame, options.unicode);
  const label = phaseLabel(progress.phase);
  const detail = formatProgressDetail(progress, options.frame, options.unicode);

  return {
    spinner,
    phaseLabel: label,
    detail,
    line: truncateLine(progressLine(spinner, label, detail, options.unicode), options.columns, options.unicode),
  };
}

function progressCompletionModel(summary: ProgressCompletionSummary, options: { unicode: boolean; columns?: number }): ProgressCompletionModel {
  const glyph = completionGlyph(summary.status, options.unicode);

  return {
    glyph,
    line: truncateLine(completionLine(summary, glyph, options.unicode), options.columns, options.unicode),
  };
}

export function renderGraphProgressText(progress: IndexProgress, options: GraphProgressRenderOptions = {}): string {
  const model = graphProgressModel(progress, {
    frame: options.frame ?? 0,
    unicode: options.unicode ?? true,
    columns: options.columns,
  });

  return model.line;
}

export function renderProgressCompletionText(summary: ProgressCompletionSummary, options: { unicode?: boolean; columns?: number } = {}): string {
  return progressCompletionModel(summary, {
    unicode: options.unicode ?? true,
    columns: options.columns,
  }).line;
}
