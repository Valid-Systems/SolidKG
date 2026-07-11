# SolidKG

<p align="center">
  <img width="500" alt="solidkg" src="https://github.com/user-attachments/assets/6c138932-b594-4dd2-8393-62197bc057de" />
</p>

SolidKG turns a source repository into a local SQLite knowledge graph for AI coding agents, CLI workflows, and other tools. It stores deterministic AST-derived facts: files, symbols, calls, imports, references, semantic hyperedges, source snippets, and optional SCIP precise-reference data.

It is inspired by [Codegraph](https://github.com/colbymchenry/codegraph), [Sverklo](https://github.com/sverklo/sverklo), [Tilth](https://github.com/jahala/tilth), and [Cartog](https://github.com/jrollin/cartog).

## Why use it

SolidKG is a local-first code knowledge graph designed for structural questions from coding agents. Agents often spend many turns rediscovering structure with `Read`, `Grep`, and shell searches. SolidKG gives them fine-tuned graph tools that answer structural questions directly:

- where a symbol is defined
- what calls or is called by a symbol
- how one function reaches another through direct calls, framework routes, callbacks, UI render paths, or dynamic dispatch
- what code may be affected by a change
- what files, packages, and layers exist in a repository

Indexing and retrieval run locally by default. External dense/vector embeddings, vector databases, rerankers, API calls, telemetry, and hybrid retrieval providers are not enabled by default. MCP clients can still send source returned by SolidKG to their configured model provider; use a local model or review that provider's data policy when source must remain on-device.

## Related tools

This is a feature-scope comparison, not a universal ranking. It was verified on 2026-07-11 against the linked official snapshots. "Not documented" means the reviewed official sources did not document the capability. It does not prove that a future release lacks it. The Cartog and Tilth rows below describe product scope only, not results from benchmark-corpus repositories.

| Product | Documented focus and storage | Graph navigation | Dynamic dispatch | Semantic hyperedges | SCIP or compiler references | Local semantic or vector behavior |
|---|---|---|---|---|---|---|
| [SolidKG](#feature-map) | Per-project SQLite AST graph with ordered semantic hyperedges | Callers, callees, impact, and trace | Synthesized callback, render, and native bridges | Ordered semantic hyperedges | Optional SCIP | Local FTS and source chunks; external vectors disabled by default |
| [CodeGraph](https://github.com/colbymchenry/codegraph/tree/ecc8b307ac2f8a7d06bff02ee513c4ea2380b2f8) | Per-project SQLite/FTS AST graph | Callers, callees, impact, and explore | Documented synthesized dispatch | Not documented | No official hyperedge or SCIP documentation found | Local FTS documented; vector behavior not documented |
| [Sverklo](https://github.com/sverklo/sverklo/tree/3156effb9c25147edf7a310e1998f8fd18ee007f) | SQLite and sqlite-vec local semantic search, memory, import/dependency graph, and impact | Import/dependency graph and impact | No dedicated trace documentation found | Not documented | No dedicated SCIP documentation found | sqlite-vec local semantic search; offline after model download |
| [Cartog](https://github.com/jrollin/cartog/tree/61fd98379e8240455856f167c1ce333f17297bb8) | SQLite tree-sitter graph with incremental Git, SHA, and Merkle indexing | Callers, callees, impact, and static trace | Explicitly unresolved | Not documented | No hyperedge or SCIP documentation found | Optional sqlite-vec and LSP |
| [Tilth](https://github.com/jahala/tilth/tree/e7ef4647e0f8778491e3327e05c98260ff1b2d05) | tree-sitter and ripgrep local code reading and search | Outline, callers, one-hop callees, and file dependencies | Indirect dispatch unresolved | Not documented | No persistent graph DB, impact, hyperedge, or SCIP documentation found | Local text and structural search; vector behavior not documented |

## Measured results

### SolidKG vs CodeGraph: matched OpenCode comparison

The latest OpenAI-only comparison used OpenCode with `openai/gpt-5.6-sol`, the same seven repositories and architecture questions for both products, current local builds, and four successful repeats per repository/product cell. Lower is better.

| Equal-repository aggregate | SolidKG relative to CodeGraph |
|---|---:|
| Tool calls | 16.7% lower |
| Tokens | 15.9% lower |
| Read / Grep / Glob | 0 median for both products in all 7 repositories |

| Codebase | SolidKG calls | CodeGraph calls | SolidKG tokens | CodeGraph tokens |
|---|---:|---:|---:|---:|
| VS Code | **1** | 3 | **25,063** | 67,542 |
| Excalidraw | 2 | 2 | 47,471 | **46,515** |
| Django | 2 | 2 | 47,061 | **45,625** |
| Tokio | 2 | 2 | 48,094 | **47,935** |
| OkHttp | **1** | 2 | **25,132** | 45,875 |
| Gin | 1 | 1 | **22,478** | 23,965 |
| Alamofire | 1 | 1 | **22,689** | 23,333 |

Tool calls include graph queries and built-in file/search actions. Tokens sum every assistant step's input, cache, reasoning, and output usage.

Scope: 56 successful runs, seven repositories × two products × four repeats. All runs cited source files; 54/56 matched every expected mechanism, and no completed run contained a recoverable tool error. Elapsed time is not compared because cells ran concurrently on a busy host. Generated-code quality and patch correctness are outside this architecture-explanation benchmark.

See [`docs/benchmarks/opencode-head-to-head-2026-07-10.md`](docs/benchmarks/opencode-head-to-head-2026-07-10.md) for repository-level medians, methodology, validity checks, variance, and the historical pre-fix matrix.

### Expanded matched corpus

A separate July 11 local comparison added Cartog, Tilth, Azure PowerShell, and Apache Airflow. It used `openai/gpt-5.6-sol` with four repeats per repository/product cell. Lower is better.

| Equal-repository reduction for SolidKG | Result |
|---|---:|
| Tool calls | 34.6% |
| Read calls | 24.0% |
| Grep calls | 77.8% |
| Glob calls | 100.0% |
| Graph calls | 12.5% |
| Tokens | 34.7% |

All 32 planned runs completed with zero tool errors and source-file citations in all 32 answers. The mechanism screen completed 31/32 checks, and a separate audit passed all eight median-representative answers. One non-representative Cartog/SolidKG run was partial because it omitted the Git-diff stage.

Cartog and Tilth used recorded pinned commits. Azure PowerShell and Apache Airflow were unversioned local snapshots, so this is not an independent-reproduction or claim-grade result for those rows. The 3.3% wall-clock reduction is omitted here because concurrent subscription-host timing is descriptive rather than a controlled speed measure.

See [`docs/benchmarks/opencode-expanded-head-to-head-2026-07-11.md`](docs/benchmarks/opencode-expanded-head-to-head-2026-07-11.md) and its [versioned compact evidence JSON](docs/benchmarks/evidence/opencode-expanded-2026-07-11.json) for repository medians, ranges, provenance, answer checks, and scope limits.

### Reference-index diagnostics

A separate read-only sweep checks stored graph quality across a broader corpus. It is not a with-vs-without agent benchmark and does not claim universal current-build extraction quality.

| Diagnostic                         |                                                 Result |
| ---------------------------------- | -----------------------------------------------------: |
| Indexed repositories               |                  52 discovered · 51 measured · 1 empty |
| Fair cross-file dependent coverage |      31,143 / 93,784 · 33.2% micro · 42.2% repo median |
| Fair semantic dependent coverage   |      28,319 / 93,784 · 30.2% micro · 39.5% repo median |
| Route-handler linkage              |                                 7,922 / 12,424 · 63.8% |
| Route-binding integrity            |                                  7,218 / 7,923 · 91.1% |
| Source-chunk attachment            |                              95,420 / 137,352 · 69.5% |
| SCIP document coverage             |                                6,824 / 117,482 · 5.8% |
| SCIP linked-node coverage          |                            25,506 / 1,122,980 · 2.3% |
| Capability-producer completeness  |                              85,963 / 117,482 · 73.2% |
| Graded default-surface probes      | 6 probes · 5 repeats each · 4 required-source hits · 2 calibrated abstentions · 100% useful-source recall where labeled · 0 misleading-source intrusions |
| Integrity burden                   |             0 file errors · 0 dangling edges · 0 duplicate repositories |

The graded probes include long, terse, and counterfactual forms on Airflow and Azure PowerShell. The four ordinary prompts returned their required production file. The two counterfactual prompts did not recover the required file, but now return a partial `missing_query_concept` packet rather than falsely claiming sufficiency. Across the six paired probes, median payload fell from 32,750 to 31,148 bytes (4.9%); this is a direct tool-output diagnostic, not an agent-task benchmark.

See [`docs/benchmarks/research-integration-2026-07-10.md`](docs/benchmarks/research-integration-2026-07-10.md) for the research-to-implementation presentation, before/after interpretation, graph-invariance evidence, and remaining retrieval gap.

Full definitions, per-language results, provenance, availability states, and repository rows are in [`docs/benchmarks/reference-quality-baseline.md`](docs/benchmarks/reference-quality-baseline.md). The methodology and claim boundary are in [`docs/benchmarks/reference-quality-sweep.md`](docs/benchmarks/reference-quality-sweep.md).

## Quick start

Install the published CLI:

```bash
npm install -g solidkg
solidkg --help
```

Index a project and ask for graph context:

```bash
solidkg init -i /path/to/project
solidkg status /path/to/project
solidkg context "how does auth work?" --path /path/to/project
```

Configure supported coding agents:

```bash
solidkg install
```

The default MCP profile exposes only `solidkg_explore`. Give it a natural-language structural question or precise symbol/file terms; it returns ranked production source and graph evidence in one answer-producing call. Advanced tools remain available through an explicit full profile:

```bash
SOLIDKG_MCP_TOOLS=all solidkg serve --mcp
```

Supported installer targets: Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, and Kimi Code.

Keep the index outside the source tree when needed:

```bash
solidkg init -i --data-dir /local/solidkg-data/project-a /path/to/project
```

## Feature map

| Area                | What SolidKG provides                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local graph         | SQLite storage for files, symbols, edges, semantic hyperedges, source chunks, snapshots, architecture reports, and optional SCIP facts.                                                                                                                                               |
| MCP tools           | The compact/default MCP profile exposes only answer-producing `solidkg_explore`. `SOLIDKG_MCP_TOOLS=all` restores `solidkg_search`, `solidkg_context`, `solidkg_trace`, `solidkg_node`, `solidkg_callers`, `solidkg_callees`, `solidkg_impact`, `solidkg_files`, `solidkg_status`, `solidkg_snapshot`, `solidkg_architecture`, and `solidkg_precise_refs` when SCIP data is present. |
| CLI                 | Project init/index/sync/status, repository overview, symbol queries, context, callers/callees, impact, affected-test discovery, snapshots, architecture rollups, SCIP generate/import, MCP server, install/uninstall, and stale-lock recovery.                                        |
| TypeScript API      | Initialize/open projects, index/sync/watch, search nodes, traverse callers/callees/impact, build context, render overviews, inspect hyperedges, manage snapshots, analyze architecture, and import/generate SCIP.                                                                     |
| Agent install       | Idempotent MCP configuration and provider-neutral instructions for supported agents, preserving existing comments and sibling config where formats allow it.                                                                                                                          |
| Flow coverage       | Static calls plus validated framework/dynamic-dispatch links for routes, event channels, UI render chains, callbacks, native bridges, and type contracts.                                                                                                                             |
| Retrieval evidence  | Answer packets, source-completeness labels, capability footprints, counterfactual concept coverage, and `source_body_chunk` ranking reasons from persisted local source-body/code-token chunks; exact symbol/path/trace evidence remains higher priority. Explicit exclusions are constraints, and uncovered concepts produce a partial `missing_query_concept` packet. |
| Local-first posture | No network retrieval, embeddings, reranking services, API keys, or telemetry in the default graph/query path.                                                                                                                                                                         |

Static analysis still has limits. Generated code, reflection-heavy systems, anonymous closures outside validated patterns, and runtime-only dispatch can still require direct source inspection.

## Common commands

```bash
solidkg init -i [path]                 # initialize and index
solidkg index [path]                  # full graph rebuild
solidkg sync [path]                   # incremental update after edits
solidkg status [path]                 # index health, counts, SCIP state
solidkg files --format overview --path [path]
solidkg overview [path]
solidkg query "UserService" --path [path]
solidkg context "task" --path [path]
solidkg callers UserService --path [path]
solidkg callees UserService --path [path]
solidkg impact UserService --path [path]
solidkg affected src/foo.ts --path [path]
solidkg snapshot create before-refactor --path [path]
solidkg architecture analyze --path [path]
solidkg scip generate --path [path]
solidkg scip import index.scip --path [path]
solidkg serve --mcp
solidkg unlock [path]
```

Run `solidkg <command> --help` for command-specific options.

## TypeScript API

```typescript
import SolidKG from "solidkg";

const graph = await SolidKG.init("/path/to/project", { index: true });

const matches = graph.searchNodes("UserService");
const impact = graph.getImpactRadius("UserService");
const overview = graph.getOverviewText({ maxDepth: 2, expandPaths: ["src"] });

console.log(matches.length, impact.length, overview);

graph.close();
```

The API covers the same core surfaces as the CLI/MCP server: indexing, syncing, graph traversal, context building, overview projection, hyperedges, snapshots, architecture reports, and SCIP import/generation.

## SCIP support

SCIP data is optional and additive. SolidKG can generate or import `.scip` indexes, link SCIP symbols back to graph nodes, and expose compiler-grade definitions, references, implementations, and type-definition relationships when the data exists.

The low SCIP percentages in the reference-index diagnostic describe **data availability in a mixed historical corpus**, not a failed integration. Most stored indexes were created before SCIP was generated/imported for them or on machines without the matching external indexer. Normal AST indexing remains complete without SCIP.

Default indexer commands:

| Language              | Command           |
| --------------------- | ----------------- |
| TypeScript/JavaScript | `scip-typescript` |
| Go                    | `scip-go`         |
| Rust                  | `scip-rust`       |
| Python                | `scip-python`     |
| C#                    | `scip-dotnet`     |

If an indexer is missing or no SCIP file is imported, the AST graph still works.

- `solidkg init -i` uses SCIP `auto`: it imports generated data when a supported indexer is installed and otherwise continues with the AST graph.
- `solidkg index` and the library `indexAll()` default to SCIP `off`; pass `--scip auto` to opt in or `--scip required` to fail when generation is unavailable.
- `solidkg scip generate`, `solidkg scip import`, `solidkg status`, and `solidkg_precise_refs` provide explicit generation, import, health, and query surfaces.

The remaining SCIP work is measurement and coverage, not basic plumbing: rebuild a pinned corpus with the current build and installed indexers, then improve symbol-to-AST linking only where that fresh run still reports low linked-node coverage.

## Supported code

SolidKG extracts symbols for ArkTS, Astro, Bash, C/C++, C#, Dart, Fortran, Go, Groovy, HCL/Terraform, Java, JavaScript/JSX, Jinja/HTML, Julia, Kotlin, Liquid, Lua/Luau, Nix, Objective-C/C++, Pascal/Delphi, PHP, PowerShell, Python, R, Razor, Ruby, Rust, Scala, SCL, Solidity, SQL, Svelte, Swift, SystemVerilog, TypeScript/TSX, VB.NET, and Vue.

It also tracks Twig, YAML, and XML at file/framework level. Framework resolvers add routes and relationships for Express, Hono, Django, Flask, FastAPI, Rails, Laravel, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, NestJS, and Drupal.

Capability notes, measured benchmark summaries, validated repositories, and known frontiers live in:

- [`docs/code-intelligence-capabilities.md`](docs/code-intelligence-capabilities.md)
- [`docs/tested-codebases.md`](docs/tested-codebases.md)
- [`docs/benchmarks/`](docs/benchmarks/)
- [`docs/design/dynamic-dispatch-coverage-playbook.md`](docs/design/dynamic-dispatch-coverage-playbook.md)

## Development

Requirements:

- Node.js `>=24.0.0 <25.0.0`
- pnpm

From source:

```bash
pnpm install
pnpm run build
node dist/bin/solidkg.js --help
```

Useful checks:

```bash
pnpm exec tsc
pnpm test
pnpm exec vitest run __tests__/installer-targets.test.ts
```

`pnpm run build` compiles TypeScript, copies `src/db/schema.sql` and tree-sitter WASM assets into `dist/`, strips CLI bin comments, and marks the built CLI executable.

Published installs use small npm launcher packages plus per-platform release bundles. The bundles include Node 24, the compiled app, schema files, tree-sitter WASM grammars, and production dependencies.

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

If indexing stops or appears stalled, inspect the lifecycle diagnostic in the index data directory:

```text
<data-dir>/index-lifecycle.json
```

`index` and the initial index run by `init -i` update this record through a random exclusive temporary file followed by atomic replacement. Phase, detail, completion, and terminal success or failure are persisted immediately. Counts during a running index are periodically checkpointed, with an intended lag of at most about two seconds, so they reflect the latest checkpoint rather than the instant you inspect the file. Where POSIX modes apply, it is owner-only. It can include absolute paths and stack traces, so treat it as sensitive diagnostic output and review it before sharing.

On Windows network drives or SMB shares, put `--data-dir` on a local disk to avoid SQLite locking issues.

## License notices

Third-party notices are kept in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md) and [`docs/third-party-licenses/`](docs/third-party-licenses/).
