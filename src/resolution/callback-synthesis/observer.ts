import type { Edge, Node } from '../../types';
import type { QueryBuilder } from '../../db/queries';
import type { ResolutionContext } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL, sliceLines } from './shared';

const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/;
const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i;

function registrarField(src: string): string | null {
  const match = src.match(/this\.(\w+)\.(?:add|push|set)\(/);
  return match ? match[1]! : null;
}

function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/);
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!;
  const forEach = src.match(/this\.(\w+)\.forEach\(/);
  if (forEach) return forEach[1]!;
  return null;
}

export function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const candidates = [...queries.getNodesByKind('method'), ...queries.getNodesByKind('function')];
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  for (const node of candidates) {
    const isRegistrar = REGISTRAR_NAME.test(node.name);
    const isDispatcher = DISPATCHER_NAME.test(node.name);
    if (!isRegistrar && !isDispatcher) continue;
    const content = ctx.readFile(node.filePath);
    const src = content && sliceLines(content, node.startLine, node.endLine);
    if (!src) continue;
    if (isRegistrar) {
      const field = registrarField(src);
      if (field) registrars.push({ node, field });
    }
    if (isDispatcher) {
      const field = dispatcherField(src);
      if (field) dispatchers.push({ node, field });
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const registrar of registrars) {
    const channelDispatchers = dispatchers.filter(
      (dispatcher) => dispatcher.node.filePath === registrar.node.filePath && dispatcher.field === registrar.field,
    );
    if (channelDispatchers.length === 0) continue;
    const argRe = new RegExp(`${registrar.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`);
    let added = 0;
    for (const edge of queries.getIncomingEdges(registrar.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (!edge.line) continue;
      const caller = queries.getNodeById(edge.source);
      if (!caller) continue;
      const line = ctx.readFile(caller.filePath)?.split('\n')[edge.line - 1];
      const argMatch = line?.match(argRe);
      if (!argMatch) continue;
      const callback = ctx.getNodesByName(argMatch[1]!).find((node) => node.kind === 'method' || node.kind === 'function');
      if (!callback) continue;
      for (const dispatcher of channelDispatchers) {
        if (dispatcher.node.id === callback.id) continue;
        const key = `${dispatcher.node.id}>${callback.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: dispatcher.node.id,
          target: callback.id,
          kind: 'calls',
          line: dispatcher.node.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback',
            via: registrar.node.name,
            field: registrar.field,
            registeredAt: `${caller.filePath}:${edge.line}`,
          },
        });
        added++;
      }
    }
  }
  return edges;
}
