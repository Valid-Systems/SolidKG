import { Node } from '../../types';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const FEIGN_ROUTE_REF_PREFIX = 'spring-route:';
const MYBATIS_STATEMENT_REF_PREFIX = 'mybatis-statement:';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework') || pomXml.includes('mybatis'))) {
      return true;
    }

    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework') || buildGradle.includes('mybatis'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework') || buildGradleKts.includes('mybatis'))) {
      return true;
    }

    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (!file.endsWith('.java') && !file.endsWith('.xml')) continue;
      const content = context.readFile(file);
      if (content && (
        content.includes('@SpringBootApplication') ||
        content.includes('@RestController') ||
        content.includes('@FeignClient') ||
        content.includes('SqlSessionTemplate') ||
        content.includes('<mapper') ||
        content.includes('@Service') ||
        content.includes('@Repository')
      )) {
        return true;
      }
    }

    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith(FEIGN_ROUTE_REF_PREFIX) || name.startsWith(MYBATIS_STATEMENT_REF_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.fromNodeId.startsWith('route:')) {
      const result = resolveSameFileMethod(ref.referenceName, ref.filePath, context);
      if (result) return frameworkResult(ref, result, 0.95);
    }

    if (ref.referenceName.startsWith(FEIGN_ROUTE_REF_PREFIX)) {
      const result = resolveRouteByName(ref.referenceName.slice(FEIGN_ROUTE_REF_PREFIX.length), context);
      if (result) return frameworkResult(ref, result, 0.95);
    }

    if (ref.referenceName.startsWith(MYBATIS_STATEMENT_REF_PREFIX)) {
      const result = resolveMyBatisStatement(ref.referenceName.slice(MYBATIS_STATEMENT_REF_PREFIX.length), context);
      if (result) return frameworkResult(ref, result, 0.95);
    }

    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) return frameworkResult(ref, result, 0.85);
    }

    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
      if (result) return frameworkResult(ref, result, 0.85);
    }

    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) return frameworkResult(ref, result, 0.85);
    }

    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, ENTITY_DIRS, context);
      if (result) return frameworkResult(ref, result, 0.7);
    }

    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, COMPONENT_DIRS, context);
      if (result) return frameworkResult(ref, result, 0.8);
    }

    return null;
  },

  extract(filePath, content) {
    if (filePath.endsWith('.xml')) return extractMyBatisXml(filePath, content);
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    extractConditionalOnProperty(filePath, safe, lang, now, nodes, references);
    extractSqlSessionTemplateStatements(filePath, safe, lang, references);

    let classPrefix = '';
    const cls = /@RequestMapping\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.exec(safe);
    if (cls) classPrefix = parseMappingPath(cls[1]!);

    const verb: Record<string, string> = {
      GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
    };
    const mappingRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;
    while ((match = mappingRegex.exec(safe)) !== null) {
      const method = verb[match[1]!]!;
      const sub = parseMappingPath((match[2] || '').replace(/^\(|\)$/g, ''));
      const routePath = joinPath(classPrefix, sub);
      const line = lineAt(safe, match.index);
      const routeNode = makeRouteNode(filePath, line, method, routePath, lang, match[0].length, now);
      nodes.push(routeNode);

      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = findNextMethod(tail);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: methodMatch.name,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    const reqRe = /@RequestMapping\b\s*(\([^)]*\))?/g;
    while ((match = reqRe.exec(safe)) !== null) {
      const args = (match[1] || '').replace(/^\(|\)$/g, '');
      const after = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.test(after)) continue;
      const methodMatch = findNextMethod(after);
      if (!methodMatch) continue;
      const method = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/)?.[1]?.toUpperCase() ?? 'ANY';
      const routePath = joinPath(classPrefix, parseMappingPath(args));
      const line = lineAt(safe, match.index);
      const routeNode = makeRouteNode(filePath, line, method, routePath, lang, match[0].length, now);
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: methodMatch.name,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: lang,
      });
    }

    for (const endpoint of extractFeignEndpoints(safe)) {
      references.push({
        fromNodeId: generateNodeId(filePath, 'method', endpoint.methodName, endpoint.line),
        referenceName: `${FEIGN_ROUTE_REF_PREFIX}${endpoint.httpMethod} ${endpoint.routePath}`,
        referenceKind: 'calls',
        line: endpoint.line,
        column: 0,
        filePath,
        language: lang,
      });
    }

    return { nodes, references };
  },
};

