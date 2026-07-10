// allow: SIZE_OK — declarative MCP schema registry kept together so tool
// descriptions, input schemas, and dataDir augmentation remain reviewable as
// one protocol contract instead of being scattered by arbitrary size shards.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Path to a different project with .solidkg/ initialized. If omitted, uses current project. Use this to query other codebases.',
};

const dataDirProperty: PropertySchema = {
  type: 'string',
  description: 'Directory containing SolidKG data for projectPath. Defaults to <projectPath>/.solidkg or the server --data-dir.',
};

export function withDataDirSchemas(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  return definitions.map((tool) => {
    const properties = tool.inputSchema.properties;
    if (!properties.projectPath || properties.dataDir) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...properties, dataDir: dataDirProperty },
      },
    };
  });
}

export const tools: ToolDefinition[] = [
  {
    name: 'solidkg_search',
    description: 'Quick symbol search by name. Returns locations, node IDs, ranking evidence, compact follow-up guidance, and linked SCIP symbols when available (no code). Use solidkg_context instead for comprehensive task context. Supports inline filters kind:, lang:/language:, path:, and name:.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name. Supports inline filters like kind:class lang:python path:src name:TaskInstance.',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'solidkg_context',
    description: 'PRIMARY TOOL. Call this first for broad "how does X work", architecture, feature, or bug-context questions. Use detailLevel="minimal" for first-pass exploration to get orientation, entry points, related files, semantic relation counts, and suggested follow-up tools without source-heavy output. Use standard detail for detailed implementation, debugging, or source inspection. Prefer this over chaining solidkg_search + solidkg_node, and over starting with solidkg_explore. NOTE: provides code context, not product requirements; for new features still clarify UX/edge cases with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task, bug, or feature to build context for',
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum symbols to include (default: 20)',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: 'Include code snippets for key symbols (default: true)',
          default: true,
        },
        maxCodeBlocks: {
          type: 'number',
          description: 'Maximum code blocks to include when code snippets are enabled',
        },
        detailLevel: {
          type: 'string',
          description: 'Detail preset for context output. Use minimal for broad first-pass exploration, then standard for detailed implementation, debugging, or source inspection.',
          enum: ['standard', 'minimal'],
          default: 'standard',
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  {
    name: 'solidkg_callers',
    description: 'Find all functions/methods that call a specific symbol. Useful for understanding usage patterns and impact of changes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'solidkg_callees',
    description: 'Find all functions/methods that a specific symbol calls. Useful for understanding dependencies and code flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'solidkg_impact',
    description: 'Analyze the impact radius of changing a symbol. Shows what code could be affected by modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'solidkg_node',
    description: 'Get ONE symbol\'s details (location, signature, docstring) PLUS its TRAIL — what it calls and what calls it, each with file:line. Includes semantic relations and linked SCIP precise refs when available. Pass includeCode=true for source (functions return their body; containers return a member outline). Use this for one bounded symbol or one specific missing hop. Do NOT loop solidkg_node over many symbols; use one focused solidkg_explore for several related symbols/source. Source returned with includeCode is the verbatim live file content — identical to Read.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to get details for',
        },
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'solidkg_explore',
    description: 'PRIMARY ANSWER TOOL. Give it a natural-language question or precise symbol/file/code terms. In ONE answer-producing call it returns the best production source grouped by file, relationship and flow evidence, dynamic-dispatch links, and an answer packet that says whether the selected evidence is sufficient. Returned code is verbatim live, line-numbered source — treat it as already Read and do not re-open shown files. Source-completeness labels describe candidate coverage, not answer correctness; when the packet is sufficient, answer without drilling into more tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language structural question or precise symbol/file/code terms (e.g., "How does auth work?", "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts").',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'solidkg_precise_refs',
    description: 'Return compiler-grade SCIP definitions, references, implementations, and type-definition relationships for a linked SolidKG node or symbol. This is generic across languages; no language-specific refs tools are exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'SolidKG node ID whose linked SCIP symbol should be queried. You can get node IDs from solidkg_search or solidkg_node output.',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name or exact SCIP symbol to query when a node ID is not known',
        },
        includeDefinitions: {
          type: 'boolean',
          description: 'Include definition occurrences (default: true)',
          default: true,
        },
        includeReferences: {
          type: 'boolean',
          description: 'Include reference occurrences in addition to definitions (default: true)',
          default: true,
        },
        includeImplementations: {
          type: 'boolean',
          description: 'Include implementation relationships from SCIP (default: true)',
          default: true,
        },
        includeTypeDefinitions: {
          type: 'boolean',
          description: 'Include type-definition relationships (default: true)',
          default: true,
        },
        limit: {
          type: 'number',
          description: 'Maximum occurrences or relationships per section (default: 50)',
          default: 50,
        },
        projectPath: projectPathProperty,
        dataDir: dataDirProperty,
      },
    },
  },
  {
    name: 'solidkg_status',
    description: 'Get the status of the SolidKG index, including statistics about indexed files, nodes, edges, semantic relations, and imported/linked SCIP facts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'solidkg_files',
    description: 'REQUIRED for file/folder exploration. Get the project file structure from the SolidKG index. Returns indexed file trees or an overview projection with language, symbol-kind, conservative anchor, and architecture hints. Much faster than Glob/filesystem scanning. Use this FIRST when exploring project structure, finding files, or understanding codebase organization.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language), or "overview" (progressive codebase map with rollups)',
          enum: ['tree', 'flat', 'grouped', 'overview'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show. For overview, default is 2 to keep output budgeted; for tree, default is unlimited.',
        },
        expandPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Overview-only: repository-relative paths to expand beyond maxDepth while keeping unrelated folders collapsed (max 50 paths).',
        },
        maxEntries: {
          type: 'number',
          description: 'Overview-only: maximum rendered tree entries before capping output (default 160).',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'solidkg_snapshot',
    description: 'Create, list, delete, or diff explicit graph snapshots. Snapshots capture nodes, pairwise edges, semantic hyperedges, and hyperedge members for refactor verification.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Snapshot action to run',
          enum: ['create', 'list', 'delete', 'diff'],
          default: 'list',
        },
        label: {
          type: 'string',
          description: 'Snapshot label for create/delete/diff',
        },
        description: {
          type: 'string',
          description: 'Optional human description for create',
        },
        metadataJson: {
          type: 'string',
          description: 'Optional JSON object metadata for create',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'solidkg_architecture',
    description: 'Analyze or retrieve package/layer architecture rollups with Ca/Ce/instability coupling metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Architecture action to run',
          enum: ['analyze', 'get', 'coupling', 'package'],
          default: 'get',
        },
        package: {
          type: 'string',
          description: 'Package name or root path for action=package',
        },
        layersJson: {
          type: 'string',
          description: 'Optional JSON array of layer rules for analyze, e.g. [{"name":"api","paths":["src/api/**"]}]',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'solidkg_trace',
    description: 'Trace the CALL PATH between two symbols — "how does <from> reach/become <to>?" Returns the chain of functions from one to the other (each hop with file:line and its body inlined, plus the outgoing calls of the destination itself) in ONE call, including linked SCIP precise-ref hints on path nodes when available. This is something grep/Read structurally cannot do: there is no text pattern for "the path from A to B". Ideal for flow questions — how an update triggers a render, how a request reaches a handler, how a QuerySet becomes SQL. If no static path exists the chain likely breaks at dynamic dispatch (callbacks/descriptors/metaclasses); the tool says where and points you to solidkg_node to bridge it.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Symbol the flow starts at (e.g., "QuerySet", "handleRequest", "mutateElement")',
        },
        to: {
          type: 'string',
          description: 'Symbol the flow should reach (e.g., "execute_sql", "render", "setState")',
        },
        projectPath: projectPathProperty,
      },
      required: ['from', 'to'],
    },
  },
];
