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

const FIXTURES = [
  {
    filePath: 'src/foreign.ts',
    language: 'typescript' as const,
    source: 'export function foreign(): void { function foreignVisit(): void {} }\n',
  },
  {
    filePath: 'src/caller.ts',
    language: 'typescript' as const,
    source: 'export function caller(): void { foreignVisit(); }\n',
  },
  {
    filePath: 'src/local.ts',
    language: 'typescript' as const,
    source: 'export function local(): void { function localVisit(): void {} localVisit(); }\n',
  },
  {
    filePath: 'src/exported.ts',
    language: 'typescript' as const,
    source: 'export function exportedAliasTarget(): void {}\n',
  },
  {
    filePath: 'src/imported-caller.ts',
    language: 'typescript' as const,
    source: "import { exportedAliasTarget as aliasedAliasTarget } from './exported'; export function importedCaller(): void { aliasedAliasTarget(); }\n",
  },
  {
    filePath: 'src/foreign.py',
    language: 'python' as const,
    source: 'def foreign():\n    def crossLanguageVisit():\n        return None\n',
  },
  {
    filePath: 'src/cross-language-caller.ts',
    language: 'typescript' as const,
    source: 'export function crossLanguageCaller(): void { crossLanguageVisit(); }\n',
  },
  {
    filePath: 'src/foreign-parent.ts',
    language: 'typescript' as const,
    source: 'export function sharedParent(): void { function sharedParentVisit(): void {} }\n',
  },
  {
    filePath: 'src/cross-file-parent.ts',
    language: 'typescript' as const,
    source: 'export function sharedParent(): void { function parentCaller(): void { sharedParentVisit(); } }\n',
  },
  {
    filePath: 'src/inconsistent-target.ts',
    language: 'typescript' as const,
    source: 'export function inconsistentHost(): void { function mismatchedTarget(): void {} }\n',
  },
  {
    filePath: 'src/inconsistent-caller.ts',
    language: 'typescript' as const,
    source: 'export function inconsistentCaller(): void { mismatchedTarget(); }\n',
  },
  {
    filePath: 'src/deep.ts',
    language: 'typescript' as const,
    source: 'export function deepOuter(): void { function deepMiddle(): void { function deepLocalChild(): void {} deepLocalChild(); } deepMiddle(); }\n',
  },
  {
    filePath: 'src/deep-decoy.ts',
    language: 'typescript' as const,
    source: 'export function deepDecoy(): void { function deepLocalChild(): void {} }\n',
  },
  {
    filePath: 'src/constructor.py',
    language: 'python' as const,
    source: 'class UserService:\n    pass\n\ndef bootstrap():\n    return UserService()\n',
  },
  {
    filePath: 'src/config.ts',
    language: 'typescript' as const,
    source: "export const siteURL = 'https://registry.example';\n",
  },
  {
    filePath: 'src/variable-caller.ts',
    language: 'typescript' as const,
    source: 'export function variableCaller(): void { siteURL(); }\n',
  },
] as const;

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

function requireNode(nodes: readonly Node[], label: string, predicate: (node: Node) => boolean): Node {
  const node = nodes.find(predicate);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}

async function resolvePersistedFixture(): Promise<{
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly references: readonly UnresolvedReference[];
}> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-callable-visibility-'));
  temporaryDirectories.push(projectRoot);
  const databasePath = path.join(projectRoot, '.solidkg', 'graph.db');
  let connection: DatabaseConnection | undefined = DatabaseConnection.initialize(databasePath);

  try {
    let queries = new QueryBuilder(connection.getDb());
    const references: UnresolvedReference[] = [];
    for (const fixture of FIXTURES) {
      const sourcePath = path.join(projectRoot, fixture.filePath);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, fixture.source);
      const extracted = extractFromSource(fixture.filePath, fixture.source, fixture.language);
      expect(extracted.errors).toEqual([]);
      const fixtureReferences = [...extracted.unresolvedReferences];
      if (fixture.filePath === 'src/inconsistent-caller.ts') {
        const mismatchedReference = fixtureReferences.find(
          (reference) => reference.referenceName === 'mismatchedTarget',
        );
        if (!mismatchedReference) throw new Error('Missing mismatched target reference');
        fixtureReferences.push({ ...mismatchedReference, filePath: 'src/missing.ts' });
      }
      references.push(...fixtureReferences);
      queries.upsertFile({
        path: fixture.filePath,
        contentHash: fixture.source,
        language: fixture.language,
        size: Buffer.byteLength(fixture.source),
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: extracted.nodes.length,
      });
      queries.insertNodes(extracted.nodes);
      queries.insertEdges(extracted.edges);
      queries.insertUnresolvedRefsBatch(fixtureReferences);
    }

    connection.close();
    connection = DatabaseConnection.open(databasePath);
    queries = new QueryBuilder(connection.getDb());
    await createResolver(projectRoot, queries).resolveAndPersistBatched(undefined, 1);
    return { nodes: queries.getAllNodes(), edges: queries.getAllEdges(), references };
  } finally {
    connection?.close();
  }
}