const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

interface MethodMatch {
  name: string;
}

interface FeignEndpoint {
  methodName: string;
  httpMethod: string;
  routePath: string;
  line: number;
}

function frameworkResult(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

function makeRouteNode(
  filePath: string,
  line: number,
  method: string,
  routePath: string,
  language: 'java' | 'kotlin',
  width: number,
  now: number
): Node {
  return {
    id: `route:${filePath}:${line}:${method}:${routePath}`,
    kind: 'route',
    name: `${method} ${routePath}`,
    qualifiedName: `${filePath}::route:${routePath}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: width,
    language,
    updatedAt: now,
  };
}

function parseMappingPath(args: string): string {
  const m = args.match(/["']([^"']*)["']/);
  return m ? m[1]! : '';
}

function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function parseAnnotationArgs(annotation: string): Map<string, string> {
  const values = new Map<string, string>();
  const body = annotation.replace(/^@[\w.]+\s*/, '').replace(/^\(|\)$/g, '');
  const named = /\b(\w+)\s*=\s*(?:\{\s*)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = named.exec(body)) !== null) values.set(match[1]!, match[2]!);
  const first = body.match(/^[\s{]*["']([^"']+)["']/);
  if (first && !values.has('value')) values.set('value', first[1]!);
  return values;
}

function findNextMethod(source: string): MethodMatch | null {
  const kotlin = source.match(/\bfun\s+(\w+)\s*\(/);
  if (kotlin) return { name: kotlin[1]! };
  const java = source.match(/\b(?:public|private|protected|default|static|final|abstract|synchronized|native|strictfp|\s)*[\w<>?,\[\].]+\s+(\w+)\s*\(/);
  return java ? { name: java[1]! } : null;
}

function findNextType(source: string): { kind: 'class' | 'interface'; name: string } | null {
  const match = source.match(/\b(class|interface)\s+(\w+)\b/);
  return match ? { kind: match[1] as 'class' | 'interface', name: match[2]! } : null;
}

function extractConditionalOnProperty(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  now: number,
  nodes: Node[],
  references: UnresolvedRef[]
): void {
  const regex = /@ConditionalOnProperty\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(safe)) !== null) {
    const values = parseAnnotationArgs(match[0]);
    const name = values.get('name') ?? values.get('value');
    if (!name) continue;
    const prefix = values.get('prefix');
    const key = prefix ? `${prefix.replace(/\.$/, '')}.${name}` : name;
    const line = lineAt(safe, match.index);
    nodes.push({
      id: `spring-property:${filePath}:${line}:${key}`,
      kind: 'constant',
      name: key,
      qualifiedName: `spring.property:${key}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: lang,
      updatedAt: now,
    });

    const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 500);
    const method = findNextMethod(tail);
    const type = findNextType(tail);
    const source = method
      ? { id: generateNodeId(filePath, 'method', method.name, line + lineAt(tail, tail.indexOf(method.name)) - 1) }
      : type
        ? { id: generateNodeId(filePath, type.kind, type.name, line + lineAt(tail, tail.indexOf(type.name)) - 1) }
        : null;
    if (!source) continue;
    references.push({
      fromNodeId: source.id,
      referenceName: key,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }
}

