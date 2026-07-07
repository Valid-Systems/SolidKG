import type { Edge } from '../../types';
import type { ResolutionContext } from '../types';
import { enclosingFn, EVENT_FANOUT_CAP } from './shared';

const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g;
const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;

export function eventEmitterEdges(ctx: ResolutionContext): Edge[] {
  const emitsByEvent = new Map<string, Set<string>>();
  const handlersByEvent = new Map<string, Map<string, string>>();

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (index: number) => content.slice(0, index).split('\n').length;

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EMIT_RE.exec(content))) {
        const dispatcher = enclosingFn(nodesInFile, lineOf(match.index));
        if (!dispatcher) continue;
        const set = emitsByEvent.get(match[1]!) ?? new Set<string>();
        set.add(dispatcher.id);
        emitsByEvent.set(match[1]!, set);
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ON_RE.exec(content))) {
        const handlerName = match[2] || match[3];
        if (!handlerName) continue;
        const handler = ctx.getNodesByName(handlerName).find((node) => node.kind === 'function' || node.kind === 'method');
        if (!handler) continue;
        const map = handlersByEvent.get(match[1]!) ?? new Map<string, string>();
        map.set(handler.id, `${file}:${lineOf(match.index)}`);
        handlersByEvent.set(match[1]!, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event);
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
          metadata: { synthesizedBy: 'event-emitter', event, registeredAt },
        });
      }
    }
  }
  return edges;
}
