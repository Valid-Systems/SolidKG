import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SolidKG } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('C# interface dispatch synthesis', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges an interface method to the implementing class method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-interface-'));
    fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
    fs.writeFileSync(
      path.join(tmpDir, 'Orders.cs'),
      'public interface IOrderService {\n' +
        '  string List();\n' +
        '}\n' +
        'public class OrderService : IOrderService {\n' +
        '  public string List() { return "orders"; }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    try {
      await cg.indexAll();

      const interfaceNode = cg.getNodesByKind('interface').find((node) => node.name === 'IOrderService');
      const implementationNode = cg.getNodesByKind('class').find((node) => node.name === 'OrderService');
      expect(interfaceNode).toBeDefined();
      expect(implementationNode).toBeDefined();
      if (!interfaceNode || !implementationNode) return;

      const implementsEdge = cg
        .getOutgoingEdges(implementationNode.id)
        .find((candidate) => candidate.target === interfaceNode.id && candidate.kind === 'implements');
      expect(implementsEdge, 'OrderService should implement IOrderService before dispatch synthesis runs').toBeDefined();

      const interfaceMethod = containedMethod(cg, interfaceNode.id, 'List');
      const implementationMethod = containedMethod(cg, implementationNode.id, 'List');
      expect(interfaceMethod).toBeDefined();
      expect(implementationMethod).toBeDefined();
      if (!interfaceMethod || !implementationMethod) return;

      const edge = cg
        .getOutgoingEdges(interfaceMethod.id)
        .find((candidate) => candidate.target === implementationMethod.id && candidate.kind === 'calls');
      expect(edge, 'IOrderService.List should reach OrderService.List through interface dispatch').toBeDefined();
      expect(edge?.metadata?.synthesizedBy).toBe('interface-impl');
    } finally {
      cg.close();
    }
  });

  it('does not bridge ordinary non-virtual base class methods', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-base-'));
    fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
    fs.writeFileSync(
      path.join(tmpDir, 'Orders.cs'),
      'public class BaseService {\n' +
        '  public string List() { return "base"; }\n' +
        '}\n' +
        'public class DerivedService : BaseService {\n' +
        '  public string List() { return "derived"; }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    try {
      await cg.indexAll();

      const baseNode = cg.getNodesByKind('class').find((node) => node.name === 'BaseService');
      const derivedNode = cg.getNodesByKind('class').find((node) => node.name === 'DerivedService');
      expect(baseNode).toBeDefined();
      expect(derivedNode).toBeDefined();
      if (!baseNode || !derivedNode) return;

      const baseMethod = containedMethod(cg, baseNode.id, 'List');
      const derivedMethod = containedMethod(cg, derivedNode.id, 'List');
      expect(baseMethod).toBeDefined();
      expect(derivedMethod).toBeDefined();
      if (!baseMethod || !derivedMethod) return;

      const falseDispatchEdge = cg
        .getOutgoingEdges(baseMethod.id)
        .find((candidate) => candidate.target === derivedMethod.id && candidate.metadata?.synthesizedBy === 'interface-impl');
      expect(falseDispatchEdge, 'non-virtual C# base methods should not dispatch to same-name derived methods').toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('does not bridge incompatible same-name interface overloads', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-overload-'));
    fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
    fs.writeFileSync(
      path.join(tmpDir, 'Orders.cs'),
      'public interface IOrderService {\n' +
        '  string List();\n' +
        '  string List(string region);\n' +
        '  string List(int id);\n' +
        '}\n' +
        'public class OrderService : IOrderService {\n' +
        '  public string List() { return "all"; }\n' +
        '  public string List(string value) { return value; }\n' +
        '  public string List(int value) { return value.ToString(); }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    try {
      await cg.indexAll();

      const interfaceNode = cg.getNodesByKind('interface').find((node) => node.name === 'IOrderService');
      const implementationNode = cg.getNodesByKind('class').find((node) => node.name === 'OrderService');
      expect(interfaceNode).toBeDefined();
      expect(implementationNode).toBeDefined();
      if (!interfaceNode || !implementationNode) return;

      const interfaceMethods = containedMethods(cg, interfaceNode.id, 'List').sort((a, b) => (a.signature ?? '').localeCompare(b.signature ?? ''));
      const implementationMethods = containedMethods(cg, implementationNode.id, 'List').sort((a, b) => (a.signature ?? '').localeCompare(b.signature ?? ''));
      expect(interfaceMethods.map((node) => node.signature)).toEqual(['()', '(int id)', '(string region)']);
      expect(implementationMethods.map((node) => node.signature)).toEqual(['()', '(int value)', '(string value)']);

      for (const interfaceMethod of interfaceMethods) {
        const outgoing = cg.getOutgoingEdges(interfaceMethod.id).filter((edge) => edge.metadata?.synthesizedBy === 'interface-impl');
        expect(outgoing).toHaveLength(1);
        const target = cg.getNode(outgoing[0]!.target);
        expect(outgoing[0]!.metadata?.signatureKey).toBe(signatureKey(interfaceMethod.signature));
        expect(signatureKey(target?.signature)).toBe(signatureKey(interfaceMethod.signature));
      }
    } finally {
      cg.close();
    }
  });
});

function containedMethod(cg: SolidKG, ownerId: string, name: string): Node | undefined {
  return containedMethods(cg, ownerId, name)[0];
}

function signatureKey(signature: string | undefined): string {
  const params = signature?.match(/\(([^)]*)\)/)?.[1]?.trim();
  if (!params) return 'params:';
  return `params:${params.split(',').map((param) => param.trim().split(/\s+/)[0]!.toLowerCase()).join(',')}`;
}

function containedMethods(cg: SolidKG, ownerId: string, name: string): Node[] {
  return cg
    .getOutgoingEdges(ownerId)
    .filter((edge) => edge.kind === 'contains')
    .map((edge) => cg.getNode(edge.target))
    .filter((node): node is Node => node?.kind === 'method' && node.name === name);
}
