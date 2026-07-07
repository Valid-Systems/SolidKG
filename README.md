# SolidKG

<p align="center">
  <img width="500" alt="solidkg" src="https://github.com/user-attachments/assets/6c138932-b594-4dd2-8393-62197bc057de" />
</p>

My version of a knowledge graph for codebases, intended for serious production use. Includes hyperedges, SCIP, capability footprints, and a bunch of fine-tuning and optimizations for token efficiency.

Inspired by [Codegraph](https://github.com/colbymchenry/codegraph), [Sverklo](https://github.com/sverklo/sverklo), [Tilth](https://github.com/jahala/tilth), and [Cartog](https://github.com/jrollin/cartog).

Keep in mind that static analysis has limits. Generated code, reflection-heavy code, and unusual framework conventions may still require direct source inspection.

## Code intelligence highlights

- Builds a local AST-derived graph with symbols, calls, imports, framework routes, semantic hyperedges, capability footprints, and optional SCIP references.
- Answers agent questions through existing structural tools (`trace`, `context`, `explore`, `search`, callers/callees/impact) instead of a broad source scan.
- Bridges common dynamic-dispatch and framework boundaries such as callbacks, EventEmitter channels, React render/JSX flows, Django ORM descriptors, Swift/Objective-C, React Native, Expo modules, and many route-to-handler patterns.
- Uses local source-body chunks and graph-ranked file allocation to improve natural-language implementation queries while keeping exact symbol/path/trace evidence higher priority.
- Keeps embeddings, vector databases, rerankers, API calls, and telemetry disabled by default.

Evidence-backed capability notes, measured benchmark results, validated repos, and known frontiers are tracked in [`docs/code-intelligence-capabilities.md`](docs/code-intelligence-capabilities.md).

We have also stress-tested SolidKG on many of the largest and most important open-source codebases, including VS Code, TypeScript, React, Kubernetes, CPython, PyTorch, TensorFlow, LLVM, Rust, Go, Swift, Flutter, Angular, Next.js, Spark, Kafka, Elasticsearch, Kibana, and more. The full tested-codebase inventory is tracked in [`docs/tested-codebases.md`](docs/tested-codebases.md).

## Quick Start

Use Node 24 and pnpm.

```bash
pnpm install
pnpm run build
node dist/bin/solidkg.js init -i /path/to/project
node dist/bin/solidkg.js status /path/to/project
```

Use `--data-dir` if the index should live outside the source tree:

```bash
node dist/bin/solidkg.js init -i --data-dir /local/solidkg-data/project-a /path/to/project
```

## CLI Commands

You can try the CLI after building:

```bash
node dist/bin/solidkg.js <command> [options]
```

Common commands:

| Command | Purpose |
| --- | --- |
| `init` | Create SolidKG data for a project. |
| `init -i` | Initialize and index immediately. |
| `index` | Rebuild the graph. |
| `sync` | Update the graph after file changes. |
| `status` | Show index health and counts. |
| `files` | Show indexed files, including `--format overview` for a progressive repository map. |
| `overview` | Show the indexed repository summary tree directly. |
| `query` | Search symbols and graph nodes. |
| `context` | Build focused context for a task. |
| `callers` / `callees` | Traverse direct call relationships. |
| `impact` | Estimate what a symbol change can affect. |
| `affected` | Find tests related to changed source files. |
| `snapshot` | Create and compare graph snapshots. |
| `architecture` | Analyze package and layer coupling. |
| `scip generate` / `scip import` | Generate or import SCIP reference data. |
| `serve --mcp` | Run the MCP server over stdio for AI coding tools. |
| `install` / `uninstall` | Configure or remove supported tool integrations. |
| `unlock` | Clear a stale `.solidkg/` lock. |

For command-specific options:

```bash
node dist/bin/solidkg.js <command> --help
```

## TypeScript API

SolidKG can also be used as a library after building.

```typescript
import SolidKG from 'solidkg';

const graph = await SolidKG.init('/path/to/project', { index: true });

const matches = graph.searchNodes('UserService');
const impact = graph.getImpactRadius('UserService');
const overview = graph.getOverviewText({ maxDepth: 2, expandPaths: ['src'] });

console.log(matches.length, impact.length, overview);

graph.close();
```

The API covers project initialization, indexing, syncing, symbol search, graph traversal, context building, repository overview projections, snapshots, architecture reports, and SCIP import or generation.

Context, explore, and search results can include `source_body_chunk` ranking evidence when persisted local source-body/code-token chunks seeded or boosted a result. Exact symbol, path, trace, semantic relation, and SCIP evidence remains higher-salience than body-only matches. External embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default.

For quick codebase orientation, use the indexed overview tree instead of scanning directories manually:

```bash
node dist/bin/solidkg.js overview /path/to/project --max-depth 2
node dist/bin/solidkg.js overview /path/to/project --expand src/resolution
node dist/bin/solidkg.js files --path /path/to/project --format overview --max-depth 2
node dist/bin/solidkg.js files --path /path/to/project --format overview --expand src/resolution
```

The overview is derived from `.solidkg/` facts: files, languages, symbol counts, conservative symbol anchors, and any existing architecture assignments. It is not a separate documentation file or scanner.

## Supported file types

- ArkTS
- Astro
- Bash and shell scripts
- C
- C#
- C++
- Dart
- Fortran
- Go
- Groovy
- HCL/Terraform
- Java
- JavaScript and JSX
- Jinja and HTML templates
- Julia
- Kotlin
- Liquid
- Lua
- Luau
- Nix
- Objective-C and Objective-C++
- Pascal/Delphi
- PHP
- PowerShell
- Python
- R
- Razor
- Ruby
- Rust
- Scala
- SCL
- Solidity
- SQL
- Svelte
- Swift
- SystemVerilog
- TypeScript and TSX
- VB.NET
- Vue

## Recognized file types

These are indexed for file-level tracking or framework-specific resolvers, but do not have general symbol extraction:

- Twig
- YAML and XML

Framework-specific resolvers add routes and relationships for Express, Hono, Django, Flask, FastAPI, Rails, Laravel, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, NestJS, and Drupal.

## Development

Requirements:

- Node.js `>=24.0.0 <25.0.0`
- pnpm

Useful commands:

```bash
pnpm run build
pnpm test
pnpm run dev
pnpm run clean
pnpm exec tsc
pnpm exec vitest run __tests__/installer-targets.test.ts
```

`pnpm run build` compiles TypeScript, copies the SQLite schema and tree-sitter WASM assets into `dist/`, strips CLI bin comments, and marks the built CLI as executable.

## Troubleshooting

If the CLI refuses to run, check Node first:

```bash
node --version
```

Use Node 24.

If results look stale:

```bash
node dist/bin/solidkg.js sync /path/to/project
node dist/bin/solidkg.js status /path/to/project
```

If a lock file is stale:

```bash
node dist/bin/solidkg.js unlock /path/to/project
```

On Windows network drives or SMB shares, SQLite locking can fail. Put the data directory on a local disk when indexing a network-mounted source tree.

## License Notices

Third-party license notices are kept in:

- `docs/THIRD_PARTY_LICENSES.md`
- `docs/third-party-licenses/`
