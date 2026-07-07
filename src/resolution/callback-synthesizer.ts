import type { Edge } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { fieldChannelEdges } from './callback-synthesis/observer';
import { eventEmitterEdges } from './callback-synthesis/event-emitter';
import { reactRenderEdges, reactJsxChildEdges, vueTemplateEdges, flutterBuildEdges } from './callback-synthesis/ui-render';
import { cppOverrideEdges, interfaceOverrideEdges } from './callback-synthesis/interface-dispatch';
import { rnEventEdges, fabricNativeImplEdges } from './callback-synthesis/native-bridges';

export function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): number {
  const edgeGroups = [
    fieldChannelEdges(queries, ctx),
    eventEmitterEdges(ctx),
    reactRenderEdges(queries, ctx),
    reactJsxChildEdges(ctx),
    vueTemplateEdges(ctx),
    flutterBuildEdges(queries, ctx),
    cppOverrideEdges(queries),
    interfaceOverrideEdges(queries),
    rnEventEdges(ctx),
    fabricNativeImplEdges(ctx),
  ];

  const merged: Edge[] = [];
  const seen = new Set<string>();
  for (const group of edgeGroups) {
    for (const edge of group) {
      const key = synthesizedEdgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(edge);
    }
  }
  if (merged.length > 0) queries.insertEdges(merged);
  return merged.length;
}

function synthesizedEdgeKey(edge: Edge): string {
  return [
    edge.source,
    edge.target,
    edge.kind,
    edge.provenance ?? '',
    edge.line ?? '',
    edge.column ?? '',
    JSON.stringify(edge.metadata ?? {}),
  ].join('\0');
}
