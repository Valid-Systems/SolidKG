/**
 * Adaptive output budget for solidkg_explore (#185).
 *
 * The explore tool used to apply a fixed 35KB output cap regardless of
 * project size, which on small codebases was a net loss vs. native
 * grep+Read. These tests pin the per-tier budget shape so future tuning
 * doesn't silently drift the small-project case back into bloat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getExploreOutputBudget, getExploreBudget, ToolHandler } from '../src/mcp/tools';
import SolidKG from '../src/index';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const outputTruncatedMarker = '... (output truncated to budget';

function countMarkdownCodeFences(text: string): number {
  return text.match(/^```/gm)?.length ?? 0;
}

function textBeforeOutputTruncationMarker(text: string): string {
  const markerIndex = text.indexOf(outputTruncatedMarker);
  return markerIndex === -1 ? text : text.slice(0, markerIndex);
}

function lastMeaningfulLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

function isMarkdownBoundary(line: string): boolean {
  return (
    line === '```' ||
    line === '---' ||
    line === '... (trimmed) ...' ||
    /^#{2,4} /.test(line) ||
    /^> /.test(line) ||
    /^- /.test(line)
  );
}

describe('getExploreOutputBudget', () => {
  it('returns a strictly smaller total cap for small projects than for huge ones', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxOutputChars).toBeLessThan(huge.maxOutputChars);
    expect(small.defaultMaxFiles).toBeLessThan(huge.defaultMaxFiles);
    expect(small.maxCharsPerFile).toBeLessThan(huge.maxCharsPerFile);
  });

  it('caps total output well under 8000 tokens (~32k chars) on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.maxOutputChars).toBeLessThanOrEqual(20000);
  });

  it('keeps the historical 35k+ ceiling for medium-large projects so existing benchmarks do not regress', () => {
    const large = getExploreOutputBudget(10000);
    expect(large.maxOutputChars).toBeGreaterThanOrEqual(35000);
  });

  it('uses tier breakpoints matching getExploreBudget so call-count and output-budget agree on a project', () => {
    // Anything in the same tier should pick the same total-output cap.
    const tier1a = getExploreOutputBudget(50);
    const tier1b = getExploreOutputBudget(499);
    expect(tier1a.maxOutputChars).toBe(tier1b.maxOutputChars);
    expect(getExploreBudget(50)).toBe(getExploreBudget(499));

    const tier2a = getExploreOutputBudget(500);
    const tier2b = getExploreOutputBudget(4999);
    expect(tier2a.maxOutputChars).toBe(tier2b.maxOutputChars);
    expect(getExploreBudget(500)).toBe(getExploreBudget(4999));

    const tier3a = getExploreOutputBudget(5000);
    const tier3b = getExploreOutputBudget(14999);
    expect(tier3a.maxOutputChars).toBe(tier3b.maxOutputChars);

    // And crossing a breakpoint changes the cap.
    expect(tier1a.maxOutputChars).not.toBe(tier2a.maxOutputChars);
    expect(tier2a.maxOutputChars).not.toBe(tier3a.maxOutputChars);
  });

  it('gates off "Additional relevant files", completeness signal, and budget note on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.includeAdditionalFiles).toBe(false);
    expect(small.includeCompletenessSignal).toBe(false);
    expect(small.includeBudgetNote).toBe(false);
  });

  it('keeps all meta-text on for projects that earn the breadth signal (>=500 files)', () => {
    const medium = getExploreOutputBudget(1000);
    expect(medium.includeAdditionalFiles).toBe(true);
    expect(medium.includeCompletenessSignal).toBe(true);
    expect(medium.includeBudgetNote).toBe(true);
  });

  it('keeps the Relationships section on for every tier — it is the cheapest structural signal', () => {
    expect(getExploreOutputBudget(50).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(1000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(10000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(30000).includeRelationships).toBe(true);
  });

  it('caps the per-file header symbol list more tightly on small projects', () => {
    // Without this cap, a file like Alamofire's Session.swift produced
    // a 3.4KB symbol list in the `#### path — sym, sym, ...` header,
    // dwarfing the per-file body cap.
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxSymbolsInFileHeader).toBeLessThan(huge.maxSymbolsInFileHeader);
    expect(small.maxSymbolsInFileHeader).toBeGreaterThan(0);
  });

  it('uses a tighter clustering gap threshold on small projects to break runaway single clusters', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.gapThreshold).toBeLessThanOrEqual(huge.gapThreshold);
  });

  it('handles the boundary file counts exactly (off-by-one regression guard)', () => {
    // 499 -> small tier, 500 -> medium tier
    expect(getExploreOutputBudget(499).maxOutputChars).toBe(getExploreOutputBudget(100).maxOutputChars);
    expect(getExploreOutputBudget(500).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    // 4999 -> medium, 5000 -> large
    expect(getExploreOutputBudget(4999).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    expect(getExploreOutputBudget(5000).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    // 14999 -> large, 15000 -> xlarge
    expect(getExploreOutputBudget(14999).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    expect(getExploreOutputBudget(15000).maxOutputChars).toBe(getExploreOutputBudget(30000).maxOutputChars);
  });
});

/**
 * End-to-end check that the budget is actually applied by handleExplore.
 *
 * Builds a tiny synthetic project (<500 files, so the small tier), indexes
 * it, and confirms the output:
 *   - stays under the small-tier maxOutputChars cap
 *   - omits the meta-text the small tier gates off (completeness signal,
 *     budget note, "Additional relevant files")
 *
 * Regression guard for #185 — protects against future edits to handleExplore
 * silently re-introducing the fixed 35KB cap on small projects.
 */