function hasCall(edges: readonly Edge[], source: Node, target: Node): boolean {
  return edges.some((edge) => edge.kind === 'calls' && edge.source === source.id && edge.target === target.id);
}

function hasEdge(edges: readonly Edge[], kind: Edge['kind'], source: Node, target: Node): boolean {
  return edges.some((edge) => edge.kind === kind && edge.source === source.id && edge.target === target.id);
}

describe('callable visibility after persisted resolution', () => {
  it('does not resolve a bare call to the single foreign nested callable through fuzzy matching', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'caller', (node) => node.name === 'caller');
    const foreignVisit = requireNode(
      fixture.nodes,
      'single foreign nested visit',
      (node) => node.name === 'foreignVisit' && node.qualifiedName === 'foreign::foreignVisit',
    );

    expect(hasCall(fixture.edges, caller, foreignVisit)).toBe(false);
  });

  it('keeps a bare call to a nested callable declared inside the caller scope', async () => {
    const fixture = await resolvePersistedFixture();
    const local = requireNode(fixture.nodes, 'local caller', (node) => node.name === 'local');
    const localVisit = requireNode(
      fixture.nodes,
      'local nested visit',
      (node) => node.name === 'localVisit' && node.qualifiedName === 'local::localVisit',
    );

    expect(hasCall(fixture.edges, local, localVisit)).toBe(true);
  });

  it('keeps an aliased imported top-level callable resolved from the written source file', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'imported caller', (node) => node.name === 'importedCaller');
    const importedVisit = requireNode(
      fixture.nodes,
      'imported visit',
      (node) => node.name === 'exportedAliasTarget' && node.filePath === 'src/exported.ts',
    );

    expect(hasCall(fixture.edges, caller, importedVisit)).toBe(true);
  });

  it('does not resolve a TypeScript call to a nested Python callable through cross-language fallback', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'cross-language caller', (node) => node.name === 'crossLanguageCaller');
    const foreignVisit = requireNode(
      fixture.nodes,
      'cross-language foreign visit',
      (node) => node.name === 'crossLanguageVisit' && node.filePath === 'src/foreign.py',
    );

    expect(hasCall(fixture.edges, caller, foreignVisit)).toBe(false);
  });

  it('does not resolve a nested callable in another file with the same qualified parent', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'same-parent caller', (node) => node.name === 'parentCaller');
    const foreignVisit = requireNode(
      fixture.nodes,
      'same-parent foreign visit',
      (node) => node.name === 'sharedParentVisit' && node.filePath === 'src/foreign-parent.ts',
    );

    expect(hasCall(fixture.edges, caller, foreignVisit)).toBe(false);
  });

  it('does not authorize a nested callable when a reference has the source node ID but the wrong file path', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'inconsistent caller', (node) => node.name === 'inconsistentCaller');
    const target = requireNode(
      fixture.nodes,
      'inconsistent target',
      (node) => node.name === 'mismatchedTarget' && node.filePath === 'src/inconsistent-target.ts',
    );

    expect(
      fixture.references.some(
        (reference) =>
          reference.fromNodeId === caller.id &&
          reference.referenceName === 'mismatchedTarget' &&
          reference.filePath === 'src/missing.ts',
      ),
    ).toBe(true);
    expect(hasCall(fixture.edges, caller, target)).toBe(false);
  });

  it('keeps a direct child callable reachable from a deeply nested caller despite a foreign decoy', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(
      fixture.nodes,
      'deep caller',
      (node) => node.name === 'deepMiddle' && node.qualifiedName === 'deepOuter::deepMiddle',
    );
    const target = requireNode(
      fixture.nodes,
      'deep direct child',
      (node) => node.name === 'deepLocalChild' && node.qualifiedName === 'deepOuter::deepMiddle::deepLocalChild',
    );

    expect(hasCall(fixture.edges, caller, target)).toBe(true);
  });

  it('keeps a Python class constructor callable and promotes its edge to instantiates', async () => {
    const fixture = await resolvePersistedFixture();
    const bootstrap = requireNode(fixture.nodes, 'Python constructor caller', (node) => node.name === 'bootstrap');
    const userService = requireNode(
      fixture.nodes,
      'Python constructor target',
      (node) => node.kind === 'class' && node.name === 'UserService' && node.filePath === 'src/constructor.py',
    );

    expect(hasEdge(fixture.edges, 'instantiates', bootstrap, userService)).toBe(true);
  });

  it('does not resolve a call to a same-named variable', async () => {
    const fixture = await resolvePersistedFixture();
    const caller = requireNode(fixture.nodes, 'variable caller', (node) => node.name === 'variableCaller');
    const siteUrl = requireNode(
      fixture.nodes,
      'siteURL variable',
      (node) => node.name === 'siteURL' && node.kind === 'constant',
    );

    expect(fixture.references.some((reference) => reference.fromNodeId === caller.id && reference.referenceName === 'siteURL')).toBe(true);
    expect(hasCall(fixture.edges, caller, siteUrl)).toBe(false);
  });
});
