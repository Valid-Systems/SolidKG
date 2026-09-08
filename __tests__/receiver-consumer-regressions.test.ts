/// <reference types="node" />

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { createResolver } from '../src/resolution';
import type { Edge, Node, UnresolvedReference } from '../src/types';

const FIXTURES: Readonly<Record<string, string>> = {
  'src/service.ts': `
export class Service {
  run(): void {}
  static build(): void {}
  make(): void {
    class Inner { run(): void {} }
    new Inner().run();
  }
}
export class DefaultService { run(): void {} }
export default DefaultService
export function namespaceTarget(): void {}
export function namespaceDecoy(): void {}
`,
  'src/missing-class.ts': `
export function missingTarget(): void {}
`,
  'src/other.ts': `
export class Service {
  run(): void {}
  static build(): void {}
}
`,
  'src/main.ts': `
import DefaultService from './service';
import { Service as DirectService } from './service';
import * as api from './service';
import * as missing from './missing-class';

class Service { run(): void {} }
export function directConsumer(): void { new DirectService().run(); }
export function defaultConsumer(): void { new DefaultService().run(); }
export function namespaceConsumer(): void { api.namespaceTarget(); }
export function typedNamespaceConsumer(service: api.Service): void { service.run(); }
export function constructedNamespaceConsumer(): void { new api.Service().run(); }
export function staticNamespaceConsumer(): void { api.Service.build(); }
export function missingNamespaceClassConsumer(): void { new missing.Service().run(); }
export function invalidNamespaceAuthority(): void {}
export function invalidNamespaceClassAuthority(): void {}
export function missingNamespaceAuthority(): void {}
`,
};

interface ResolutionFixture {
  readonly edges: readonly Edge[];
  readonly nodes: readonly Node[];
}

const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function requireNode(nodes: readonly Node[], predicate: (node: Node) => boolean, label: string): Node {
  const node = nodes.find(predicate);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}

function hasCall(edges: readonly Edge[], source: Node, target: Node): boolean {
  return edges.some((edge) => edge.kind === 'calls' && edge.source === source.id && edge.target === target.id);
}

async function resolvePersistedFixture(): Promise<ResolutionFixture> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-receiver-consumer-'));
  temporaryDirectories.push(projectRoot);
  for (const [relativePath, source] of Object.entries(FIXTURES)) {
    const absolutePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }

  const databasePath = path.join(projectRoot, '.solidkg', 'graph.db');
  let connection: DatabaseConnection | undefined = DatabaseConnection.initialize(databasePath);
  try {
    let queries = new QueryBuilder(connection.getDb());
    for (const [filePath, source] of Object.entries(FIXTURES)) {
      const extracted = extractFromSource(filePath, source, 'typescript');
      expect(extracted.errors).toEqual([]);
      queries.upsertFile({
        path: filePath,
        contentHash: source,
        language: 'typescript',
        size: Buffer.byteLength(source),
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: extracted.nodes.length,
      });
      queries.insertNodes(extracted.nodes);
      queries.insertEdges(extracted.edges);
      queries.insertUnresolvedRefsBatch(extracted.unresolvedReferences);
    }

    const caller = requireNode(
      queries.getAllNodes(),
      (node) => node.kind === 'function' && node.name === 'invalidNamespaceAuthority',
      'invalid namespace authority caller',
    );
    const missingAuthorityCaller = requireNode(
      queries.getAllNodes(),
      (node) => node.kind === 'function' && node.name === 'missingNamespaceAuthority',
      'missing namespace authority caller',
    );
    const invalidClassAuthorityCaller = requireNode(
      queries.getAllNodes(),
      (node) => node.kind === 'function' && node.name === 'invalidNamespaceClassAuthority',
      'invalid namespace class authority caller',
    );
    const invalidAuthorities = [
      { caller, exportPath: ['namespaceDecoy'] },
      { caller: missingAuthorityCaller, exportPath: [] },
      { caller: invalidClassAuthorityCaller, exportPath: ['Service', 'run'] },
    ].map(({ caller: authorityCaller, exportPath }) => ({
      fromNodeId: authorityCaller.id,
      referenceName: exportPath[0] === 'Service' ? 'api.Service.run' : 'api.namespaceTarget',
      referenceKind: 'calls',
      line: authorityCaller.startLine,
      column: authorityCaller.startColumn,
      filePath: 'src/main.ts',
      language: 'typescript',
      memberCall: {
        receiver: exportPath[0] === 'Service' ? 'api.Service' : 'api',
        member: exportPath[0] === 'Service' ? 'run' : 'namespaceTarget',
        binding: {
          kind: 'import',
          localName: 'api',
          exportPath,
          access: exportPath[0] === 'Service' ? 'instance' : 'namespace',
        },
      },
    } satisfies UnresolvedReference));
    queries.insertUnresolvedRefsBatch(invalidAuthorities);

    connection.close();
    connection = DatabaseConnection.open(databasePath);
    queries = new QueryBuilder(connection.getDb());
    await createResolver(projectRoot, queries).resolveAndPersistBatched(undefined, 1);
    return { edges: queries.getAllEdges(), nodes: queries.getAllNodes() };
  } finally {
    connection?.close();
  }
}