describe('solidkg_explore output respects the adaptive budget', () => {
  let testDir: string;
  let cg: SolidKG;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-budget-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A handful of files with one fat target file. The fat file mimics the
    // Alamofire Session.swift case: many methods stacked on top of each other,
    // which collapsed into one giant cluster pre-#185.
    const fatLines: string[] = ['export class Session {'];
    for (let i = 0; i < 30; i++) {
      fatLines.push(`  method${i}(arg: string): string {`);
      fatLines.push(`    return this.helper${i}(arg) + "${i}";`);
      fatLines.push(`  }`);
      fatLines.push(`  private helper${i}(arg: string): string {`);
      fatLines.push(`    return arg.repeat(${i + 1});`);
      fatLines.push(`  }`);
    }
    fatLines.push('}');
    fs.writeFileSync(path.join(srcDir, 'session.ts'), fatLines.join('\n'));

    // A few small supporting files so the project has >1 indexed file.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(srcDir, `support${i}.ts`),
        `import { Session } from './session';\nexport function callSession${i}(s: Session) { return s.method${i}('hi'); }\n`
      );
    }

    fs.writeFileSync(
      path.join(srcDir, 'body-behavior.ts'),
      `export function operateShipment(): string {
  const manifest = 'carrier manifest quarantine reconciliation';
  const escalation = 'warehouse exception routing';
  return manifest + escalation;
}
`
    );

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps total output under the small-project cap', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    const smallBudget = getExploreOutputBudget(100);
    // Allow a small overshoot for the trailing markers — the cap is enforced
    // per-file rather than as an absolute output ceiling.
    expect(text.length).toBeLessThan(smallBudget.maxOutputChars + 500);
  });

  it('omits the meta-text gated off for small projects', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('### Additional relevant files');
    expect(text).not.toContain('Complete source code is included above');
    expect(text).not.toContain('Explore budget:');
  });

  it('still includes the Relationships section — it is the cheapest structural signal', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // Either there are relationships, or no edges were significant — both are fine.
    // We just want to confirm we did not accidentally gate it off.
    const hasRelationships = text.includes('### Relationships');
    const sourceFollowsHeader = text.indexOf('### Source Code') > 0;
    expect(hasRelationships || sourceFollowsHeader).toBe(true);
  });

  it('includes answer packet metadata with evidence anchors and ranking reasons', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper', maxFiles: 6 });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('### Answer Packet');
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).toContain('Evidence anchors:');
    expect(text).toContain('Ranking reasons:');
  });

  it('surfaces chunk evidence labels and source for body-only explore queries', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'natural language body-only behavior carrier manifest quarantine routing',
      maxFiles: 2,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Source body evidence:');
    expect(text).toContain('source_body_chunk:');
    expect(text).toContain('src/body-behavior.ts');
    expect(text).toContain('carrier manifest quarantine reconciliation');
  });

  it('does not suggest serial node drilling when explore source is sufficient', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper', maxFiles: 6 });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).toContain('can answer from returned context');
    expect(text).not.toContain('Suggested next SolidKG tools: solidkg_node');
    expect(text).not.toContain('Suggested next SolidKG tools: solidkg_trace, solidkg_node');
  });

  it('wraps no-result explore responses in a bounded-no-results answer packet', async () => {
    const result = await handler.execute('solidkg_explore', { query: '__definitely_no_matching_symbol__' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('No relevant code found for "__definitely_no_matching_symbol__"');
    expect(text).toContain('### Answer Packet');
    expect(text).toContain('Uncertainty: bounded_no_results');
  });

  it('prefixes source lines with line numbers by default (cat -n style)', async () => {
    delete process.env.SOLIDKG_EXPLORE_LINENUMS;
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // At least one fenced source line should look like `<digits>\t<code>`.
    expect(/\n\d+\t/.test(text)).toBe(true);
  });

  it('omits line numbers when SOLIDKG_EXPLORE_LINENUMS=0', async () => {
    process.env.SOLIDKG_EXPLORE_LINENUMS = '0';
    try {
      const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
      const text = result.content?.[0]?.text ?? '';
      // The synthetic source has no tab-prefixed numeric lines of its own,
      // so none should appear when the toggle is off.
      expect(/\n\d+\t(?:export|  )/.test(text)).toBe(false);
    } finally {
      delete process.env.SOLIDKG_EXPLORE_LINENUMS;
    }
  });

  it('uses language-neutral omission markers (no C-style // in the output)', async () => {
    // The gap/trimmed separators must not assume `//` is a comment — that's
    // wrong in Python, Ruby, etc. They render inside fenced source blocks.
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('// ... (gap)');
    expect(text).not.toContain('// ... trimmed');
  });

  it('does not collapse a whole-file class into just its header (envelope filter)', async () => {
    // The synthetic `Session` class spans the entire file. Without the
    // envelope filter it would form one giant cluster that tail-trims to
    // the class declaration, hiding the methods. Confirm real method bodies
    // make it into the output. Regression guard for the #185 follow-up.
    const result = await handler.execute('solidkg_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // A method body line (`methodN(arg: string)`) should appear, not just
    // the `export class Session {` opener.
    const hasMethodBody = /method\d+\(arg: string\)/.test(text);
    expect(hasMethodBody).toBe(true);
  });

  it('returns source for exact filename queries instead of dropping file-node hits as envelopes', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-exact-files-'));
    const srcDir = path.join(exactDir, 'scripts', 'agent-eval');
    fs.mkdirSync(srcDir, { recursive: true });

    const requestedFiles = [
      'opencode-answer-benchmark.mjs',
      'score-answer-quality.mjs',
      'report-answer-quality.mjs',
      'parse-opencode-transcript.mjs',
    ];

    for (const file of requestedFiles) {
      const symbol = file.replace(/[^A-Za-z0-9]/g, '_');
      const lines = [
        `export function ${symbol}Entry() {`,
        `  const marker = "REQUESTED_HEAD_${symbol}";`,
      ];
      for (let i = 0; i < 260; i++) {
        lines.push(`  const filler${i} = "${symbol}_middle_${i}_${'x'.repeat(32)}";`);
      }
      lines.push(
        `  const tail = "REQUESTED_TAIL_${symbol}";`,
        '  return marker + tail;',
        '}'
      );
      fs.writeFileSync(path.join(srcDir, file), lines.join('\n'));
    }

    for (const file of ['compare-answer-diagnostics.mjs', 'freeze-answer-diagnostics.mjs', 'parse-arms.mjs']) {
      fs.writeFileSync(
        path.join(srcDir, file),
        `export function distractor() { return "DISTRACTOR_${file}"; }\n`
      );
    }

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.mjs'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: [...requestedFiles, 'compare-answer-diagnostics.mjs', 'freeze-answer-diagnostics.mjs', 'parse-arms.mjs'].join(' '),
        maxFiles: 4,
      });
      const text = result.content?.[0]?.text ?? '';

      for (const file of requestedFiles) {
        const symbol = file.replace(/[^A-Za-z0-9]/g, '_');
        expect(text).toContain(`scripts/agent-eval/${file}`);
        expect(text).toContain(`REQUESTED_HEAD_${symbol}`);
        expect(text).toContain(`REQUESTED_TAIL_${symbol}`);
      }
      expect(text).not.toContain('DISTRACTOR_compare-answer-diagnostics.mjs');
      expect(text).not.toContain('DISTRACTOR_freeze-answer-diagnostics.mjs');
      expect(text).not.toContain('DISTRACTOR_parse-arms.mjs');
      expect(text.length).toBeLessThan(getExploreOutputBudget(100).maxOutputChars + 500);
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });

  it('ranks exact Ky core path and symbols before broad type and test matches when maxFiles is constrained', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-ky-ranking-'));
    const srcDir = path.join(exactDir, 'src');
    const coreDir = path.join(srcDir, 'core');
    const typesDir = path.join(srcDir, 'types');
    const testsDir = path.join(srcDir, '__tests__');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(typesDir, { recursive: true });
    fs.mkdirSync(testsDir, { recursive: true });

    fs.writeFileSync(
      path.join(typesDir, 'Ky.ts'),
      `export function calculateRetryDelay(): string { return 'BROAD_TYPES_CALCULATE_RETRY_DELAY'; }
export function retryFromError(): string { return 'BROAD_TYPES_RETRY_FROM_ERROR'; }
export function fetch(): string { return 'BROAD_TYPES_FETCH'; }
export function normalizeRetryOptions(): string { return 'BROAD_TYPES_NORMALIZE_RETRY_OPTIONS'; }
`
    );

    fs.writeFileSync(
      path.join(coreDir, 'Ky.ts'),
      `export function calculateRetryDelay(): string { return 'CORE_KY_CALCULATE_RETRY_DELAY'; }
export function retryFromError(): string { return 'CORE_KY_RETRY_FROM_ERROR'; }
export function fetch(): string { return 'CORE_KY_FETCH'; }
export function normalizeRetryOptions(): string { return 'CORE_KY_NORMALIZE_RETRY_OPTIONS'; }
`
    );

    fs.writeFileSync(
      path.join(testsDir, 'Ky.test.ts'),
      `export function calculateRetryDelay(): string { return 'TEST_KY_CALCULATE_RETRY_DELAY'; }
export function retryFromError(): string { return 'TEST_KY_RETRY_FROM_ERROR'; }
`
    );

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: 'src/core/Ky.ts:1 calculateRetryDelay retryFromError fetch normalizeRetryOptions',
        maxFiles: 1,
      });
      const text = result.content?.[0]?.text ?? '';

      expect(text).toContain('#### src/core/Ky.ts');
      expect(text).toContain('CORE_KY_CALCULATE_RETRY_DELAY');
      expect(text).not.toContain('BROAD_TYPES_CALCULATE_RETRY_DELAY');
      expect(text).not.toContain('TEST_KY_CALCULATE_RETRY_DELAY');
      expect(text).not.toMatch(/Source completeness:\s*complete/i);
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });
  it('prefers Ky constructor and timeout clusters over an exact file envelope when symbols are also named', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-ky-envelope-'));
    const coreDir = path.join(exactDir, 'src', 'core');
    fs.mkdirSync(coreDir, { recursive: true });

    const kyLines: string[] = [
      'export type KyOptions = { timeout?: { totalTimeout?: number } };',
      '',
      'export function getCurrentTime(): number {',
      '  return Date.now();',
      '}',
      '',
      'export class Ky {',
      '  #startTime = 0;',
      '  #totalTimeout: number | undefined;',
    ];
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '  beforeConstructorFiller' + i + '(): string {',
        '    return "before-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
        '  }'
      );
    }
    kyLines.push(
      '  constructor(input: string, options: KyOptions = {}) {',
      '    const totalTimeout = options.timeout?.totalTimeout;',
      '    this.#startTime = getCurrentTime();',
      '    this.#totalTimeout = totalTimeout;',
      '    void input;',
      '  }'
    );
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '  betweenTimeoutFiller' + i + '(): string {',
        '    return "between-' + i + '-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";',
        '  }'
      );
    }
    kyLines.push(
      '  #getRemainingTotalTimeout(): number | undefined {',
      '    if (this.#totalTimeout === undefined) {',
      '      return undefined;',
      '    }',
      '    const elapsed = getCurrentTime() - this.#startTime;',
      '    return Math.max(this.#totalTimeout - elapsed, 0);',
      '  }',
      '',
      '  run(): number | undefined {',
      '    return this.#getRemainingTotalTimeout();',
      '  }',
      '}'
    );

    fs.writeFileSync(path.join(coreDir, 'Ky.ts'), kyLines.join('\n'));

    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(exactDir, 'src', 'support' + i + '.ts'),
        'export const support' + i + ' = ' + i + ';\n'
      );
    }

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: 'src/core/Ky.ts #startTime #getRemainingTotalTimeout totalTimeout getCurrentTime',
        maxFiles: 1,
      });
      const text = result.content?.[0]?.text ?? '';

      expect(text).toContain('#### src/core/Ky.ts');
      expect(text).toContain('constructor(input: string, options: KyOptions = {})');
      expect(text).toContain('this.#startTime = getCurrentTime();');
      expect(text).toContain('this.#totalTimeout = totalTimeout;');
      expect(text).toContain('const elapsed = getCurrentTime() - this.#startTime;');
      expect(text).toContain('return Math.max(this.#totalTimeout - elapsed, 0);');
      expect(text).toMatch(/src\/core\/Ky\.ts.*\[(partial|truncated)\]/i);
      expect(text).not.toMatch(/Source completeness:\s*complete/i);
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });

  it('prioritizes exact symbol files before path-only files under the global output cap', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-exact-symbol-file-priority-'));
    const coreDir = path.join(exactDir, 'source', 'core');
    const utilsDir = path.join(exactDir, 'source', 'utils');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });

    const writeLargePathOnlyFile = (filePath: string, marker: string) => {
      const lines = [
        `export function ${marker}Entry(): string {`,
        `  const head = "${marker}_HEAD";`,
      ];
      for (let i = 0; i < 260; i++) {
        lines.push(`  const filler${i} = "${marker}_FILLER_${i}_${'x'.repeat(55)}";`);
      }
      lines.push(
        `  const tail = "${marker}_TAIL";`,
        '  return head + tail;',
        '}'
      );
      fs.writeFileSync(filePath, lines.join('\n'));
    };

    writeLargePathOnlyFile(path.join(coreDir, 'Ky.ts'), 'PATH_ONLY_KY');
    writeLargePathOnlyFile(path.join(coreDir, 'constants.ts'), 'PATH_ONLY_CONSTANTS');
    writeLargePathOnlyFile(path.join(utilsDir, 'timeout.ts'), 'PATH_ONLY_TIMEOUT');
    fs.writeFileSync(
      path.join(utilsDir, 'normalize.ts'),
      [
        'export function normalizeRetryOptions(): string {',
        '  return "NORMALIZE_RETRY_OPTIONS_SOURCE";',
        '}',
      ].join('\n')
    );

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: 'source/core/Ky.ts source/core/constants.ts source/utils/timeout.ts normalizeRetryOptions',
        maxFiles: 3,
      });
      const text = result.content?.[0]?.text ?? '';

      expect(text).toContain('#### source/utils/normalize.ts');
      expect(text).toContain('NORMALIZE_RETRY_OPTIONS_SOURCE');
      expect(text).toContain('#### source/core/Ky.ts');
      expect(text).not.toContain('PATH_ONLY_TIMEOUT_HEAD');
      expect(text.length).toBeLessThan(getExploreOutputBudget(100).maxOutputChars + 500);
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });
  it('prioritizes source retry evidence over low-value generic test matches for Ky-shaped queries', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-ky-source-over-test-'));
    const coreDir = path.join(exactDir, 'source', 'core');
    const typesDir = path.join(exactDir, 'source', 'types');
    const utilsDir = path.join(exactDir, 'source', 'utils');
    const testDir = path.join(exactDir, 'test');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(typesDir, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    const kyLines: string[] = [
      'import {normalizeRetryOptions} from "../utils/normalize";',
      'import {retry} from "./constants";',
      'import {timeout} from "../utils/timeout";',
      'export class Ky {',
      '  constructor() {',
      '    normalizeRetryOptions();',
      '  }',
      '  static create(): string {',
      '    const ky = new Ky();',
      '    return ky.#retry(() => ky.#fetch());',
      '  }',
    ];
    for (let i = 0; i < 160; i++) {
      kyLines.push(
        '  kyFiller' + i + '(): string {',
        '    return "ky-filler-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
        '  }'
      );
    }
    kyLines.push(
      '  #calculateRetryDelay(): string {',
      '    retry();',
      '    return "CALCULATE_RETRY_DELAY_SOURCE";',
      '  }',
      '  #decorateResponse(): string { return "DECORATE_RESPONSE_SOURCE"; }',
      '  #retry(fn: () => string): string { this.#calculateRetryDelay(); return fn(); }',
      '  #fetch(): string { return timeout(); }',
      '}'
    );
    fs.writeFileSync(path.join(coreDir, 'Ky.ts'), kyLines.join('\n'));

    fs.writeFileSync(path.join(coreDir, 'constants.ts'), [
      'export function retry(): string {',
      '  return "CORE_CONSTANTS_RETRY_SOURCE";',
      '}',
    ].join('\n'));

    const optionsLines = [
      'export interface NormalizedOptions {',
      '  retry: RetryOptions;',
      '  timeout: number;',
      '  totalTimeout: number;',
      '}',
      'export interface RetryOptions { beforeRetry?: unknown; shouldRetry?: unknown; }',
    ];
    for (let i = 0; i < 160; i++) {
      optionsLines.push('export type OptionsFiller' + i + ' = "options-' + i + '";');
    }
    fs.writeFileSync(path.join(typesDir, 'options.ts'), optionsLines.join('\n'));

    fs.writeFileSync(path.join(typesDir, 'retry.ts'), [
      'export interface BeforeRetryState { marker: "BEFORE_RETRY_STATE_SOURCE"; }',
      'export interface ShouldRetryState { marker: "SHOULD_RETRY_STATE_SOURCE"; }',
      'export const defaultRetryOptions = {',
      '  limit: 2,',
      '  retryOnTimeout: false,',
      '  backoffLimit: Number.POSITIVE_INFINITY,',
      '};',
    ].join('\n'));

    fs.writeFileSync(path.join(utilsDir, 'normalize.ts'), [
      'import {defaultRetryOptions} from "../types/retry";',
      'export function normalizeRetryOptions(): string {',
      '  return "NORMALIZE_RETRY_OPTIONS_SOURCE" + defaultRetryOptions.limit;',
      '}',
    ].join('\n'));

    fs.writeFileSync(path.join(utilsDir, 'timeout.ts'), [
      'export function timeout(): string {',
      '  return "TIMEOUT_SOURCE";',
      '}',
    ].join('\n'));

    const testLines = [
      'export function t(): string { return timeout; }',
      'const timeout = "LOW_VALUE_TEST_TIMEOUT";',
    ];
    for (let i = 0; i < 260; i++) {
      testLines.push('const headerFiller' + i + ' = "headers-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";');
    }
    fs.writeFileSync(path.join(testDir, 'headers.ts'), testLines.join('\n'));

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: 'Ky #retry #fetch #calculateRetryDelay #decorateResponse create NormalizedOptions retry timeout totalTimeout beforeRetry shouldRetry source/core/Ky.ts source/types/options.ts',
        maxFiles: 5,
      });
      const text = result.content?.[0]?.text ?? '';

      expect(text).toContain('#### source/types/retry.ts');
      expect(text).toContain('BEFORE_RETRY_STATE_SOURCE');
      expect(text).toContain('SHOULD_RETRY_STATE_SOURCE');
      expect(text).toContain('#### source/utils/normalize.ts');
      expect(text).toContain('NORMALIZE_RETRY_OPTIONS_SOURCE');
      expect(text).not.toContain('#### test/headers.ts');
      expect(text).not.toContain('LOW_VALUE_TEST_TIMEOUT');
      expect(text.length).toBeLessThan(getExploreOutputBudget(100).maxOutputChars + 500);
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });
  it('prioritizes exact private Ky method clusters in a large core file', async () => {
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-ky-private-methods-'));
    const coreDir = path.join(exactDir, 'src', 'core');
    const utilsDir = path.join(exactDir, 'src', 'utils');
    const errorsDir = path.join(exactDir, 'src', 'errors');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.mkdirSync(errorsDir, { recursive: true });

    const kyLines: string[] = [
      'export class Ky {',
    ];
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '  earlyFiller' + i + '(): string {',
        '    return "early-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
        '  }'
      );
    }
    kyLines.push(
      '  async #fetch(): Promise<string> {',
      '    return "CORE_PRIVATE_FETCH_TIMEOUT";',
      '  }'
    );
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '  middleFiller' + i + '(): string {',
        '    return "middle-' + i + '-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";',
        '  }'
      );
    }
    kyLines.push(
      '  #calculateRetryDelay(): string {',
      '    return "CORE_PRIVATE_CALCULATE_RETRY_DELAY";',
      '  }',
      '',
      '  async #retryFromError(): Promise<string> {'
    );
    kyLines.push('    this.#calculateRetryDelay();');
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '    const retryStep' + i + ' = "retry-step-' + i + '-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
        '    void retryStep' + i + ';'
      );
    }
    kyLines.push(
      '    return this.#fetch();',
      '  }'
    );
    for (let i = 0; i < 90; i++) {
      kyLines.push(
        '  lateFiller' + i + '(): string {',
        '    return "late-' + i + '-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";',
        '  }'
      );
    }
    kyLines.push(
      '  async #retry(): Promise<string> {',
      '    return this.#retryFromError();',
      '  }',
      '}'
    );
    fs.writeFileSync(path.join(coreDir, 'Ky.ts'), kyLines.join('\n'));
    fs.writeFileSync(path.join(utilsDir, 'timeout.ts'), 'export class TimeoutError extends Error {}\nexport function timeout(): string { return "UTIL_TIMEOUT"; }\n');
    fs.writeFileSync(path.join(utilsDir, 'normalize.ts'), 'export function normalizeRetryOptions(): string { return "NORMALIZE_RETRY_OPTIONS"; }\n');
    fs.writeFileSync(path.join(errorsDir, 'TimeoutError.ts'), 'export class TimeoutError extends Error {}\n');
    fs.writeFileSync(path.join(exactDir, 'src', 'types.ts'), 'export function fetch(): string { return "BROAD_FETCH"; }\nexport function retry(): string { return "BROAD_RETRY"; }\n');

    const exactCg = SolidKG.initSync(exactDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    try {
      await exactCg.indexAll();
      const exactHandler = new ToolHandler(exactCg);
      const result = await exactHandler.execute('solidkg_explore', {
        query: 'src/core/Ky.ts #fetch #retryFromError #calculateRetryDelay #calculateDelay _retry retry TimeoutError timeout normalizeRetryOptions',
        maxFiles: 1,
      });
      const text = result.content?.[0]?.text ?? '';

      expect(text).toContain('#### src/core/Ky.ts');
      expect(text).toContain('CORE_PRIVATE_FETCH_TIMEOUT');
      expect(text).toContain('this.#calculateRetryDelay();');
      expect(text).toContain('CORE_PRIVATE_CALCULATE_RETRY_DELAY');
      expect(text).not.toContain('BROAD_FETCH');
    } finally {
      exactCg.destroy();
      fs.rmSync(exactDir, { recursive: true, force: true });
    }
  });
});

