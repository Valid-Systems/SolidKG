import type { Edge, Node } from '../../types';
import type { QueryBuilder } from '../../db/queries';
import { MAX_CALLBACKS_PER_CHANNEL, methodsContainedBy } from './shared';

export function cppOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const subMethods = methodsContainedBy(queries, cls.id).filter((node) => node.language === 'cpp');
    if (subMethods.length === 0) continue;
    for (const ext of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const base = queries.getNodeById(ext.target);
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue;
      const baseMethods = new Map(methodsContainedBy(queries, base.id).map((method) => [method.name, method]));
      let added = 0;
      for (const method of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        const baseMethod = baseMethods.get(method.name);
        if (!baseMethod || baseMethod.id === method.id) continue;
        const key = `${baseMethod.id}>${method.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: baseMethod.id,
          target: method.id,
          kind: 'calls',
          line: baseMethod.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: method.name, registeredAt: `${method.filePath}:${method.startLine}` },
        });
        added++;
      }
    }
  }
  return edges;
}

const IFACE_OVERRIDE_LANGS = new Set(['java', 'kotlin', 'csharp']);

export function interfaceOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const implMethods = methodsContainedBy(queries, cls.id).filter((node) => IFACE_OVERRIDE_LANGS.has(node.language));
    if (implMethods.length === 0) continue;
    for (const sup of queries.getOutgoingEdges(cls.id, ['implements', 'extends'])) {
      const base = queries.getNodeById(sup.target);
      if (!isDispatchableBase(cls, base)) continue;
      const implByName = groupByName(implMethods);
      let added = 0;
      for (const baseMethod of methodsContainedBy(queries, base.id)) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const method of implByName.get(baseMethod.name) ?? []) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (baseMethod.id === method.id || !signaturesCompatible(baseMethod, method)) continue;
          const key = `${baseMethod.id}>${method.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const signatureKey = dispatchSignatureKey(baseMethod, method);
          edges.push({
            source: baseMethod.id,
            target: method.id,
            kind: 'calls',
            line: baseMethod.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'interface-impl', via: method.name, registeredAt: `${method.filePath}:${method.startLine}`, signatureKey },
          });
          added++;
        }
      }
    }
  }
  return edges;
}

function isDispatchableBase(cls: Node, base: Node | null): base is Node {
  if (!base || !IFACE_OVERRIDE_LANGS.has(base.language) || base.id === cls.id) return false;
  if (cls.language === 'csharp' && base.kind !== 'interface' && base.kind !== 'protocol') return false;
  return true;
}

function groupByName(methods: Node[]): Map<string, Node[]> {
  const byName = new Map<string, Node[]>();
  for (const method of methods) {
    const group = byName.get(method.name);
    if (group) group.push(method);
    else byName.set(method.name, [method]);
  }
  return byName;
}

function signaturesCompatible(baseMethod: Node, implementationMethod: Node): boolean {
  const baseKey = signatureParamKey(baseMethod.signature);
  const implementationKey = signatureParamKey(implementationMethod.signature);
  return baseKey === null || implementationKey === null || baseKey === implementationKey;
}

function dispatchSignatureKey(baseMethod: Node, implementationMethod: Node): string {
  return signatureParamKey(baseMethod.signature) ?? signatureParamKey(implementationMethod.signature) ?? 'signature-unavailable';
}

function signatureParamKey(signature: string | undefined): string | null {
  if (!signature) return null;
  const params = signature.match(/\(([^)]*)\)/)?.[1];
  if (params === undefined) return null;
  const trimmed = params.trim();
  if (trimmed.length === 0) return 'params:';
  return `params:${splitTopLevelParams(trimmed).map(normalizeParamType).join(',')}`;
}

function splitTopLevelParams(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < params.length; index += 1) {
    const char = params[index];
    if (char === '<' || char === '(' || char === '[') depth += 1;
    if (char === '>' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(params.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(params.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function normalizeParamType(param: string): string {
  const withoutDefault = param.split('=')[0]!.trim();
  const colonIndex = withoutDefault.indexOf(':');
  if (colonIndex >= 0) return withoutDefault.slice(colonIndex + 1).trim().toLowerCase();
  const tokens = withoutDefault
    .split(/\s+/)
    .filter((token) => !['final', 'in', 'out', 'params', 'ref', 'vararg'].includes(token));
  if (tokens.length <= 1) return (tokens[0] ?? '').toLowerCase();
  return tokens.slice(0, -1).join(' ').toLowerCase();
}
