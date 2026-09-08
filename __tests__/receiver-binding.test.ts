// allow: SIZE_OK - fixture data covers the specified persisted receiver-binding matrix.
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
import type { Edge, Node } from '../src/types';

const FIXTURES: Readonly<Record<string, string>> = {
  'src/service.ts': `
export class Service {
  instanceShared(): void {}
  static instanceShared(): void {}
  static staticShared(): void {}
  same(): void {}
  static same(): void {}
}
export default class DefaultService { run(): void {} }
export class Cache { get(): void {} }
export class LRUCache { get(): void {} }
export class Decoy { instanceShared(): void {} missing(): void {} }
export function namespaceTarget(): void {}
`,
  'src/main.ts': `
import DefaultService, {
  Cache as ImportedCache,
  LRUCache as ImportedLRUCache,
  Service as ImportedService,
} from './service';
import * as api from './service';

class Cache { get(): void {} }
class LRUCache { get(): void {} }

export function typed(client: ImportedService): void { client.instanceShared(); }
export function constructed(): void {
  const client = new ImportedService();
  client.instanceShared();
  ImportedService.staticShared();
}
export function instanceSame(): void { new ImportedService().same(); }
export function staticSame(): void { ImportedService.same(); }
export function defaultImport(): void { new DefaultService().run(); }
export function namespaceImport(): void { api.namespaceTarget(); }
export function importedCache(): void { new ImportedCache().get(); }
export function importedLRUCache(): void { new ImportedLRUCache().get(); }
export function outerCache(): void { new Cache().get(); }
export function outerLRUCache(): void { new LRUCache().get(); }
export function nestedCache(): void {
  class Cache { get(): void {} }
  new Cache().get();
}
export function nestedLRUCache(): void {
  class LRUCache { get(): void {} }
  new LRUCache().get();
}
export function shadowImportedClass(): void {
  class ImportedService { instanceShared(): void {} }
  new ImportedService().instanceShared();
}
export function afterShadow(client: ImportedService): void { client.instanceShared(); }
export function sameNameAnnotation(ImportedService: ImportedService): void { ImportedService.instanceShared(); }
export function missingImported(client: ImportedService): void { client.missing(); }
export function unknown(): void {
  getClient().instanceShared();
  new Map().instanceShared();
}
function getClient(): unknown { return {}; }
`,
};

interface ResolutionFixture {
  readonly edges: readonly Edge[];
  readonly nodes: readonly Node[];
}

let tempDir: string | undefined;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
});

function findNode(nodes: readonly Node[], label: string, predicate: (node: Node) => boolean): Node {
  const node = nodes.find(predicate);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}

async function resolvePersistedFixture(): Promise<ResolutionFixture> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-receiver-binding-'));
  tempDir = projectRoot;
  for (const [relativePath, source] of Object.entries(FIXTURES)) {
    const absolutePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }

  const dbPath = path.join(projectRoot, '.solidkg', 'graph.db');
  let connection: DatabaseConnection | undefined = DatabaseConnection.initialize(dbPath);
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

    connection.close();
    connection = DatabaseConnection.open(dbPath);
    queries = new QueryBuilder(connection.getDb());
    await createResolver(projectRoot, queries).resolveAndPersistBatched(undefined, 1);
    return { edges: queries.getAllEdges(), nodes: queries.getAllNodes() };
  } finally {
    connection?.close();
  }
}

function expectCall(
  fixture: ResolutionFixture,
  callerName: string,
  targetLabel: string,
  targetPredicate: (node: Node) => boolean,
): void {
  const caller = findNode(fixture.nodes, `caller ${callerName}`, (node) =>
    node.kind === 'function' && node.name === callerName && node.filePath === 'src/main.ts'
  );
  const target = findNode(fixture.nodes, targetLabel, targetPredicate);
  expect(fixture.edges.some((edge) =>
    edge.kind === 'calls' && edge.source === caller.id && edge.target === target.id
  )).toBe(true);
}

function expectNoCall(
  fixture: ResolutionFixture,
  callerName: string,
  targetLabel: string,
  targetPredicate: (node: Node) => boolean,
): void {
  const caller = findNode(fixture.nodes, `caller ${callerName}`, (node) =>
    node.kind === 'function' && node.name === callerName && node.filePath === 'src/main.ts'
  );
  const target = findNode(fixture.nodes, targetLabel, targetPredicate);
  expect(fixture.edges.some((edge) =>
    edge.kind === 'calls' && edge.source === caller.id && edge.target === target.id
  )).toBe(false);
}