describe('solidkg_explore markdown truncation boundaries', () => {
  let testDir: string;
  let cg: SolidKG;
  let handler: ToolHandler;
  let boundaryOutput: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-boundary-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    for (let fileIndex = 0; fileIndex < 12; fileIndex++) {
      const lines = [
        'export function BoundaryTarget(): string {',
        '  const chunks = [',
      ];
      for (let lineIndex = 0; lineIndex < 150; lineIndex++) {
        lines.push(`    "segment-${fileIndex}-${lineIndex}-${'x'.repeat(60)}",`);
      }
      lines.push('  ];');
      lines.push('  return chunks.join("|");');
      lines.push('}');
      fs.writeFileSync(path.join(srcDir, `boundary${fileIndex}.ts`), lines.join('\n'));
    }

    for (let fileIndex = 0; fileIndex < 488; fileIndex++) {
      fs.writeFileSync(
        path.join(srcDir, `filler${fileIndex}.ts`),
        `export const filler${fileIndex} = ${fileIndex};\n`
      );
    }

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);

    const longBoundaryQuery = 'BoundaryTarget '.repeat(600).trim();
    const result = await handler.execute('solidkg_explore', {
      query: longBoundaryQuery,
      maxFiles: 20,
    });
    boundaryOutput = result.content?.[0]?.text ?? '';
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('boundary keeps markdown code fences balanced when explore output is truncated', () => {
    expect(boundaryOutput).toContain(outputTruncatedMarker);

    const beforeMarker = textBeforeOutputTruncationMarker(boundaryOutput);
    expect(countMarkdownCodeFences(beforeMarker) % 2).toBe(0);
    expect(countMarkdownCodeFences(boundaryOutput) % 2).toBe(0);
  });

  it('boundary truncates only at complete markdown sections or closed source blocks', () => {
    expect(boundaryOutput).toContain(outputTruncatedMarker);

    const beforeMarker = textBeforeOutputTruncationMarker(boundaryOutput);
    expect(isMarkdownBoundary(lastMeaningfulLine(beforeMarker))).toBe(true);
  });

  it('boundary places a truthful truncation marker instead of implying complete source', () => {
    expect(boundaryOutput).toContain(outputTruncatedMarker);
    expect(boundaryOutput).not.toMatch(/source above is complete/i);
    expect(boundaryOutput).not.toContain('Complete source for');
  });
});

