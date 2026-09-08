import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

const SOURCE = `
import { requireNativeModule } from 'expo-modules-core';
import * as ns from './service';

class Service { instanceShared() {} static annotationStatic() {} }
type FirstAlias = SecondAlias;
type SecondAlias = FirstAlias;

const x = new ns.Service();

function plainParameter(x) { x.plainParameter(); }
const singleArrow = x => x.singleArrow();
function destructuredParameter({ x }, [y]) { x.objectParameter(); y.arrayParameter(); }
function destructuredLocal(source) { const { x } = source; x.localDestructure(); }
function constructorShadow(Service) { new Service().constructorShadow(); }
function writesInBranches(x) {
  if (condition) { x = unknown; } else { x = other; }
  switch (mode) { case 'a': x = third; break; default: x = fourth; }
  x.branchWrite();
}

class Host {
  service: ns.Service = new ns.Service();
  invoke() { const nested = { invoke() { this.service.objectMethod(); } }; }
  arrow = () => this.service.arrowThis();
}

function typed(x: ns.Service) { x.typedNamespace(); }
function sameNameAnnotation(Service: Service) { Service.instanceShared(); }
function genericSameName<Service>(client: Service) { client.genericSameName(); }
function cyclicAlias(client: FirstAlias) { client.cyclicAlias(); }
function namespaceConstructor() { new ns.Service().newNamespace(); }
function namespaceStatic() { ns.Service.build(); }
function nativeFactoryShadow(requireNativeModule) {
  const Native = requireNativeModule('Shadowed');
  Native.factoryShadow();
}
function nativeParameter(Native) { Native.nativeParameter(); }
const NativeActual = requireNativeModule('ExpoActual');
function nativeImport() { NativeActual.nativeImport(); }
`;

const EXPECTED_BINDINGS = {
  'plainParameter:x.plainParameter': { kind: 'unknown' },
  'x:x.singleArrow': { kind: 'unknown' },
  'destructuredParameter:x.objectParameter': { kind: 'unknown' },
  'destructuredParameter:y.arrayParameter': { kind: 'unknown' },
  'destructuredLocal:x.localDestructure': { kind: 'unknown' },
  'constructorShadow:new Service().constructorShadow': { kind: 'unknown' },
  'writesInBranches:x.branchWrite': { kind: 'unknown' },
  'Host::invoke:this.service.objectMethod': { kind: 'unknown' },
  'Host::arrow:this.service.arrowThis': {
    kind: 'import',
    localName: 'ns',
    exportPath: ['Service'],
    access: 'instance',
  },
  'typed:x.typedNamespace': {
    kind: 'import',
    localName: 'ns',
    exportPath: ['Service'],
    access: 'instance',
  },
  'sameNameAnnotation:Service.instanceShared': {
    kind: 'local',
    ownerFilePath: 'receiver-lexical.ts',
    ownerStartLine: 5,
    ownerStartColumn: 0,
    access: 'instance',
  },
  'genericSameName:client.genericSameName': { kind: 'unknown' },
  'cyclicAlias:client.cyclicAlias': { kind: 'unknown' },
  'namespaceConstructor:new ns.Service().newNamespace': {
    kind: 'import',
    localName: 'ns',
    exportPath: ['Service'],
    access: 'instance',
  },
  'namespaceStatic:ns.Service.build': {
    kind: 'import',
    localName: 'ns',
    exportPath: ['Service'],
    access: 'static',
  },
  'nativeFactoryShadow:Native.factoryShadow': { kind: 'unknown' },
  'nativeParameter:Native.nativeParameter': { kind: 'unknown' },
  'nativeImport:NativeActual.nativeImport': { kind: 'native', moduleName: 'ExpoActual' },
} as const;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('receiver lexical regressions', () => {
  it('emits the conservative binding contract at every lexical receiver callsite', () => {
    // Given: JavaScript and TypeScript receivers with colliding lexical declarations.
    const result = extractFromSource('receiver-lexical.ts', SOURCE, 'typescript');
    const callerNames = new Map(result.nodes.map((node) => [node.id, node.qualifiedName ?? node.name]));
    const bindings = new Map(
      result.unresolvedReferences
        .filter((reference) => reference.referenceKind === 'calls' && reference.memberCall)
        .map((reference) => [
          `${callerNames.get(reference.fromNodeId)}:${reference.memberCall?.receiver}.${reference.memberCall?.member}`,
          reference.memberCall?.binding,
        ])
    );

    // When: each callsite is addressed by its extracted caller and receiver key.
    // Then: a nearer declaration is unknown unless the producer can prove its owner.
    expect(bindings).toEqual(new Map(Object.entries(EXPECTED_BINDINGS)));
  });
});
