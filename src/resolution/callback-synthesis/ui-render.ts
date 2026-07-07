import type { Edge, Node } from '../../types';
import type { QueryBuilder } from '../../db/queries';
import type { ResolutionContext } from '../types';
import { MAX_CALLBACKS_PER_CHANNEL, MAX_JSX_CHILDREN, methodsContainedBy, sliceLines } from './shared';

const SETSTATE_RE = /this\.setState\s*\(/;
const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/;
const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
const JSX_OPENING_TAG_RE = /<([A-Z][A-Za-z0-9_]*)\b([^<>]*?)(?:\/>|>)/g;
const JSX_SIMPLE_PROP_RE = /\b([A-Za-z_$][\w$]*)\s*=\s*{\s*((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*}/g;
const MAX_LOCAL_FLOW_PROPS_PER_EDGE = 4;
const MAX_LOCAL_FLOW_PROPS_PER_PARENT = 8;
const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;
const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w]+)*\s*=\s*"([^"]+)"/g;
const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g;

type JsxLocalFlowInfo = {
  line: number;
  props: string[];
  capped: boolean;
};

export function reactRenderEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  return stateToLifecycleEdges(queries, ctx, 'render', (_node, src) => SETSTATE_RE.test(src), 'react-render');
}

export function flutterBuildEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  return stateToLifecycleEdges(queries, ctx, 'build', (node, src) => node.filePath.endsWith('.dart') && FLUTTER_SETSTATE_RE.test(src), 'flutter-build');
}

function stateToLifecycleEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  lifecycleName: string,
  shouldLink: (node: Node, src: string) => boolean,
  synthesizedBy: 'react-render' | 'flutter-build',
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const via = synthesizedBy === 'react-render' ? 'setState' : 'setState';
  for (const cls of queries.getNodesByKind('class')) {
    const children = methodsContainedBy(queries, cls.id);
    const lifecycle = children.find((node) => node.name === lifecycleName);
    if (!lifecycle) continue;
    let added = 0;
    for (const method of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (method.id === lifecycle.id) continue;
      const content = ctx.readFile(method.filePath);
      const src = content && sliceLines(content, method.startLine, method.endLine);
      if (!src || !shouldLink(method, src)) continue;
      const key = `${method.id}>${lifecycle.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: method.id,
        target: lifecycle.id,
        kind: 'calls',
        line: method.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy, via, registeredAt: `${lifecycle.filePath}:${lifecycle.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

export function reactJsxChildEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const parentKinds = new Set(['method', 'function', 'component']);
  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue;
    const parents = ctx.getNodesInFile(file).filter((node) => parentKinds.has(node.kind));
    for (const parent of parents) {
      const src = sliceLines(content, parent.startLine, parent.endLine);
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue;
      const names = new Set<string>();
      const localFlows = collectJsxLocalFlowHandoffs(src, parent.startLine);
      JSX_TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = JSX_TAG_RE.exec(src))) names.add(match[1]!);
      let added = 0;
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break;
        const child = ctx.getNodesByName(name).find((node) => node.kind === 'component' || node.kind === 'function' || node.kind === 'class');
        if (!child || child.id === parent.id) continue;
        const key = `${parent.id}>${child.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const localFlow = jsxLocalFlowMetadata(localFlows.get(name));
        edges.push({
          source: parent.id,
          target: child.id,
          kind: 'calls',
          line: parent.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'jsx-render',
            via: name,
            ...(localFlow ? { localFlow, registeredAt: `${parent.filePath}:${localFlows.get(name)!.line}` } : {}),
          },
        });
        added++;
      }
    }
  }
  return edges;
}

export function vueTemplateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const componentKinds = new Set(['component', 'function', 'class']);
  const handlerKinds = new Set(['method', 'function']);
  const returnKinds = new Set(['method', 'function', 'variable', 'constant']);
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const content = ctx.readFile(file);
    const template = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1];
    if (!content || !template) continue;
    const component = ctx.getNodesInFile(file).find((node) => node.kind === 'component');
    if (!component) continue;
    const destructured = collectVueDestructuredHandlers(content);
    let added = 0;
    const resolve = (name: string, kinds: Set<string>): Node | undefined => {
      const matches = ctx.getNodesByName(name).filter((node) => kinds.has(node.kind));
      return matches.find((node) => node.filePath === file) ?? matches[0];
    };
    const addEdge = (target: Node | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === component.id) return;
      const key = `${component.id}>${target.id}>${meta.synthesizedBy}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source: component.id, target: target.id, kind: 'calls', line: component.startLine, provenance: 'heuristic', metadata: meta });
      added++;
    };

    let match: RegExpExecArray | null;
    VUE_KEBAB_RE.lastIndex = 0;
    while ((match = VUE_KEBAB_RE.exec(template))) addEdge(resolve(kebabToPascal(match[1]!), componentKinds), { synthesizedBy: 'jsx-render', via: match[1] });
    VUE_HANDLER_RE.lastIndex = 0;
    while ((match = VUE_HANDLER_RE.exec(template))) {
      const event = match[1]!;
      const expr = match[2]!.trim();
      if (expr.includes('=>') || expr.startsWith('$')) continue;
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1];
      if (!name) continue;
      const direct = resolve(name, handlerKinds);
      if (direct) {
        addEdge(direct, { synthesizedBy: 'vue-handler', event });
        continue;
      }
      const destructuredHandler = destructured.get(name);
      if (!destructuredHandler) continue;
      const composable = resolve(destructuredHandler.composable, handlerKinds);
      const keyFn = composable
        ? ctx.getNodesByName(destructuredHandler.key).find((node) => returnKinds.has(node.kind) && node.filePath === composable.filePath)
        : undefined;
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: destructuredHandler.composable });
    }
  }
  return edges;
}