describe('solidkg_explore completeness metadata', () => {
  let completeTestDir: string;
  let completeCg: SolidKG;
  let completeHandler: ToolHandler;
  let testDir: string;
  let cg: SolidKG;
  let handler: ToolHandler;

  beforeAll(async () => {
    completeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-complete-'));
    const completeSrcDir = path.join(completeTestDir, 'src');
    fs.mkdirSync(completeSrcDir);
    fs.writeFileSync(
      path.join(completeSrcDir, 'complete.ts'),
      [
        'export function CompletenessComplete(): string {',
        '  return "complete-source";',
        '}',
      ].join('\n')
    );
    completeCg = SolidKG.initSync(completeTestDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await completeCg.indexAll();
    completeHandler = new ToolHandler(completeCg);

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-completeness-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'complete.ts'),
      [
        'export function CompletenessComplete(): string {',
        '  return "complete-source";',
        '}',
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(srcDir, 'skipped.ts'),
      [
        'export function CompletenessSkipped(): string {',
        '  return "skipped-source";',
        '}',
      ].join('\n')
    );

    for (let fileIndex = 0; fileIndex < 3; fileIndex++) {
      fs.writeFileSync(
        path.join(srcDir, `omitted${fileIndex}.ts`),
        [
          `export function CompletenessOmitted${fileIndex}(): string {`,
          `  return "omitted-source-${fileIndex}";`,
          '}',
        ].join('\n')
      );
    }

    for (let fileIndex = 0; fileIndex < 12; fileIndex++) {
      const lines = [
        `export function CompletenessTruncated${fileIndex}(): string {`,
        '  const chunks = [',
      ];
      for (let lineIndex = 0; lineIndex < 150; lineIndex++) {
        lines.push(`    "truncated-${fileIndex}-${lineIndex}-${'x'.repeat(60)}",`);
      }
      lines.push('  ];');
      lines.push('  return chunks.join("|");');
      lines.push('}');
      fs.writeFileSync(path.join(srcDir, `truncated${fileIndex}.ts`), lines.join('\n'));
    }

    const longClusterLines = [
      'export function LongClusterOrchestrator(): string {',
      '  const head = "HEAD_CONTEXT_executeLiveBenchmark";',
    ];
    for (let lineIndex = 0; lineIndex < 260; lineIndex++) {
      longClusterLines.push(`  const filler${lineIndex} = "middle-${lineIndex}-${'x'.repeat(70)}";`);
    }
    longClusterLines.push(
      '  const tail = "TAIL_CONTEXT_parseOpenCodeTranscriptText_scoreResults_run_row_evidence_dossier";',
      '  return head + tail;',
      '}'
    );
    fs.writeFileSync(path.join(srcDir, 'long-cluster.ts'), longClusterLines.join('\n'));

    for (let fileIndex = 0; fileIndex < 484; fileIndex++) {
      fs.writeFileSync(
        path.join(srcDir, `filler${fileIndex}.ts`),
        `export const completenessFiller${fileIndex} = ${fileIndex};\n`
      );
    }

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    fs.rmSync(path.join(srcDir, 'skipped.ts'));
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    completeHandler?.closeAll();
    completeCg?.destroy();
    if (completeTestDir && fs.existsSync(completeTestDir)) {
      fs.rmSync(completeTestDir, { recursive: true, force: true });
    }
    handler?.closeAll();
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function expectSourceCompleteness(text: string, status: 'complete' | 'truncated' | 'omitted'): void {
    expect.soft(text).toMatch(new RegExp(`Source completeness:\\s*${status}`, 'i'));
  }

  it('completeness marks complete source as complete without truncation or omissions', async () => {
    const result = await completeHandler.execute('solidkg_explore', {
      query: 'CompletenessComplete',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('complete.ts');
    expect(text).toContain('complete-source');
    expect(text).toMatch(/complete\.ts.*\[complete\]/i);
    expect(text).not.toMatch(/complete\.ts.*\[(partial|omitted)\]/i);
    expect(text).not.toContain(outputTruncatedMarker);
    expect(text).not.toContain('### Not shown above');
    expectSourceCompleteness(text, 'complete');
    expect.soft(text).toMatch(/complete source/i);
  });

  it('completeness marks hard-truncated output as truncated and never complete', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'CompletenessTruncated '.repeat(300).trim(),
      maxFiles: 20,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain(outputTruncatedMarker);
    expect(text).toMatch(/\[(partial|truncated)\]/i);
    expect.soft(text).not.toMatch(/source above is complete/i);
    expect.soft(text).not.toContain('Complete source for');
    expectSourceCompleteness(text, 'truncated');
    expect(text).toContain('Suggested next SolidKG tools: solidkg_explore');
  });

  it('completeness marks not-shown files as omitted instead of globally complete', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'CompletenessOmitted0 CompletenessOmitted1 CompletenessOmitted2',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('### Not shown above');
    expect(text).toMatch(/omitted[12]\.ts/);
    expect.soft(text).not.toContain('Complete source for');
    expectSourceCompleteness(text, 'omitted');
    expect.soft(text).not.toMatch(/Source completeness:\s*complete/i);
  });

  it('completeness distinguishes included, skipped/unreadable, and omitted relevant source', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'CompletenessComplete CompletenessSkipped CompletenessOmitted0',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('complete.ts');
    expect(text).toContain('complete-source');
    expect(text).toContain('### Not shown above');
    expect(text).toContain('skipped.ts');
    expect(text).toContain('omitted0.ts');
    expect(text).toContain('Source completeness: partial (1 included, 1 skipped/unreadable, 1 omitted)');
    expect.soft(text).not.toMatch(/Source completeness:\s*complete/i);
  });

  it('preserves tail context when a selected long function cluster is trimmed', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'LongClusterOrchestrator',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('HEAD_CONTEXT_executeLiveBenchmark');
    expect(text).toContain('TAIL_CONTEXT_parseOpenCodeTranscriptText_scoreResults_run_row_evidence_dossier');
    expect(text).toContain('... (trimmed');
    expectSourceCompleteness(text, 'truncated');
  });
});

