/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 */

import { parentPort } from 'worker_threads';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, loadGrammarsForLanguages } from './grammars';
import type { Language, ExtractionResult } from '../types';

parentPort!.on('message', async (msg: { type: string; id?: number; filePath?: string; content?: string; languages?: Language[]; frameworkNames?: string[] }) => {
  if (msg.type === 'load-grammars') {
    await loadGrammarsForLanguages(msg.languages!);
    parentPort!.postMessage({ type: 'grammars-loaded' });
  } else if (msg.type === 'parse') {
    const { id, filePath, content, frameworkNames } = msg;
    try {
      const language = detectLanguage(filePath!, content);
      const result: ExtractionResult = extractFromSource(filePath!, content!, language, frameworkNames);

      parentPort!.postMessage({ type: 'parse-result', id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: `Parse worker error: ${message}`, filePath: filePath!, severity: 'error', code: 'parse_error' }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  }
});
