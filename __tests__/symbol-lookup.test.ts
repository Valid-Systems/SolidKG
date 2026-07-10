/**
 * Module-qualified symbol lookup (`stage_apply::run`, `Session.request`,
 * `configurator/stage_apply`).
 *
 * Pinned because the lookup vocabulary is what makes solidkg useful
 * in workspaces with same-named symbols across modules — Rust
 * sub-pipelines, Python `__init__.py` packages, Java packages, etc.
 * See #173 for the original report: a `run` function in
 * `src/configurator/stage_apply.rs` was indexed but `stage_apply::run`
 * returned "not found" because (a) FTS strips colons to nothing,
 * leaving a useless query, and (b) `matchesSymbol` only understood
 * `.`-style qualifiers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase } from '../src/db/sqlite-adapter';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type SolidKG from '../src/index';
import { findAllSymbols, findSymbol } from '../src/mcp/symbol-resolution';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { db } = createDatabase(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-symbol-lookup-'));
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function buildRustWorkspace(): Promise<string> {
  const root = tmpRoot();
  const cfgDir = path.join(root, 'src', 'configurator');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Cargo.toml'),
    `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n`
  );
  fs.writeFileSync(path.join(root, 'src', 'lib.rs'), `pub mod configurator;\npub mod scheduler;\n`);
  fs.writeFileSync(
    path.join(cfgDir, 'mod.rs'),
    `pub mod stage_apply;\npub mod stage_detect;\n`
  );
  fs.writeFileSync(
    path.join(cfgDir, 'stage_apply.rs'),
    `pub async fn run() -> Result<(), ()> {\n    render_and_write();\n    Ok(())\n}\n\nfn render_and_write() {}\n`
  );
  fs.writeFileSync(
    path.join(cfgDir, 'stage_detect.rs'),
    `pub async fn run() -> Result<(), ()> { Ok(()) }\n`
  );
  fs.writeFileSync(
    path.join(root, 'src', 'scheduler.rs'),
    `pub fn run_due_tasks() -> Result<(), ()> { Ok(()) }\n`
  );
  return root;
}

async function buildRustCurationWorkspace(): Promise<string> {
  const root = tmpRoot();
  const storeDir = path.join(root, 'rust', 'src', 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Cargo.toml'),
    `[package]\nname = "skillos_fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "rust/src/lib.rs"\n`
  );
  fs.writeFileSync(path.join(root, 'rust', 'src', 'lib.rs'), `pub mod store;\n`);
  fs.writeFileSync(path.join(root, 'rust', 'src', 'store', 'mod.rs'), `pub mod apply_runs;\n`);
  fs.writeFileSync(
    path.join(storeDir, 'apply_runs.rs'),
    `pub struct CurationOperation;

pub enum CurationOpKind {
    Create,
    Update,
}

impl CurationOperation {
    pub async fn complete_apply_mutation_with_review_and_audit(&self) -> Result<(), ()> {
        Ok(())
    }
}

pub async fn complete_apply_mutation_preview() -> Result<(), ()> {
    Ok(())
}
`
  );
  return root;
}

describe.skipIf(!HAS_SQLITE)('matchesSymbol — module-qualified lookups (#173)', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = await buildRustWorkspace();
    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['**/*.rs'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('resolves `stage_apply::run` to the run in stage_apply.rs (not stage_detect.rs)', () => {
    const match = findSymbol(cg, 'stage_apply::run');
    expect(match).not.toBeNull();
    expect(match!.node.name).toBe('run');
    expect(match!.node.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('rejects `stage_apply::run` for the same-named function in a different module', () => {
    const all = findAllSymbols(cg, 'stage_apply::run');
    // All returned nodes must be in stage_apply.rs — never in stage_detect.rs
    for (const node of all.nodes) {
      expect(node.filePath).toMatch(/stage_apply\.rs$/);
    }
    expect(all.nodes.length).toBeGreaterThan(0);
  });

  it('resolves `configurator::stage_apply::run` (multi-level qualifier)', () => {
    const match = findSymbol(cg, 'configurator::stage_apply::run');
    expect(match).not.toBeNull();
    expect(match!.node.name).toBe('run');
    expect(match!.node.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('resolves `crate::configurator::stage_apply::run` (Rust path prefix stripped)', () => {
    const match = findSymbol(cg, 'crate::configurator::stage_apply::run');
    expect(match).not.toBeNull();
    expect(match!.node.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('resolves `configurator/stage_apply` (slash qualifier)', () => {
    const match = findSymbol(cg, 'configurator/stage_apply/run');
    expect(match).not.toBeNull();
    expect(match!.node.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('does not silently collide bare `run` with `run_due_tasks`', () => {
    const match = findSymbol(cg, 'run');
    expect(match).not.toBeNull();
    // Whatever it picks, it must be an exact-name match, not a partial.
    expect(match!.node.name).toBe('run');
  });

  it('aggregates all bare-name `run` matches across modules', () => {
    const all = findAllSymbols(cg, 'run');
    const names = all.nodes.map((n: any) => n.name);
    expect(names.every((n: string) => n === 'run')).toBe(true);
    expect(all.nodes.length).toBeGreaterThanOrEqual(2); // stage_apply + stage_detect
    // The note should call out the ambiguity.
    expect(all.note).toMatch(/Aggregated|symbols named "run"/);
  });

  it('still returns null for genuinely unknown qualified lookups', () => {
    const match = findSymbol(cg, 'stage_apply::nonexistent_fn');
    expect(match).toBeNull();
  });
});

describe.skipIf(!HAS_SQLITE)('searchNodes — Rust impl method lookup', () => {
  let projectRoot: string;
  let cg: SolidKG;

  beforeEach(async () => {
    projectRoot = await buildRustCurationWorkspace();
    const SolidKG = (await import('../src/index')).default;
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['rust/**/*.rs'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('returns the exact long impl method before partial apply-mutation names', () => {
    const results = cg.searchNodes('complete_apply_mutation_with_review_and_audit', {
      kinds: ['method'],
      limit: 5,
    });

    expect(results[0]?.node).toMatchObject({
      name: 'complete_apply_mutation_with_review_and_audit',
      kind: 'method',
      qualifiedName: 'CurationOperation::complete_apply_mutation_with_review_and_audit',
      filePath: 'rust/src/store/apply_runs.rs',
    });
  });
});

describe.skipIf(!HAS_SQLITE)('matchesSymbol — dotted lookups (regression for #173 fix)', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const src = path.join(projectRoot, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'session.ts'),
      `export class Session {\n  request(): void {}\n}\nexport function request(): void {}\n`
    );

    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('`Session.request` resolves to the method, not the bare function', () => {
    const match = findSymbol(cg, 'Session.request');
    expect(match).not.toBeNull();
    expect(match!.node.kind).toBe('method');
    expect(match!.node.qualifiedName).toContain('Session::request');
  });
});

describe.skipIf(!HAS_SQLITE)('solidkg_trace duplicate-symbol disambiguation', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const src = projectRoot;
    const providers = path.join(src, 'providers');
    fs.mkdirSync(providers, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'agent.py'),
      `from backend import _search_tavily\n\ndef search():\n    return _search_tavily()\n`
    );
    fs.writeFileSync(
      path.join(src, 'backend.py'),
      `from providers.web import search\n\ndef _search_tavily():\n    value = search()\n    return normalize_results(value)\n\ndef normalize_results(value):\n    return value\n`
    );
    fs.writeFileSync(
      path.join(providers, 'web.py'),
      `def search():\n    return "web result"\n`
    );

    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['**/*.py'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('aggregate callees control still lists duplicate unqualified symbols without trace-style ambiguity abstention', async () => {
    const result = await handler.execute('solidkg_callees', { symbol: 'search', limit: 10 });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Callees of search');
    expect(text).toContain('_search_tavily');
    expect(text).toMatch(/Aggregated results across \d+ symbols named "search"/);
    expect(text).toContain('agent.py:');
    expect(text).toContain('providers/web.py:');
    expect(text).not.toContain('Ambiguous symbol "search"');
    expect(text).not.toContain('qualified or path-qualified');
  });

  it('asks for a qualified symbol instead of tracing arbitrary duplicate unqualified endpoints', async () => {
    const result = await handler.execute('solidkg_trace', { from: 'search', to: '_search_tavily' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Ambiguous symbol "search"');
    expect(text).toContain('Uncertainty: ambiguous_symbol');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('requires_focused_follow_up');
    expect(text).toContain('qualify_symbol');
    expect(text).toContain('agent.py:');
    expect(text).toContain('providers/web.py:');
    expect(text).toContain('qualified or path-qualified');
    expect(text).not.toContain('## Trace: search');
  });

  it('reports ambiguity when the duplicate unqualified callable is the trace destination', async () => {
    const result = await handler.execute('solidkg_trace', { from: '_search_tavily', to: 'search' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Ambiguous symbol "search"');
    expect(text).toContain('Uncertainty: ambiguous_symbol');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('requires_focused_follow_up');
    expect(text).toContain('qualify_symbol');
    expect(text).toContain('multiple callable endpoints match this unqualified name');
    expect(text).toContain('Candidates:');
    expect(text).toContain('agent.py:');
    expect(text).toContain('providers/web.py:');
    expect(text).toContain('qualified or path-qualified');
    expect(text).not.toContain('## Trace: _search_tavily');
  });

  it('explains explore-flow ambiguity instead of silently omitting or stitching duplicate unqualified callables', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'search _search_tavily normalize_results',
      maxFiles: 3,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Ambiguous symbol "search"');
    expect(text).toContain('Uncertainty: ambiguous_symbol');
    expect(text).toContain('multiple callable endpoints match this unqualified name');
    expect(text).toContain('solidkg_explore omitted the Flow section');
    expect(text).toContain('agent.py:');
    expect(text).toContain('providers/web.py:');
    expect(text).toContain('qualified or path-qualified');
    expect(text).not.toContain('## Flow (call path among the symbols you queried)');
    expect(text).not.toContain('1. search (agent.py:3)');
  });

  it('traces normally when duplicate endpoints are path-qualified', async () => {
    const result = await handler.execute('solidkg_trace', {
      from: 'agent/search',
      to: 'backend/_search_tavily',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Trace: agent/search');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('explain_returned_evidence');
    expect(text).toContain('localize_candidate');
    expect(text).not.toContain('safe_to_edit');
    expect(text).not.toContain('safe_to_review');
    expect(text).toContain('_search_tavily');
    expect(text).toContain('backend.py');
  });

  it('reports no static path as a frontier, not proof of absence', async () => {
    const result = await handler.execute('solidkg_trace', {
      from: 'providers/web.py::search',
      to: 'backend.py::normalize_results',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('No static path found from "providers/web.py::search" to "backend.py::normalize_results". This is not proof of absence.');
    expect(text).toContain('Frontier: search (providers/web.py:1)');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('requires_focused_follow_up');
    expect(text).toContain('inspect_frontier');
    expect(text).not.toContain('## Trace: providers/web.py::search');
  });

  it('does not trace a qualified endpoint by falling back to an unrelated same-tail symbol', async () => {
    const result = await handler.execute('solidkg_trace', {
      from: 'missing_agent/search',
      to: 'backend/_search_tavily',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('Symbol "missing_agent/search" not found');
    expect(text).toContain('Uncertainty: bounded_no_results');
    expect(text).not.toContain('## Trace: missing_agent/search');
    expect(text).not.toContain('1. search (agent.py:3-4)');
  });

  it('omits explore-flow for a qualified query token with no exact symbol match', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'missing_agent/search backend/_search_tavily normalize_results',
      maxFiles: 3,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Exploration: missing_agent/search backend/_search_tavily normalize_results');
    expect(text).not.toContain('## Flow (call path among the symbols you queried)');
    expect(text).not.toContain('1. search (agent.py:3)');
  });
});

describe.skipIf(!HAS_SQLITE)('solidkg_trace qualified endpoint lookup', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const scipDir = path.join(projectRoot, 'src', 'scip');
    fs.mkdirSync(scipDir, { recursive: true });
    fs.writeFileSync(
      path.join(scipDir, 'index.ts'),
      `import { runCommand } from '../runner';\n\nexport function generateScipIndexes(): string {\n  return runCommand();\n}\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'runner.ts'),
      `export function runCommand(): string {\n  return 'ran';\n}\n`,
    );

    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('accepts file::symbol endpoints without splitting dotted file extensions into qualifiers', async () => {
    const result = await handler.execute('solidkg_trace', {
      from: 'src/scip/index.ts::generateScipIndexes',
      to: 'src/runner.ts::runCommand',
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Trace: src/scip/index.ts::generateScipIndexes');
    expect(text).toContain('generateScipIndexes');
    expect(text).toContain('runCommand');
    expect(text).not.toContain('not found');
  });
});

describe.skipIf(!HAS_SQLITE)('solidkg_trace truncation keeps answer packets', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const srcDir = path.join(projectRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const chainLength = 7;
    const sinkCount = 4;
    for (let i = 0; i < chainLength; i++) {
      const nextCall = i < chainLength - 1
        ? `  return step${i + 1}();\n`
        : `${Array.from({ length: sinkCount }, (_, sinkIndex) => `  sink${sinkIndex}();`).join('\n')}\n  return 1;\n`;
      const fillerLines = Array.from({ length: 160 }, (_, line) => `  const pad_${i}_${line} = ${line};`).join('\n');
      fs.writeFileSync(
        path.join(srcDir, `step${i}.ts`),
        `export function step${i}(): number {\n${fillerLines}\n${nextCall}}\n`
      );
    }

    for (let sinkIndex = 0; sinkIndex < sinkCount; sinkIndex++) {
      const sinkFill = Array.from({ length: 120 }, (_, line) => `  const sink_pad_${sinkIndex}_${line} = ${line};`).join('\n');
      fs.writeFileSync(
        path.join(srcDir, `sink${sinkIndex}.ts`),
        `export function sink${sinkIndex}(): number {\n${sinkFill}\n  return ${sinkIndex};\n}\n`
      );
    }

    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('keeps the answer packet visible when the trace output is truncated', async () => {
    const result = await handler.execute('solidkg_trace', { from: 'step0', to: 'step6' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Trace: step0 → step6');
    expect(text).toContain('### Answer Packet');
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('Eligible actions: explain_returned_evidence, localize_candidate');
    expect(text).toContain('Blockers: none');
    expect(text).toContain('Source coverage: truncated');
    expect(text).not.toContain('Suggested next SolidKG tools: solidkg_node');
    expect(text).toContain('... (output truncated)');
  });
});

describe.skipIf(!HAS_SQLITE)('solidkg_trace final output cap downgrades actionability', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const srcDir = path.join(projectRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const linePayload = '"' + 'x'.repeat(52) + '"';
    const chainLength = 7;
    for (let i = 0; i < chainLength; i++) {
      const fillerLines = Array.from({ length: 20 }, (_, line) => `  const pad_${i}_${line} = ${linePayload};`).join('\n');
      const nextCall = i < chainLength - 1
        ? `  return step${i + 1}();\n`
        : `${Array.from({ length: 6 }, (_, sinkIndex) => `  sink${sinkIndex}();`).join('\n')}\n  return 1;\n`;
      fs.writeFileSync(
        path.join(srcDir, `step${i}.ts`),
        `export function step${i}(): number {\n${fillerLines}\n${nextCall}}\n`,
      );
    }

    for (let sinkIndex = 0; sinkIndex < 6; sinkIndex++) {
      const sinkFill = Array.from({ length: 7 }, (_, line) => `  const sink_pad_${sinkIndex}_${line} = ${linePayload};`).join('\n');
      fs.writeFileSync(
        path.join(srcDir, `sink${sinkIndex}.ts`),
        `export function sink${sinkIndex}(): number {\n${sinkFill}\n  return ${sinkIndex};\n}\n`,
      );
    }

    const SolidKG = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = SolidKG.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('does not claim complete source when the final trace response is output-truncated', async () => {
    const result = await handler.execute('solidkg_trace', { from: 'step0', to: 'step6' });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('## Trace: step0 → step6');
    expect(text).toContain('### Answer Packet');
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).toContain('Returned evidence actionability:');
    expect(text).toContain('Eligible actions: explain_returned_evidence, localize_candidate');
    expect(text).toContain('Blockers: none');
    expect(text).toContain('Source coverage: truncated');
    expect(text).toContain('with bounded returned source');
    expect(text).not.toContain('Full execution path below');
    expect(text).not.toContain('Full path + every hop body');
    expect(text).toContain('... (output truncated)');
  });
});