function extractFeignEndpoints(safe: string): FeignEndpoint[] {
  const endpoints: FeignEndpoint[] = [];
  const feignRegex = /@FeignClient\s*\(([^)]*)\)[\s\S]*?\binterface\s+\w+\b[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = feignRegex.exec(safe)) !== null) {
    const clientPath = parseAnnotationArgs(`@FeignClient(${match[1]!})`).get('path') ?? '';
    const bodyStart = safe.indexOf('{', match.index);
    const bodyEnd = findMatchingBrace(safe, bodyStart);
    if (bodyStart < 0 || bodyEnd < bodyStart) continue;
    const body = safe.slice(bodyStart + 1, bodyEnd);
    const endpointRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b\s*(\([^)]*\))?\s*(?:public\s+)?[\w<>?,\[\].]+\s+(\w+)\s*\(/g;
    let endpoint: RegExpExecArray | null;
    while ((endpoint = endpointRegex.exec(body)) !== null) {
      const mapping = mappingFromAnnotation(endpoint[1]!, (endpoint[2] || '').replace(/^\(|\)$/g, ''));
      if (!mapping) continue;
      endpoints.push({
        methodName: endpoint[3]!,
        httpMethod: mapping.httpMethod,
        routePath: joinPath(clientPath, mapping.path),
        line: lineAt(safe, bodyStart + 1 + endpoint.index),
      });
    }
  }
  return endpoints;
}

function mappingFromAnnotation(name: string, args: string): { httpMethod: string; path: string } | null {
  const verb: Record<string, string> = {
    GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
  };
  if (verb[name]) return { httpMethod: verb[name]!, path: parseMappingPath(args) };
  if (name !== 'RequestMapping') return null;
  return { httpMethod: args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/)?.[1]?.toUpperCase() ?? 'ANY', path: parseMappingPath(args) };
}

function extractSqlSessionTemplateStatements(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  references: UnresolvedRef[]
): void {
  const statementRegex = /\b(?:sqlSessionTemplate|sqlSession)\s*\.\s*(?:selectOne|selectList|insert|update|delete)\s*\(\s*["']([\w.]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = statementRegex.exec(safe)) !== null) {
    const owner = findEnclosingMethod(safe, match.index);
    if (!owner) continue;
    references.push({
      fromNodeId: generateNodeId(filePath, 'method', owner.name, owner.line),
      referenceName: `${MYBATIS_STATEMENT_REF_PREFIX}${match[1]!}`,
      referenceKind: 'calls',
      line: lineAt(safe, match.index),
      column: 0,
      filePath,
      language: lang,
    });
  }
}

function extractMyBatisXml(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
  if (!/<mapper\b/.test(content)) return { nodes: [], references: [] };
  const nodes: Node[] = [];
  const now = Date.now();
  const namespace = content.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/)?.[1];
  if (!namespace) return { nodes, references: [] };
  const statementRegex = /<(select|insert|update|delete)\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = statementRegex.exec(content)) !== null) {
    const id = match[2]!;
    const statementId = `${namespace}.${id}`;
    const line = lineAt(content, match.index);
    nodes.push({
      id: `mybatis-statement:${filePath}:${line}:${statementId}`,
      kind: 'method',
      name: statementId,
      qualifiedName: statementId,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: 'yaml',
      updatedAt: now,
    });
  }
  return { nodes, references: [] };
}

function findMatchingBrace(source: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findEnclosingMethod(source: string, offset: number): { name: string; line: number } | null {
  const before = source.slice(0, offset);
  const methodRegex = /\b(?:public|private|protected|default|static|final|abstract|synchronized|native|strictfp|\s)*[\w<>?,\[\].]+\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  let owner: { name: string; line: number } | null = null;
  while ((match = methodRegex.exec(before)) !== null) {
    owner = { name: match[1]!, line: lineAt(before, match.index) };
  }
  return owner;
}

function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  const preferred = kindFiltered.filter((n) => preferredDirPatterns.some((d) => n.filePath.includes(d)));
  if (preferred.length > 0) return preferred[0]!.id;

  return kindFiltered[0]!.id;
}

function resolveRouteByName(routeName: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(routeName).filter((node) => node.kind === 'route');
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function resolveSameFileMethod(name: string, filePath: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesInFile(filePath).filter((node) => node.kind === 'method' && node.name === name);
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function resolveMyBatisStatement(statementId: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(statementId).filter((node) => node.qualifiedName === statementId && node.id.startsWith('mybatis-statement:'));
  return candidates.length === 1 ? candidates[0]!.id : null;
}
