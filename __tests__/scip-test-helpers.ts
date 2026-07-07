import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { create } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  PositionEncoding,
  RelationshipSchema,
  serializeSCIP,
  SymbolInformationSchema,
  SymbolInformation_Kind,
  SymbolRole,
} from '@c4312/scip';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

export const tempDirs: string[] = [];

export function createTempDir(prefix = 'cg-scip-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createQueries(): { conn: DatabaseConnection; queries: QueryBuilder; dbPath: string; root: string } {
  const root = createTempDir();
  const dbPath = path.join(root, 'solidkg.db');
  const conn = DatabaseConnection.initialize(dbPath);
  return { conn, queries: new QueryBuilder(conn.getDb()), dbPath, root };
}

export function writeScipFixture(root: string, fileName: string, options: {
  projectRoot?: string;
  relativePath?: string;
  language?: string;
  symbol?: string;
  displayName?: string;
  kind?: SymbolInformation_Kind;
  range?: number[];
  referenceRange?: number[];
  relationshipTarget?: string;
  relationshipImplementation?: boolean;
  relationshipTypeDefinition?: boolean;
  toolName?: string;
  toolVersion?: string;
  localCollision?: boolean;
} = {}): string {
  const projectRoot = options.projectRoot ?? root;
  const relativePath = options.relativePath ?? 'src/service.ts';
  const symbol = options.symbol ?? 'npm test 1.0.0 Service#run().';
  const displayName = options.displayName ?? 'run';
  const relationshipTarget = options.relationshipTarget;

  const symbols = [
    create(SymbolInformationSchema, {
      symbol,
      displayName,
      kind: options.kind ?? SymbolInformation_Kind.Function,
      documentation: ['Runs the service.'],
      signatureDocumentation: create(DocumentSchema, {
        language: 'typescript',
        text: 'function run(): void',
        relativePath: '',
        occurrences: [],
        symbols: [],
        positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
      }),
      relationships: relationshipTarget
        ? [create(RelationshipSchema, {
          symbol: relationshipTarget,
          isImplementation: options.relationshipImplementation ?? false,
          isTypeDefinition: options.relationshipTypeDefinition ?? false,
          isReference: !(options.relationshipImplementation || options.relationshipTypeDefinition),
        })]
        : [],
    }),
  ];

  if (options.localCollision) {
    symbols.push(create(SymbolInformationSchema, {
      symbol: 'local 1',
      displayName: 'localValue',
      kind: SymbolInformation_Kind.Variable,
    }));
  }

  const occurrences = [
    create(OccurrenceSchema, {
      range: options.range ?? [0, 16, 19],
      symbol,
      symbolRoles: SymbolRole.Definition,
      enclosingRange: [0, 0, 1, 1],
    }),
    create(OccurrenceSchema, {
      range: options.referenceRange ?? [2, 0, 3],
      symbol,
      symbolRoles: SymbolRole.ReadAccess,
    }),
  ];

  if (options.localCollision) {
    occurrences.push(create(OccurrenceSchema, {
      range: [1, 6, 16],
      symbol: 'local 1',
      symbolRoles: SymbolRole.Definition,
    }));
  }

  const index = create(IndexSchema, {
    metadata: {
      projectRoot,
      textDocumentEncoding: 1,
      toolInfo: { name: options.toolName ?? 'fixture-scip', version: options.toolVersion ?? '1.0.0', arguments: ['index'] },
    },
    documents: [create(DocumentSchema, {
      relativePath,
      language: options.language ?? 'typescript',
      positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
      occurrences,
      symbols,
      text: 'export function run(): void {}\nconst localValue = 1;\nrun();\n',
    })],
    externalSymbols: relationshipTarget
      ? [create(SymbolInformationSchema, {
        symbol: relationshipTarget,
        displayName: 'Contract',
        kind: SymbolInformation_Kind.Interface,
      })]
      : [],
  });

  const out = path.join(root, fileName);
  fs.writeFileSync(out, Buffer.from(serializeSCIP(index)));
  return out;
}

