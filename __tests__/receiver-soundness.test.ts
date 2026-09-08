/// <reference types="node" />

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { createResolver } from '../src/resolution';
import { expoModulesResolver } from '../src/resolution/frameworks/expo-modules';
import type { Edge, Language, Node, UnresolvedReference } from '../src/types';

type SourceFixture = {
  readonly language: Language;
  readonly source: string;
  readonly native?: true;
};

type Target = {
  readonly filePath: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly isStatic?: boolean;
};

type CallCase = {
  readonly title: string;
  readonly caller: string;
  readonly callerKind: Node['kind'];
  readonly callerQualifiedName?: string;
  readonly filePath: string;
  readonly callsite: string;
  readonly target?: Target;
};

type ResolutionFixture = {
  readonly edges: readonly Edge[];
  readonly nodes: readonly Node[];
  readonly unresolved: readonly UnresolvedReference[];
};

const SOURCES: Readonly<Record<string, SourceFixture>> = {
  'src/service.ts': {
    language: 'typescript',
    source: `
export class Service {
  plainGood(): void {}
  arrowGood(): void {}
  objectBad(): void {}
  constructorShadow(): void {}
  destructuredObject(): void {}
  destructuredArray(): void {}
  destructuredLocal(): void {}
  typedReassigned(): void {}
  namespaceTyped(): void {}
  namespaceConstructed(): void {}
  static namespaceStatic(): void {}
}

export class Other {
  typedReassigned(): void {}
}

export class FirstWorker {
  firstLate(): void {}
}

export class SecondWorker {
  secondLate(): void {}
}

export class ImportedOwner {
  create(): object {
    class ImportedInner {
      run(): void {}
    }
    return new ImportedInner();
  }
}
`,
  },
  'src/collision-one.ts': {
    language: 'typescript',
    source: `
export class SameCoordinate {
  run(): void {}
}
`,
  },
  'src/collision-two.ts': {
    language: 'typescript',
    source: `
export class SameCoordinate {
  run(): void {}
}
`,
  },
  'src/missing.ts': {
    language: 'typescript',
    source: `
export class MissingDecoy {
  namespaceMissing(): void {}
}
`,
  },
  'ios/ExpoActual.swift': {
    language: 'swift',
    native: true,
    source: `
import ExpoModulesCore

public class ExpoActualModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoActual")
    Function("nativeGood") {}
  }
}
`,
  },
  'src/matrix.js': {
    language: 'javascript',
    source: `
import { requireNativeModule } from 'expo-modules-core';
import { ImportedOwner } from './service';
import { Service } from './service';
import { SameCoordinate as CollisionOne } from './collision-one';
import { SameCoordinate as CollisionTwo } from './collision-two';
import * as api from './service';

const x = new api.Service();
const y = new api.Service();
const Native = requireNativeModule('ExpoActual');

export function plainParameter(x) {
  x.plainGood();
}

export const singleArrow = (x) => {
  x.arrowGood();
};

export function destructuredParameters({ x }, [y]) {
  x.destructuredObject();
  y.destructuredArray();
}

export function arrayUnshadowedControl([value]) {
  y.destructuredArray();
}

export function destructuredLocal(source) {
  const { x } = source;
  x.destructuredLocal();
}

export function constructorShadow(Service) {
  new Service().constructorShadow();
}

export function constructorUnshadowedControl() {
  new Service().constructorShadow();
}

export function nativeFactoryShadow(requireNativeModule) {
  const Native = requireNativeModule('Shadowed');
  Native.nativeGood();
}

export function nativeReceiverShadow(Native) {
  Native.nativeGood();
}

export function nativePositive() {
  Native.nativeGood();
}

// Native.nativeGood();
export function otherNativeScope() {
  const Native = { nativeGood() {} };
  Native.nativeGood();
}

export class ThisHost {
  service = new api.Service();

  ordinary() {
    const nested = {
      run() {
        this.service.objectBad();
      },
    };
    return nested;
  }

  lexicalArrow = () => {
    this.service.arrowGood();
  };
}

class LocalOwner {
  create() {
    class LocalInner {
      run() {}
    }
    return new LocalInner();
  }
}

export function localOwnerOnly() {
  new LocalOwner().run();
}

export function importedOwnerOnly() {
  new ImportedOwner().run();
}

export function collisionOne() {
  new CollisionOne().run();
}

export function collisionTwo() {
  new CollisionTwo().run();
}

export class LateOne {
  invoke() {
    this.worker.firstLate();
  }

  worker = new api.FirstWorker();
}

export class LateTwo {
  invoke() {
    this.worker.secondLate();
  }

  worker = new api.SecondWorker();
}
`,
  },
  'src/typed.ts': {
    language: 'typescript',
    source: `
import * as api from './service';
import * as missing from './missing';

export function typedReassigned(x: api.Service): void {
  if (Math.random() > 0.5) {
    x = new api.Other();
  }
  x.typedReassigned();
}

export function namespaceTyped(value: api.Service): void {
  value.namespaceTyped();
}

export function namespaceConstructed(): void {
  new api.Service().namespaceConstructed();
}

export function namespaceStatic(): void {
  api.Service.namespaceStatic();
}

export function namespaceMissing(): void {
  new missing.Service().namespaceMissing();
}
`,
  },
  'src/malformed.ts': {
    language: 'typescript',
    source: `
export function malformedMetadata(): void {
  return;
}
`,
  },
};