describe('persisted receiver binding', () => {
  it('resolves type, constructor, alias, default, namespace, and static owners after reopen', async () => {
    const fixture = await resolvePersistedFixture();
    const serviceInstance = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Service::instanceShared' && !node.isStatic;
    expectCall(fixture, 'typed', 'Service.instanceShared', serviceInstance);
    expectCall(fixture, 'constructed', 'Service.instanceShared', serviceInstance);
    expectCall(fixture, 'constructed', 'Service.staticShared', (node) =>
      node.kind === 'method' && node.qualifiedName === 'Service::staticShared' && node.isStatic === true
    );
    expectCall(fixture, 'sameNameAnnotation', 'instance Service.instanceShared', (node) =>
      node.kind === 'method' && node.qualifiedName === 'Service::instanceShared' && !node.isStatic
    );
    expectNoCall(fixture, 'sameNameAnnotation', 'static Service.instanceShared', (node) =>
      node.kind === 'method' && node.qualifiedName === 'Service::instanceShared' && node.isStatic === true
    );
    expectCall(fixture, 'defaultImport', 'DefaultService.run', (node) =>
      node.kind === 'method' && node.qualifiedName === 'DefaultService::run'
    );
    expectCall(fixture, 'namespaceImport', 'namespaceTarget', (node) =>
      node.kind === 'function' && node.name === 'namespaceTarget' && node.filePath === 'src/service.ts'
    );
  });

  it('preserves instance/static polarity for same-named methods after reopened batch resolution', async () => {
    const fixture = await resolvePersistedFixture();
    const instanceSame = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Service::same' && !node.isStatic;
    const staticSame = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Service::same' && node.isStatic === true;
    expectCall(fixture, 'instanceSame', 'instance Service.same', instanceSame);
    expectNoCall(fixture, 'instanceSame', 'static Service.same', staticSame);
    expectCall(fixture, 'staticSame', 'static Service.same', staticSame);
    expectNoCall(fixture, 'staticSame', 'instance Service.same', instanceSame);
  });

  it('uses nearest lexical Cache and LRUCache owners instead of imported or sibling classes', async () => {
    const fixture = await resolvePersistedFixture();
    const importedCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/service.ts' && node.qualifiedName === 'Cache::get';
    const importedLRUCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/service.ts' && node.qualifiedName === 'LRUCache::get';
    const localCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/main.ts' && node.qualifiedName === 'Cache::get';
    const localLRUCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/main.ts' && node.qualifiedName === 'LRUCache::get';
    const nestedCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/main.ts' && node.qualifiedName === 'nestedCache::Cache::get';
    const nestedLRUCache = (node: Node) => node.kind === 'method' && node.filePath === 'src/main.ts' && node.qualifiedName === 'nestedLRUCache::LRUCache::get';
    expectCall(fixture, 'importedCache', 'imported Cache.get', importedCache);
    expectCall(fixture, 'importedLRUCache', 'imported LRUCache.get', importedLRUCache);
    expectCall(fixture, 'outerCache', 'local Cache.get', localCache);
    expectNoCall(fixture, 'outerCache', 'imported Cache.get', importedCache);
    expectCall(fixture, 'outerLRUCache', 'local LRUCache.get', localLRUCache);
    expectNoCall(fixture, 'outerLRUCache', 'imported LRUCache.get', importedLRUCache);
    expectCall(fixture, 'nestedCache', 'nested Cache.get', nestedCache);
    expectCall(fixture, 'nestedLRUCache', 'nested LRUCache.get', nestedLRUCache);
  });

  it('does not bind shadowed, missing, unknown, or computed receivers to wrong-class methods', async () => {
    const fixture = await resolvePersistedFixture();
    const serviceInstance = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Service::instanceShared' && !node.isStatic;
    const decoyInstance = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Decoy::instanceShared';
    const decoyMissing = (node: Node) => node.kind === 'method' && node.qualifiedName === 'Decoy::missing';
    expectCall(fixture, 'afterShadow', 'imported Service.instanceShared', serviceInstance);
    expectNoCall(fixture, 'shadowImportedClass', 'imported Service.instanceShared', serviceInstance);
    expectNoCall(fixture, 'missingImported', 'Decoy.missing', decoyMissing);
    expectNoCall(fixture, 'unknown', 'Service.instanceShared', serviceInstance);
    expectNoCall(fixture, 'unknown', 'Decoy.instanceShared', decoyInstance);
  });
});
