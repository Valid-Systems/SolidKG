# SolidKG

<p align="center">
  <img width="500" alt="solidkg" src="https://github.com/user-attachments/assets/6c138932-b594-4dd2-8393-62197bc057de" />
</p>

SolidKG is a local-first code intelligence graph for AI coding agents. It parses a project with tree-sitter, stores symbols/edges/hyperedges in SQLite, and exposes fast structural tools over CLI and MCP.

It is inspired by [Codegraph](https://github.com/colbymchenry/codegraph), [Sverklo](https://github.com/sverklo/sverklo), [Tilth](https://github.com/jahala/tilth), and [Cartog](https://github.com/jrollin/cartog).

## Install

From source:

```bash
pnpm install
pnpm run build
node dist/bin/solidkg.js --help
```

Published installs use the bundled release packages:

```bash
npm install -g solidkg
solidkg --help
```

The npm package is a small launcher plus per-platform bundles. Release bundles include Node 24, the compiled app, schema files, tree-sitter WASM grammars, and production dependencies.

## Use on a project

```bash
solidkg init -i /path/to/project
solidkg status /path/to/project
solidkg context "how does auth work?" --path /path/to/project
```

Keep the index outside the source tree when needed:

```bash
solidkg init -i --data-dir /local/solidkg-data/project-a /path/to/project
```

Configure an agent:

```bash
solidkg install
```

Supported installer targets include Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP, and Kimi.

## What agents get

- Symbol search, callers/callees, impact, trace, focused context, and repository overview tools.
- Semantic hyperedges for multi-symbol relationships such as routes, event channels, UI render chains, dynamic dispatch, native bridges, and type contracts.
- Optional SCIP import/generation for compiler-grade definitions, references, implementations, and type-definition links.
- Source-body chunk retrieval for better natural-language queries while keeping exact symbol/path/trace evidence higher priority.
- Local-only operation by default. Embeddings, vector databases, rerankers, API calls, and telemetry are not enabled.

Static analysis still has limits. Generated code, reflection-heavy systems, and unusual framework conventions may require direct source inspection.

## Common commands

```bash
solidkg init -i [path]          # initialize and index
solidkg index [path]           # rebuild the graph
solidkg sync [path]            # update after file changes
solidkg status [path]          # index health and counts
solidkg files --format overview --path [path]
solidkg overview [path]
solidkg query "UserService" --path [path]
solidkg context "task" --path [path]
solidkg callers A --path [path]
solidkg callees A --path [path]
solidkg impact A --path [path]
solidkg affected src/foo.ts --path [path]
solidkg scip generate [path]
solidkg scip import index.scip --path [path]
solidkg serve --mcp
```

Run `solidkg <command> --help` for command-specific options.

## TypeScript API

```typescript
import SolidKG from 'solidkg';

const graph = await SolidKG.init('/path/to/project', { index: true });

const matches = graph.searchNodes('UserService');
const impact = graph.getImpactRadius('UserService');
const overview = graph.getOverviewText({ maxDepth: 2, expandPaths: ['src'] });

console.log(matches.length, impact.length, overview);

graph.close();
```

The library API covers initialization, indexing, syncing, symbol search, graph traversal, context building, overview projection, snapshots, architecture reports, and SCIP import/generation.

## SCIP support

SolidKG can import `.scip` files and link SCIP symbols back to graph nodes. It can also orchestrate SCIP generation when matching indexer commands are available.

Default indexer commands:

| Language | Command |
| --- | --- |
| TypeScript/JavaScript | `scip-typescript` |
| Go | `scip-go` |
| Rust | `scip-rust` |
| Python | `scip-python` |
| C# | `scip-dotnet` |

SCIP is additive: if no index exists or an indexer is missing, the AST graph still works.

## Supported code

SolidKG extracts symbols for ArkTS, Astro, Bash, C/C++, C#, Dart, Fortran, Go, Groovy, HCL/Terraform, Java, JavaScript/JSX, Jinja/HTML, Julia, Kotlin, Liquid, Lua/Luau, Nix, Objective-C/C++, Pascal/Delphi, PHP, PowerShell, Python, R, Razor, Ruby, Rust, Scala, SCL, Solidity, SQL, Svelte, Swift, SystemVerilog, TypeScript/TSX, VB.NET, and Vue.

It also tracks Twig, YAML, and XML at file/framework level. Framework resolvers add routes and relationships for Express, Hono, Django, Flask, FastAPI, Rails, Laravel, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, NestJS, and Drupal.

Capability notes, benchmark summaries, validated repositories, and known frontiers live in [`docs/code-intelligence-capabilities.md`](docs/code-intelligence-capabilities.md) and [`docs/tested-codebases.md`](docs/tested-codebases.md).

## Development

Requirements:

- Node.js `>=24.0.0 <25.0.0`
- pnpm

Useful commands:

```bash
pnpm run build
pnpm test
pnpm exec tsc
pnpm run dev
pnpm run clean
pnpm exec vitest run __tests__/installer-targets.test.ts
```

`pnpm run build` compiles TypeScript, copies `src/db/schema.sql` and tree-sitter WASM assets into `dist/`, strips CLI bin comments, and marks the built CLI executable.

## Troubleshooting

Use Node 24 for source installs:

```bash
node --version
```

If results look stale:

```bash
solidkg sync /path/to/project
solidkg status /path/to/project
```

If a lock file is stale:

```bash
solidkg unlock /path/to/project
```

On Windows network drives or SMB shares, put `--data-dir` on a local disk to avoid SQLite locking issues.

## License notices

Third-party notices are kept in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md) and [`docs/third-party-licenses/`](docs/third-party-licenses/).