describe('solidkg_explore duplicate-symbol flow disambiguation', () => {
  let testDir: string;
  let cg: SolidKG;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-duplicate-flow-'));
    const srcDir = testDir;
    const providersDir = path.join(srcDir, 'providers');
    fs.mkdirSync(providersDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'agent.py'),
      `from backend import _search_tavily\n\ndef search():\n    return _search_tavily()\n`
    );
    fs.writeFileSync(
      path.join(srcDir, 'backend.py'),
      `from providers.web import search\n\ndef _search_tavily():\n    value = search()\n    return normalize_results(value)\n\ndef normalize_results(value):\n    return value\n`
    );
    fs.writeFileSync(
      path.join(providersDir, 'web.py'),
      `def search():\n    return "web result"\n`
    );
    fs.writeFileSync(
      path.join(srcDir, 'mygetlisthelper.py'),
      `def list():\n    return helper()\n\ndef helper():\n    return normalize_results([])\n`
    );
    fs.writeFileSync(
      path.join(srcDir, 'catalog.py'),
      `def getList():\n    return "not the list function"\n\ndef list():\n    return "catalog list"\n`
    );

    cg = SolidKG.initSync(testDir, {
      config: { include: ['**/*.py'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not emit a misleading flow for unqualified duplicate callable endpoints', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'search _search_tavily normalize_results' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('## Flow (call path among the symbols you queried)');
  });

  it('qualifies duplicate callable names in the relationship map', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'search _search_tavily normalize_results' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('### Relationships');
    expect(text).toContain('- search [agent.py:3] → _search_tavily');
    expect(text).not.toContain('- search → _search_tavily');
  });

  it('does not anchor duplicate names by substring matches inside file paths', async () => {
    const result = await handler.execute('solidkg_explore', { query: 'list getList normalize_results' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('## Flow (call path among the symbols you queried)');
  });

  it('does not re-admit an ambiguous bare duplicate through a qualified sibling token', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'agent/search _search_tavily search',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('## Flow (call path among the symbols you queried)');
  });

  it('still emits a useful path-qualified flow when the other queried symbols are unambiguous', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'agent/search _search_tavily normalize_results',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Flow (call path among the symbols you queried)');
    expect(text).toContain('agent.py:');
    expect(text).toContain('backend.py:');
  });
});