describe('receiver consumer resolution after reopening SQLite', () => {
  it('resolves only the direct Service.run member, not a nested descendant', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, (node) => node.kind === 'function' && node.name === 'directConsumer', 'direct consumer');
    const directRun = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/service.ts',
      'direct Service run',
    );
    const nestedRun = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::make::Inner::run',
      'nested Service run',
    );

    expect(hasCall(fixture.edges, caller, directRun)).toBe(true);
    expect(hasCall(fixture.edges, caller, nestedRun)).toBe(false);
  });

  it('resolves a default-imported class when its default export omits a semicolon', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, (node) => node.kind === 'function' && node.name === 'defaultConsumer', 'default consumer');
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'DefaultService::run',
      'default service run',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('preserves namespace-imported free-function resolution', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'namespaceConsumer',
      'namespace consumer',
    );
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'namespaceTarget',
      'namespace target',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('resolves a namespace-imported class member from a typed receiver', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'typedNamespaceConsumer',
      'typed namespace consumer',
    );
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/service.ts',
      'namespace Service run',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('resolves a namespace-imported class member from a constructed receiver', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'constructedNamespaceConsumer',
      'constructed namespace consumer',
    );
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/service.ts',
      'namespace Service run',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('resolves a namespace-imported class static member', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'staticNamespaceConsumer',
      'static namespace consumer',
    );
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::build' && node.filePath === 'src/service.ts',
      'namespace Service build',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('abstains when a namespace member binding has wrong or missing export-path authority', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'invalidNamespaceAuthority',
      'invalid namespace authority caller',
    );
    const missingAuthorityCaller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'missingNamespaceAuthority',
      'missing namespace authority caller',
    );
    const invalidClassAuthorityCaller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'invalidNamespaceClassAuthority',
      'invalid namespace class authority caller',
    );
    const missingClassCaller = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'missingNamespaceClassConsumer',
      'missing namespace class consumer',
    );
    const target = requireNode(
      fixture.nodes,
      (node) => node.kind === 'function' && node.name === 'namespaceTarget',
      'namespace target',
    );
    const actualServiceRun = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/service.ts',
      'actual Service run',
    );
    const localDecoyRun = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/main.ts',
      'local Service decoy run',
    );
    const otherFileDecoyRun = requireNode(
      fixture.nodes,
      (node) => node.kind === 'method' && node.qualifiedName === 'Service::run' && node.filePath === 'src/other.ts',
      'other-file Service decoy run',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(false);
    expect(hasCall(fixture.edges, missingAuthorityCaller, target)).toBe(false);
    expect(hasCall(fixture.edges, invalidClassAuthorityCaller, actualServiceRun)).toBe(false);
    expect(hasCall(fixture.edges, missingClassCaller, localDecoyRun)).toBe(false);
    expect(hasCall(fixture.edges, missingClassCaller, otherFileDecoyRun)).toBe(false);
  });
});