function collectJsxLocalFlowHandoffs(src: string, parentStartLine: number): Map<string, JsxLocalFlowInfo> {
  const byChild = new Map<string, JsxLocalFlowInfo>();
  let propsInParent = 0;
  JSX_OPENING_TAG_RE.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = JSX_OPENING_TAG_RE.exec(src))) {
    const childName = tag[1]!;
    const attrs = tag[2] ?? '';
    const line = parentStartLine + src.slice(0, tag.index).split('\n').length - 1;
    let info = byChild.get(childName);
    JSX_SIMPLE_PROP_RE.lastIndex = 0;
    let prop: RegExpExecArray | null;
    while ((prop = JSX_SIMPLE_PROP_RE.exec(attrs))) {
      const propName = prop[1]!;
      if (propName !== 'nonce' && !propName.endsWith('Nonce')) continue;
      if (!info) {
        info = { line, props: [], capped: false };
        byChild.set(childName, info);
      }
      if (info.props.includes(propName)) continue;
      if (propsInParent >= MAX_LOCAL_FLOW_PROPS_PER_PARENT || info.props.length >= MAX_LOCAL_FLOW_PROPS_PER_EDGE) {
        info.capped = true;
        continue;
      }
      info.props.push(propName);
      propsInParent++;
    }
  }
  return byChild;
}

function jsxLocalFlowMetadata(info: JsxLocalFlowInfo | undefined): Record<string, unknown> | null {
  if (!info || info.props.length === 0) return null;
  return {
    kind: 'jsx-prop-handoff',
    props: info.props,
    complete: false,
    confidence: 0.55,
    uncertainty: 'selected nonce-like JSX prop handoff only; value origin, aliases, and transformations are not modeled',
    capped: info.capped,
  };
}

function collectVueDestructuredHandlers(content: string): Map<string, { composable: string; key: string }> {
  const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  const destructured = new Map<string, { composable: string; key: string }>();
  VUE_DESTRUCTURE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VUE_DESTRUCTURE_RE.exec(script))) {
    if (!/^use[A-Z]/.test(match[2]!)) continue;
    for (const part of match[1]!.split(',')) {
      const partMatch = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/);
      if (partMatch) destructured.set(partMatch[2] || partMatch[1]!, { composable: match[2]!, key: partMatch[1]! });
    }
  }
  return destructured;
}

function kebabToPascal(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
