import { FrameworkRelationHint, Node } from '../../types';
import { FrameworkResolver, ResolutionContext, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

type HonoRouteDef = {
  receiver: string;
  method: string;
  routePath: string;
  line: number;
  args: string[];
};

function matchDelim(source: string, open: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index++;
        index++;
      }
      continue;
    }
    if (char === opening) depth++;
    if (char === closing) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelArgs(source: string): string[] {
  const args: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index++;
        index++;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    if (char === ')' || char === ']' || char === '}') stack.pop();
    if (char === ',' && stack.length === 0) {
      const arg = source.slice(start, index).trim();
      if (arg) args.push(arg);
      start = index + 1;
    }
  }
  const finalArg = source.slice(start).trim();
  if (finalArg) args.push(finalArg);
  return args;
}

function stringLiteralValue(arg: string): string | null {
  const match = arg.trim().match(/^['"`]([^'"`]+)['"`]$/);
  return match ? match[1]! : null;
}

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const match = cleaned.match(/(?:\.|^)([A-Za-z_$][\w$]*)$/);
  return match ? match[1]! : null;
}

function joinPaths(prefix: string, routePath: string): string {
  const left = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const right = routePath === '/' ? '' : routePath.replace(/^\/+/, '');
  if (!right) return left || '/';
  const joined = `${left}/${right}`.replace(/\/+/g, '/');
  return joined === '' ? '/' : joined;
}

function routeChainHint(routeNode: Node, filePath: string, line: number, args: string[]): FrameworkRelationHint | null {
  const members = args.slice(1)
    .map((arg) => extractTailIdent(arg))
    .filter((name): name is string => Boolean(name));
  if (members.length === 0) return null;
  return {
    id: `hint:hono:${routeNode.id}`,
    kind: 'route_chain',
    relationKind: 'route_binding',
    sourceFile: filePath,
    line,
    column: 0,
    members: [
      { role: 'route', ordinal: 0, nodeId: routeNode.id },
      ...members.map((name, index) => ({
        role: (index === members.length - 1 ? 'handler' : (/validate/i.test(name) ? 'validator' : 'middleware')) as 'handler' | 'middleware' | 'validator',
        ordinal: index + 1,
        referenceName: name,
        referenceKind: 'references' as const,
      })),
    ],
  };
}

function routeNode(filePath: string, lang: 'typescript' | 'javascript', method: string, routePath: string, line: number, now: number): Node {
  return {
    id: `route:${filePath}:${line}:${method}:${routePath}`,
    kind: 'route',
    name: `${method} ${routePath}`,
    qualifiedName: `${filePath}::${method}:${routePath}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    language: lang,
    updatedAt: now,
  };
}

function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript';
}

export const honoResolver: FrameworkResolver = {
  name: 'hono',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.hono) return true;
      } catch {
      }
    }
    return context.getAllFiles().some((file) => {
      if (!/\.(m?js|tsx?|cjs)$/.test(file)) return false;
      const content = context.readFile(file);
      return Boolean(content?.includes('from "hono"') || content?.includes("from 'hono'") || content?.includes('require("hono")') || content?.includes("require('hono')"));
    });
  },

  resolve: () => null,

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };

    const lang = detectLanguage(filePath);
    const safe = stripCommentsForRegex(content, lang);
    if (!/\b(?:new\s+Hono|from\s+['"]hono['"]|require\(['"]hono['"]\))/.test(safe)) return { nodes: [], references: [] };

    const now = Date.now();
    const routeDefs: HonoRouteDef[] = [];
    const mounts: Array<{ prefix: string; router: string }> = [];
    const head = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|on|route)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = head.exec(safe)) !== null) {
      const receiver = match[1]!;
      const methodName = match[2]!;
      const openParen = safe.indexOf('(', match.index);
      const closeParen = openParen >= 0 ? matchDelim(safe, openParen, '(', ')') : -1;
      if (closeParen <= openParen) continue;
      const args = splitTopLevelArgs(safe.slice(openParen + 1, closeParen));
      const line = safe.slice(0, match.index).split('\n').length;

      if (methodName === 'route') {
        const prefix = args[0] ? stringLiteralValue(args[0]) : null;
        const router = args[1] ? extractTailIdent(args[1]) : null;
        if (prefix && router) mounts.push({ prefix, router });
        continue;
      }

      if (methodName === 'on') {
        const method = args[0] ? stringLiteralValue(args[0])?.toUpperCase() : null;
        const routePath = args[1] ? stringLiteralValue(args[1]) : null;
        if (method && routePath) routeDefs.push({ receiver, method, routePath, line, args: args.slice(1) });
        continue;
      }

      const routePath = args[0] ? stringLiteralValue(args[0]) : null;
      if (routePath) routeDefs.push({ receiver, method: methodName.toUpperCase(), routePath, line, args });
    }

    const mountedReceivers = new Set(mounts.map((mount) => mount.router));
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const relationHints: FrameworkRelationHint[] = [];

    const emit = (def: HonoRouteDef, routePath: string) => {
      const node = routeNode(filePath, lang, def.method, routePath, def.line, now);
      nodes.push(node);
      const handlerName = def.args.length > 1 ? extractTailIdent(def.args[def.args.length - 1]!) : null;
      if (handlerName) {
        references.push({
          fromNodeId: node.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line: def.line,
          column: 0,
          filePath,
          language: lang,
        });
      }
      const hint = routeChainHint(node, filePath, def.line, def.args);
      if (hint) relationHints.push(hint);
    };

    for (const def of routeDefs) {
      if (!mountedReceivers.has(def.receiver)) emit(def, def.routePath);
    }

    for (const mount of mounts) {
      for (const def of routeDefs) {
        if (def.receiver === mount.router) emit(def, joinPaths(mount.prefix, def.routePath));
      }
    }

    return { nodes, references, relationHints };
  },
};
