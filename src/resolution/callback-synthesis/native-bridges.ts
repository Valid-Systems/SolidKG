import type { Edge, Node } from '../../types';
import type { ResolutionContext } from '../types';
import { enclosingFn, EVENT_FANOUT_CAP } from './shared';

const RN_OBJC_SEND_RE = /\bsendEventWithName\s*:\s*@"([^"]+)"/g;
const RN_SWIFT_SEND_RE = /\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g;
const RN_JVM_EMIT_RE = /\.emit\s*\(\s*"([^"]+)"\s*,/g;
const ADDLISTENER_ANY = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)/g;
const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager'];

export function rnEventEdges(ctx: ResolutionContext): Edge[] {
  const nativeDispatchersByEvent = new Map<string, Set<string>>();
  const jsHandlersByEvent = new Map<string, Map<string, string>>();

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (index: number) => content.slice(0, index).split('\n').length;
    const addDispatcher = (event: string, line: number) => {
      const dispatcher = enclosingFn(nodesInFile, line);
      if (!dispatcher) return;
      const set = nativeDispatchersByEvent.get(event) ?? new Set<string>();
      set.add(dispatcher.id);
      nativeDispatchersByEvent.set(event, set);
    };

    collectNativeDispatches(file, content, lineOf, addDispatcher);
    collectJsSubscribers(file, content, nodesInFile, lineOf, ctx, jsHandlersByEvent);
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of nativeDispatchersByEvent) {
    const handlers = jsHandlersByEvent.get(event);
    if (!handlers) continue;
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const dispatcher of dispatchers) {
      for (const [handler, registeredAt] of handlers) {
        if (dispatcher === handler) continue;
        const key = `${dispatcher}>${handler}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: dispatcher,
          target: handler,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'rn-event-channel', event, registeredAt },
        });
      }
    }
  }
  return edges;
}

export function fabricNativeImplEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const components = ctx.getNodesByKind('component').filter((node) => node.id.startsWith('fabric-component:'));
  if (components.length === 0) return edges;
  const nativeClassesByName = new Map<string, Node[]>();
  for (const node of ctx.getNodesByKind('class')) {
    if (node.language !== 'objc' && node.language !== 'kotlin' && node.language !== 'java' && node.language !== 'cpp') continue;
    const group = nativeClassesByName.get(node.name);
    if (group) group.push(node);
    else nativeClassesByName.set(node.name, [node]);
  }
  for (const component of components) {
    for (const suffix of FABRIC_NATIVE_SUFFIXES) {
      const matches = nativeClassesByName.get(component.name + suffix);
      if (!matches || matches.length === 0) continue;
      for (const native of matches) {
        const key = `${component.id}>${native.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: native.id,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'fabric-native-impl', viaSuffix: suffix || '(exact)', componentName: component.name },
        });
      }
    }
  }
  return edges;
}

function collectNativeDispatches(file: string, content: string, lineOf: (index: number) => number, addDispatcher: (event: string, line: number) => void): void {
  const patterns = file.endsWith('.m') || file.endsWith('.mm')
    ? [RN_OBJC_SEND_RE]
    : file.endsWith('.swift')
      ? [RN_SWIFT_SEND_RE]
      : file.endsWith('.java') || file.endsWith('.kt')
        ? [RN_JVM_EMIT_RE]
        : [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      if (match[1]) addDispatcher(match[1], lineOf(match.index));
    }
  }
}

function collectJsSubscribers(
  file: string,
  content: string,
  nodesInFile: Node[],
  lineOf: (index: number) => number,
  ctx: ResolutionContext,
  jsHandlersByEvent: Map<string, Map<string, string>>,
): void {
  if (!isJsFamilyFile(file)) return;
  ADDLISTENER_ANY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ADDLISTENER_ANY.exec(content))) {
    const event = match[1];
    const arg = match[2];
    if (!event || !arg) continue;
    const targetId = listenerTargetId(arg, nodesInFile, lineOf(match.index), ctx);
    if (!targetId) continue;
    const map = jsHandlersByEvent.get(event) ?? new Map<string, string>();
    map.set(targetId, `${file}:${lineOf(match.index)}`);
    jsHandlersByEvent.set(event, map);
  }
}

function listenerTargetId(arg: string, nodesInFile: Node[], line: number, ctx: ResolutionContext): string | null {
  const bareName = arg.includes('.') ? arg.slice(arg.lastIndexOf('.') + 1) : arg;
  const namedHandler = ctx.getNodesByName(bareName).find((node) => node.kind === 'function' || node.kind === 'method');
  if (namedHandler) return namedHandler.id;
  const enclosing = enclosingFn(nodesInFile, line);
  if (enclosing) return enclosing.id;
  let smallest: Node | null = null;
  for (const node of nodesInFile) {
    if (node.kind !== 'constant' && node.kind !== 'variable') continue;
    const end = node.endLine ?? node.startLine;
    if (node.startLine <= line && end >= line) {
      if (!smallest || node.startLine >= smallest.startLine) smallest = node;
    }
  }
  return smallest?.id ?? null;
}

function isJsFamilyFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.mjs') || file.endsWith('.cjs');
}