const CASES = [
  { title: 'abstains for a plain JavaScript parameter shadowing an outer instance', caller: 'plainParameter', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'x.plainGood()' },
  { title: 'abstains for a single-parameter JavaScript arrow shadowing an outer instance', caller: 'singleArrow', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'x.arrowGood()' },
  { title: 'abstains for object-destructured JavaScript parameters', caller: 'destructuredParameters', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'x.destructuredObject()' },
  { title: 'abstains for array-destructured JavaScript parameters', caller: 'destructuredParameters', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'y.destructuredArray()' },
  { title: 'resolves an unshadowed outer array control receiver', caller: 'arrayUnshadowedControl', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'y.destructuredArray()', target: { filePath: 'src/service.ts', name: 'destructuredArray', qualifiedName: 'Service::destructuredArray' } },
  { title: 'abstains for a destructured local shadowing an outer instance', caller: 'destructuredLocal', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'x.destructuredLocal()' },
  { title: 'abstains for a constructor parameter shadowing the outer Service class', caller: 'constructorShadow', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new Service().constructorShadow()' },
  { title: 'resolves an unshadowed named Service constructor control', caller: 'constructorUnshadowedControl', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new Service().constructorShadow()', target: { filePath: 'src/service.ts', name: 'constructorShadow', qualifiedName: 'Service::constructorShadow' } },
  { title: 'abstains after a typed receiver is reassigned in a preceding branch', caller: 'typedReassigned', callerKind: 'function', filePath: 'src/typed.ts', callsite: 'x.typedReassigned()' },
  { title: 'abstains when a native factory parameter shadows the imported factory', caller: 'nativeFactoryShadow', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'Native.nativeGood()' },
  { title: 'abstains when a native receiver parameter shadows the bound receiver', caller: 'nativeReceiverShadow', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'Native.nativeGood()' },
  { title: 'resolves the actual native receiver through its framework extractor', caller: 'nativePositive', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'Native.nativeGood()', target: { filePath: 'ios/ExpoActual.swift', name: 'nativeGood' } },
  { title: 'abstains for a same-named native receiver in another function scope', caller: 'otherNativeScope', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'Native.nativeGood()' },
  { title: 'abstains for this in an ordinary nested object method', caller: 'ordinary', callerKind: 'method', callerQualifiedName: 'ThisHost::ordinary', filePath: 'src/matrix.js', callsite: 'this.service.objectBad()' },
  { title: 'resolves this in a lexical class arrow to the outer receiver', caller: 'lexicalArrow', callerKind: 'method', callerQualifiedName: 'ThisHost::lexicalArrow', filePath: 'src/matrix.js', callsite: 'this.service.arrowGood()', target: { filePath: 'src/service.ts', name: 'arrowGood', qualifiedName: 'Service::arrowGood' } },
  { title: 'abstains when a local owner has only a nested Inner.run member', caller: 'localOwnerOnly', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new LocalOwner().run()' },
  { title: 'abstains when an imported owner has only a nested Inner.run member', caller: 'importedOwnerOnly', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new ImportedOwner().run()' },
  { title: 'resolves the first same-coordinate class to its own file', caller: 'collisionOne', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new CollisionOne().run()', target: { filePath: 'src/collision-one.ts', name: 'run', qualifiedName: 'SameCoordinate::run' } },
  { title: 'resolves the second same-coordinate class to its own file', caller: 'collisionTwo', callerKind: 'function', filePath: 'src/matrix.js', callsite: 'new CollisionTwo().run()', target: { filePath: 'src/collision-two.ts', name: 'run', qualifiedName: 'SameCoordinate::run' } },
  { title: 'resolves a late field on the first class to its own owner', caller: 'invoke', callerKind: 'method', callerQualifiedName: 'LateOne::invoke', filePath: 'src/matrix.js', callsite: 'this.worker.firstLate()', target: { filePath: 'src/service.ts', name: 'firstLate', qualifiedName: 'FirstWorker::firstLate' } },
  { title: 'resolves a late field on the second class to its own owner', caller: 'invoke', callerKind: 'method', callerQualifiedName: 'LateTwo::invoke', filePath: 'src/matrix.js', callsite: 'this.worker.secondLate()', target: { filePath: 'src/service.ts', name: 'secondLate', qualifiedName: 'SecondWorker::secondLate' } },
  { title: 'resolves a typed namespace class receiver', caller: 'namespaceTyped', callerKind: 'function', filePath: 'src/typed.ts', callsite: 'value.namespaceTyped()', target: { filePath: 'src/service.ts', name: 'namespaceTyped', qualifiedName: 'Service::namespaceTyped' } },
  { title: 'resolves a directly constructed namespace class receiver', caller: 'namespaceConstructed', callerKind: 'function', filePath: 'src/typed.ts', callsite: 'new api.Service().namespaceConstructed()', target: { filePath: 'src/service.ts', name: 'namespaceConstructed', qualifiedName: 'Service::namespaceConstructed' } },
  { title: 'resolves a direct namespace static class member', caller: 'namespaceStatic', callerKind: 'function', filePath: 'src/typed.ts', callsite: 'api.Service.namespaceStatic()', target: { filePath: 'src/service.ts', name: 'namespaceStatic', qualifiedName: 'Service::namespaceStatic', isStatic: true } },
  { title: 'abstains for a missing namespace class despite a decoy member elsewhere', caller: 'namespaceMissing', callerKind: 'function', filePath: 'src/typed.ts', callsite: 'new missing.Service().namespaceMissing()' },
] satisfies readonly CallCase[];

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

function positionOf(
  source: string,
  callsite: string,
  scope?: Node,
): { readonly line: number; readonly column: number } {
  const indexAt = (line: number, column: number): number => {
    let index = 0;
    for (let currentLine = 1; currentLine < line; currentLine += 1) {
      const lineBreak = source.indexOf('\n', index);
      if (lineBreak < 0) throw new Error(`Missing line ${line}`);
      index = lineBreak + 1;
    }
    return index + column;
  };
  const start = scope ? indexAt(scope.startLine, scope.startColumn) : 0;
  const end = scope ? indexAt(scope.endLine, scope.endColumn) : source.length;
  const scopedSource = source.slice(start, end);
  const scopedIndex = scopedSource.indexOf(callsite);
  if (scopedIndex < 0) throw new Error(`Missing callsite ${callsite}`);
  if (scopedSource.indexOf(callsite, scopedIndex + callsite.length) >= 0) {
    throw new Error(`Ambiguous callsite ${callsite}`);
  }
  const index = start + scopedIndex;
  const prefix = source.slice(0, index);
  return {
    line: prefix.split('\n').length,
    column: index - prefix.lastIndexOf('\n') - 1,
  };
}

function extractFixture(filePath: string, fixture: SourceFixture) {
  if (fixture.native) {
    const extracted = expoModulesResolver.extract?.(filePath, fixture.source);
    if (!extracted) throw new Error(`Missing native extractor for ${filePath}`);
    return { edges: [], errors: [], nodes: extracted.nodes, unresolvedReferences: extracted.references };
  }
  return extractFromSource(filePath, fixture.source, fixture.language);
}

async function resolveFixture(): Promise<ResolutionFixture> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-receiver-soundness-'));
  temporaryDirectories.push(projectRoot);
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    '{"dependencies":{"expo-modules-core":"^1.0.0"}}',
  );
  for (const [filePath, fixture] of Object.entries(SOURCES)) {
    const absolutePath = path.join(projectRoot, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, fixture.source);
  }

  const databasePath = path.join(projectRoot, '.solidkg', 'graph.db');
  let connection: DatabaseConnection | undefined = DatabaseConnection.initialize(databasePath);
  try {
    let queries = new QueryBuilder(connection.getDb());
    for (const [filePath, fixture] of Object.entries(SOURCES)) {
      const extracted = extractFixture(filePath, fixture);
      expect(extracted.errors).toEqual([]);
      queries.upsertFile({
        path: filePath,
        contentHash: fixture.source,
        language: fixture.language,
        size: Buffer.byteLength(fixture.source),
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: extracted.nodes.length,
      });
      queries.insertNodes(extracted.nodes);
      queries.insertEdges(extracted.edges);
      queries.insertUnresolvedRefsBatch(extracted.unresolvedReferences);
    }

    const malformedCaller = requireNode(
      queries.getAllNodes(),
      'malformed metadata caller',
      (node) => node.kind === 'function' && node.name === 'malformedMetadata',
    );
    connection.getDb().prepare(
      'INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      malformedCaller.id,
      'Service.plainGood',
      'calls',
      3,
      2,
      JSON.stringify(['__solidkg_member_call__:{"receiver":"Service","member":"plainGood","binding":{"kind":"local"}}']),
      'src/malformed.ts',
      'typescript',
    );

    connection.close();
    connection = DatabaseConnection.open(databasePath);
    queries = new QueryBuilder(connection.getDb());
    await createResolver(projectRoot, queries).resolveAndPersistBatched(undefined, 1);
    return {
      edges: queries.getAllEdges(),
      nodes: queries.getAllNodes(),
      unresolved: queries.getUnresolvedReferences(),
    };
  } finally {
    connection?.close();
  }
}

function matchingCallsiteEdges(fixture: ResolutionFixture, testCase: CallCase, caller: Node): readonly Edge[] {
  const source = SOURCES[testCase.filePath].source;
  const position = positionOf(source, testCase.callsite, caller);
  return fixture.edges.filter((edge) =>
    edge.kind === 'calls'
    && edge.source === caller.id
    && edge.line === position.line
    && edge.column === position.column,
  );
}

describe('durable receiver binding soundness', () => {
  it.each(CASES)('$title', async (testCase) => {
    const fixture = await resolveFixture();
    const caller = requireNode(
      fixture.nodes,
      `caller ${testCase.caller}`,
      (node) => node.kind === testCase.callerKind
        && node.name === testCase.caller
        && node.filePath === testCase.filePath
        && (testCase.callerQualifiedName === undefined || node.qualifiedName === testCase.callerQualifiedName),
    );
    const calls = matchingCallsiteEdges(fixture, testCase, caller);

    if (!testCase.target) {
      expect(calls).toEqual([]);
      return;
    }

    const target = requireNode(
      fixture.nodes,
      `${testCase.target.filePath}:${testCase.target.name}`,
      (node) => node.filePath === testCase.target?.filePath
        && node.name === testCase.target?.name
        && (testCase.target?.qualifiedName === undefined || node.qualifiedName === testCase.target.qualifiedName)
        && (testCase.target?.isStatic === undefined || node.isStatic === testCase.target.isStatic),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: caller.id, target: target.id });
  });

  it('does not extract the commented native receiver callsite', async () => {
    const fixture = await resolveFixture();
    const commentPosition = positionOf(SOURCES['src/matrix.js'].source, '// Native.nativeGood();');
    expect(fixture.edges.some((edge) =>
      edge.kind === 'calls'
      && edge.line === commentPosition.line
      && edge.column === commentPosition.column + 3,
    )).toBe(false);
  });

  it('keeps malformed persisted member-call metadata terminally unknown after reopen and batch one resolution', async () => {
    const fixture = await resolveFixture();
    const caller = requireNode(
      fixture.nodes,
      'malformed metadata caller',
      (node) => node.kind === 'function' && node.name === 'malformedMetadata' && node.filePath === 'src/malformed.ts',
    );
    const unresolved = fixture.unresolved.find((reference) =>
      reference.fromNodeId === caller.id
      && reference.line === 3
      && reference.column === 2,
    );
    expect(unresolved?.memberCall).toEqual({
      receiver: 'Service',
      member: 'plainGood',
      binding: { kind: 'unknown' },
    });
    expect(fixture.edges.some((edge) =>
      edge.kind === 'calls'
      && edge.source === caller.id
      && edge.line === 3
      && edge.column === 2,
    )).toBe(false);
  });
});