export function writeManyScipDefinitionsFixture(root: string, fileName: string, count: number): string {
  const symbols = Array.from({ length: count }, (_, index) => {
    const name = `run${index}`;
    return create(SymbolInformationSchema, {
      symbol: `npm test 1.0.0 Service#${name}().`,
      displayName: name,
      kind: SymbolInformation_Kind.Function,
      relationships: [create(RelationshipSchema, {
        symbol: 'npm test 1.0.0 Contract#',
        isImplementation: true,
      })],
    });
  });

  const occurrences = symbols.map((symbol, index) => create(OccurrenceSchema, {
    range: [index, 16, 20 + String(index).length],
    symbol: symbol.symbol,
    symbolRoles: SymbolRole.Definition,
  }));

  const index = create(IndexSchema, {
    metadata: {
      projectRoot: root,
      textDocumentEncoding: 1,
      toolInfo: { name: 'many-fixture-scip', version: '1.0.0', arguments: ['index'] },
    },
    documents: [create(DocumentSchema, {
      relativePath: 'src/service.ts',
      language: 'typescript',
      positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
      occurrences,
      symbols,
      text: symbols.map((symbol) => `export function ${symbol.displayName}(): void {}`).join('\n'),
    })],
    externalSymbols: [create(SymbolInformationSchema, {
      symbol: 'npm test 1.0.0 Contract#',
      displayName: 'Contract',
      kind: SymbolInformation_Kind.Interface,
    })],
  });

  const out = path.join(root, fileName);
  fs.writeFileSync(out, Buffer.from(serializeSCIP(index)));
  return out;
}

export function writeRelationshipBeforeSymbolFixture(root: string, fileName: string): string {
  const index = create(IndexSchema, {
    metadata: {
      projectRoot: root,
      textDocumentEncoding: 1,
      toolInfo: { name: 'relationship-before-symbol-scip', version: '1.0.0', arguments: ['index'] },
    },
    documents: [create(DocumentSchema, {
      relativePath: 'src/service.ts',
      language: 'typescript',
      positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
      occurrences: [],
      symbols: [
        create(SymbolInformationSchema, {
          symbol: 'npm test 1.0.0 Service#run().',
          displayName: 'run',
          kind: SymbolInformation_Kind.Function,
          relationships: [create(RelationshipSchema, {
            symbol: 'npm test 1.0.0 Contract#',
            isImplementation: true,
          })],
        }),
        create(SymbolInformationSchema, {
          symbol: 'npm test 1.0.0 Contract#',
          displayName: 'Contract',
          kind: SymbolInformation_Kind.Interface,
          documentation: ['Contract documentation.'],
        }),
      ],
      text: 'export function run(): void {}\ninterface Contract {}\n',
    })],
    externalSymbols: [],
  });

  const out = path.join(root, fileName);
  fs.writeFileSync(out, Buffer.from(serializeSCIP(index)));
  return out;
}

export function writeEmptyScipFixture(root: string, fileName: string): string {
  const index = create(IndexSchema, {
    metadata: {
      projectRoot: root,
      textDocumentEncoding: 1,
      toolInfo: { name: 'empty-fixture-scip', version: '1.0.0', arguments: ['index'] },
    },
    documents: [],
    externalSymbols: [],
  });
  const out = path.join(root, fileName);
  fs.writeFileSync(out, Buffer.from(serializeSCIP(index)));
  return out;
}

export function seedSolidKGNode(queries: QueryBuilder, overrides: Partial<Node> = {}): Node {
  const node: Node = {
    id: overrides.id ?? 'node:run',
    kind: overrides.kind ?? 'function',
    name: overrides.name ?? 'run',
    qualifiedName: overrides.qualifiedName ?? 'src/service.ts::run',
    filePath: overrides.filePath ?? 'src/service.ts',
    language: overrides.language ?? 'typescript',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    startColumn: overrides.startColumn ?? 0,
    endColumn: overrides.endColumn ?? 34,
    updatedAt: overrides.updatedAt ?? 1,
  };
  queries.upsertFile({
    path: node.filePath,
    contentHash: `hash:${node.filePath}`,
    language: node.language,
    size: 100,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 1,
  });
  queries.insertNode(node);
  return node;
}
