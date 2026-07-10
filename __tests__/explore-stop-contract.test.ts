import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('solidkg_explore stop contract', () => {
  let projectRoot: string;
  let graph: SolidKG;
  let handler: ToolHandler;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-explore-stop-'));
    const sourceRoot = path.join(projectRoot, 'src');
    fs.mkdirSync(sourceRoot);

    fs.writeFileSync(
      path.join(sourceRoot, 'build-request.ts'),
      [
        "import { SendRequest } from './send-request';",
        'export function BuildRequest(): string {',
        '  return SendRequest();',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'send-request.ts'),
      [
        "import { ValidateResponse } from './validate-response';",
        'export function SendRequest(): string {',
        '  return ValidateResponse();',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'validate-response.ts'),
      [
        'export function ValidateResponse(): string {',
        "  return 'valid';",
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'socket.ts'),
      "export function send(): string { return 'socket'; }\n",
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'concurrency.ts'),
      "export function send(): string { return 'concurrency'; }\n",
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'router.ts'),
      [
        'export function RouteRequest(): string {',
        '  return ExecuteMiddleware();',
        '}',
        'export function ExecuteMiddleware(): string {',
        "  return 'handled';",
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'router_test.ts'),
      [
        "export function RouteRequest(): string { return 'test-double'; }",
        ...Array.from(
          { length: 30 },
          (_, index) => `export function TestRoute${index}(): string { return RouteRequest(); }`,
        ),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'large-flow.ts'),
      [
        'export function LargeStart(): number {',
        ...Array.from({ length: 500 }, (_, index) => `  const value${index} = ${index};`),
        '  return LargeEnd();',
        '}',
        'export function LargeEnd(): number { return 500; }',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(sourceRoot, 'theme.ts'), 'export const VS = "theme";\n');
    fs.writeFileSync(
      path.join(sourceRoot, 'extension-host.ts'),
      'export class ExtensionHostManager { start(): string { return "extension-host"; } }\nexport class RPCProtocol {}\n',
    );
    for (const name of ['ExactBreadthA', 'ExactBreadthB', 'ExactBreadthC', 'ExactBreadthD', 'ExactBreadthE']) {
      fs.writeFileSync(
        path.join(sourceRoot, `${name}.ts`),
        [
          `export class ${name} {`,
          ...Array.from({ length: 250 }, (_, index) => `  method${index}(): number { return ${index}; }`),
          '}',
        ].join('\n'),
      );
    }

    graph = SolidKG.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await graph.indexAll();
    handler = new ToolHandler(graph);
  });

  afterAll(() => {
    handler?.closeAll();
    graph?.destroy();
    if (projectRoot && fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not treat generic natural-language verbs as ambiguous flow endpoints', async () => {
    // Given duplicate callable names for an ordinary prose verb
    // When a user asks a natural-language architecture question
    const result = await handler.execute('solidkg_explore', {
      query: 'How does this system build, send, and validate a request?',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    // Then the answer is not poisoned by symbol-level ambiguity guidance
    expect(text).not.toContain('Ambiguous symbol "send"');
    expect(text).not.toContain('Uncertainty: ambiguous_symbol');
  });

  it('reports answer sufficiency when required source is returned and peripheral candidates are omitted', async () => {
    // Given a three-file flow and a one-file output budget
    // When explore returns the highest-priority required source
    const result = await handler.execute('solidkg_explore', {
      query: 'BuildRequest SendRequest ValidateResponse',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    // Then omitted peripheral candidates remain coverage metadata, not a stop blocker
    expect(text).toMatch(/Source completeness:\s*omitted/i);
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).not.toContain('Suggested next SolidKG tools:');
  });

  it('selects production source before filename-based test files', async () => {
    // Given a highly connected *_test.ts file sharing a production symbol name
    // When source allocation has room for one file
    const result = await handler.execute('solidkg_explore', {
      query: 'RouteRequest',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    // Then the production implementation owns the source budget
    expect(text).toContain('#### src/router.ts');
    expect(text).not.toContain('#### src/router_test.ts');
    expect(text).toContain("return 'handled'");
  });

  it('ranks specific identifiers before short acronyms in natural-language questions', async () => {
    // Given a broad acronym and the specific implementation symbols required by the question
    // When only one source file fits in the answer
    const result = await handler.execute('solidkg_explore', {
      query: 'How does VS use ExtensionHostManager and RPCProtocol for extension startup?',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    // Then the specific implementation wins the source allocation
    expect(text).toContain('src/extension-host.ts');
    expect(text).toContain('return "extension-host"');
    expect(text).not.toContain('src/theme.ts');
  });

  it('treats bounded source windows as sufficient when selected answer source is present', async () => {
    // Given a required implementation larger than the per-file source window
    // When explore returns its bounded production source
    const result = await handler.execute('solidkg_explore', {
      query: 'LargeStart LargeEnd',
      maxFiles: 1,
    });
    const text = result.content?.[0]?.text ?? '';

    // Then truncation remains metadata instead of forcing another retrieval turn
    expect(text).toMatch(/Source completeness:\s*truncated/i);
    expect(text).toContain('Binary sufficiency: sufficient');
    expect(text).not.toContain('Suggested next SolidKG tools:');
  });

  it('does not resolve every prose word as a separate symbol search', async () => {
    // Given a natural-language query containing explicit class names
    const searchSpy = vi.spyOn(graph, 'searchNodes');

    // When automatic flow detection examines the prose
    handler['buildFlowFromNamedSymbols'](
      graph,
      'LocalProcessExtensionHost start communication handshake ExtensionHostStarter createExtensionHost message port Protocol RPCProtocol VS Code files',
    );

    // Then flow detection does not multiply expensive index searches by word count
    expect(searchSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  it('loads indexed root labels at most once while reading answer source', async () => {
    // Given multiple selected source files in one answer
    const filesSpy = vi.spyOn(graph, 'getFiles');

    // When explore resolves each indexed path to current on-disk source
    await handler.execute('solidkg_explore', {
      query: 'BuildRequest SendRequest ValidateResponse',
      maxFiles: 3,
    });

    // Then repository-wide file metadata is not rescanned for every source block
    expect(filesSpy.mock.calls.length).toBeLessThanOrEqual(1);
    filesSpy.mockRestore();
  });

  it('bounds exact-symbol augmentation for long natural-language questions', async () => {
    // Given a prose query containing many class, acronym, and ordinary-word tokens
    const searchSpy = vi.spyOn(graph, 'searchNodes');

    // When explore selects explicit symbol anchors
    await handler.execute('solidkg_explore', {
      query: 'How does the VS Code extension host communicate with the main process? Trace startup and bidirectional IPC RPC between renderer workbench ExtensionHostProcessWorker ExtensionHostMain protocol MessagePort NamedPipe socket MainThreadCustomers ExtHostCustomers.',
      maxFiles: 4,
    });

    // Then one prose sentence cannot trigger an unbounded series of index searches
    expect(searchSpy.mock.calls.length).toBeLessThanOrEqual(12);
    searchSpy.mockRestore();
  });

  it('bounds retrieval expansion for path-heavy precise queries', async () => {
    // Given several exact files and symbols in one focused source query
    const searchSpy = vi.spyOn(graph, 'searchNodes');

    // When explore expands those anchors into answer source
    await handler.execute('solidkg_explore', {
      query: 'src/extension-host.ts ExtensionHostManager RPCProtocol; src/router.ts BuildRequest HandleRequest; src/large-flow.ts LargeStart LargeEnd',
      maxFiles: 4,
    });

    // Then exact anchors do not multiply into an unbounded search loop
    expect(searchSpy.mock.calls.length).toBeLessThanOrEqual(30);
    searchSpy.mockRestore();
  });

  it('spreads the output budget across several explicitly named implementations', async () => {
    const result = await handler.execute('solidkg_explore', {
      query: 'ExactBreadthA ExactBreadthB ExactBreadthC ExactBreadthD ExactBreadthE',
      maxFiles: 5,
    });
    const text = result.content?.[0]?.text ?? '';

    for (const name of ['ExactBreadthA', 'ExactBreadthB', 'ExactBreadthC', 'ExactBreadthD', 'ExactBreadthE']) {
      expect(text).toContain(`src/${name}.ts`);
    }
  });

  it('does not rebuild a second adjacency index for glue expansion on large repositories', async () => {
    // Given a repository above the large-project threshold
    const realStats = graph.getStats();
    const statsSpy = vi.spyOn(graph, 'getStats').mockReturnValue({ ...realStats, fileCount: 6_000 });
    const contextSpy = vi.spyOn(graph, 'findRelevantContext');
    const callersSpy = vi.spyOn(graph, 'getCallers');

    // When findRelevantContext has already traversed the answer graph
    await handler.execute('solidkg_explore', {
      query: 'BuildRequest SendRequest ValidateResponse',
      maxFiles: 3,
    });

    // Then explore does not pay for a second repository-wide adjacency build
    expect(callersSpy).not.toHaveBeenCalled();
    expect(contextSpy).toHaveBeenCalledWith(
      'BuildRequest SendRequest ValidateResponse',
      expect.objectContaining({ searchLimit: 6, traversalDepth: 2, maxNodes: 120 }),
    );
    callersSpy.mockRestore();
    contextSpy.mockRestore();
    statsSpy.mockRestore();
  });
});
