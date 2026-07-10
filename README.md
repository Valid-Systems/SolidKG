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

## Measured results

### SolidKG vs CodeGraph: direct diagnostic

We gave the same codebase questions to the same OpenCode agent (`openai/gpt-5.6-sol`) with SolidKG, CodeGraph, or no graph. Each value below is the median of four runs. **Lower is better; bold marks the better result.**

> **CodeGraph used 59% fewer tool calls and 59% fewer tokens than SolidKG on average. It won both measures on all seven repositories.**

| Codebase | SolidKG tool calls | CodeGraph tool calls | SolidKG tokens | CodeGraph tokens |
|---|---:|---:|---:|---:|
| VS Code | 25 | **11.5** | 295k | **166k** |
| Excalidraw | 13 | **11** | 213k | **100k** |
| Django | 6.5 | **2** | 105k | **46k** |
| Tokio | 4 | **2** | 107k | **47k** |
| OkHttp | 6.5 | **2** | 105k | **45k** |
| Gin | 6 | **2.5** | 89k | **39k** |
| Alamofire | 17.5 | **1** | 237k | **24k** |

Tool calls are agent actions such as graph queries, file reads, and searches. Tokens measure the total model context and output processed during a run.

#### How both graph tools compared with no graph

| Average change vs no graph | Tool calls | Reads | Grep / Glob | Tokens |
|---|---:|---:|---:|---:|
| SolidKG | 48% fewer | 83% fewer | **94% fewer** | 12% more |
| CodeGraph | **80% fewer** | **87% fewer** | 93% fewer | **55% fewer** |

These averages give each repository equal weight after taking its four-run median. A 21-answer source check found the same quality pattern for both graph tools: each had 6 passes, 1 partial answer, and no failed sampled answer. The check covered one answer per repository and arm, not all 84 answers.

This diagnostic measured architecture explanations, not generated-code quality. It did not compare patch correctness, test pass rates, regressions, security, or maintainability.

<details>
<summary><strong>Methodology and caveats</strong></summary>

- 84 successful runs: 7 repositories × 3 arms × 4 repeats.
- Same fresh repository clones, pinned commits, questions, OpenCode 1.17.18 agent, `openai/gpt-5.6-sol` model, permissions, and built-in tools in every arm; only the MCP configuration changed.
- Product builds used `@typescript/native-preview` `7.0.0-dev.20260707.2`.
- 27 of 28 matched three-arm batches overlapped; the first Gin batch ran sequentially. Elapsed time is descriptive only and excluded from the headline.
- OpenCode reported zero per-run cost through the OpenAI subscription path, so this benchmark makes no dollar-cost claim.
- Run variance remained material; the table uses medians. CodeGraph nevertheless used fewer tool calls and tokens than SolidKG on every repository.
- 19 recoverable tool-call errors occurred across 8 completed runs. All 84 runs still produced terminal answers with no top-level error.
- This is directional diagnostic evidence, not a claim-grade or independently reproducible benchmark. Raw run logs and the exact SolidKG benchmark binary were not archived for publication.

See [`docs/benchmarks/opencode-head-to-head-2026-07-10.md`](docs/benchmarks/opencode-head-to-head-2026-07-10.md) for pinned revisions, per-arm medians, direct deltas, and the correctness audit.

</details>

### Prior Claude A/B benchmark

A separate earlier benchmark tested the same seven codebases with Claude Code, comparing SolidKG only against an empty-MCP control. Those results describe that earlier model and harness; they are not directly comparable to the exploratory OpenCode diagnostic above.

> **Average result: 71% fewer tool calls · 46% faster · 57% fewer tokens · 35% lower cost.**

In that earlier Claude harness, SolidKG reached useful answers with fewer discovery calls, accompanied by lower token use and cost. Those savings are historical observations from that model and harness; token savings did not reproduce in the exploratory OpenCode diagnostic above.

| Codebase       | Language / scale        | Time, with → without | Tool calls, with → without | Tokens saved | Cost saved |
| -------------- | ----------------------- | -------------------: | -------------------------: | -----------: | ---------: |
| **VS Code**    | TypeScript · ~10k files |        1m10s → 2m26s |                     8 → 55 |          78% |        26% |
| **Excalidraw** | TypeScript · ~640 files |          48s → 2m58s |                     3 → 79 |          90% |        52% |
| **Django**     | Python · ~3k files      |        1m19s → 1m38s |                     9 → 19 |          36% |        12% |
| **Tokio**      | Rust · ~790 files       |           53s → 3m2s |                     4 → 53 |          86% |        82% |
| **OkHttp**     | Java · ~645 files       |           42s → 1m1s |                     6 → 11 |          13% |         2% |
| **Gin**        | Go · ~110 files         |           44s → 1m0s |                     6 → 10 |          34% |        21% |
| **Alamofire**  | Swift · ~110 files      |        1m17s → 2m27s |                    12 → 69 |          64% |        47% |

<details>
<summary><strong>Methodology and reproducibility</strong></summary>

Each arm ran headlessly with the same query and built-in tools. The SolidKG arm exposed only SolidKG's MCP server; the control used an empty MCP configuration. Wall-clock time and cost are cumulative. Tokens are the sum of per-turn assistant usage, not the final turn's usage object. Per-run variance is real, so the table reports medians rather than a single run.

Reproduce with `scripts/agent-eval/bench-readme.sh`; see [`docs/benchmarks/call-sequence-analysis.md`](docs/benchmarks/call-sequence-analysis.md#current-build-withwithout-ab--the-7-readme-repos-2026-05-24) for queries, raw medians, interpretation, and measurement caveats.

</details>

### Reference-index diagnostics

A separate read-only sweep checks stored graph quality across a broader corpus. It is not a with-vs-without agent benchmark and does not claim universal current-build extraction quality.

| Diagnostic                         |                                                 Result |
| ---------------------------------- | -----------------------------------------------------: |
| Indexed repositories               |                  52 discovered · 51 measured · 1 empty |
| Fair cross-file dependent coverage |      31,143 / 93,784 · 33.2% micro · 42.2% repo median |
| Fair semantic dependent coverage   |      28,319 / 93,784 · 30.2% micro · 39.5% repo median |
| Route-handler linkage              |                                 7,922 / 12,424 · 63.8% |
| Route-binding integrity            |                                  7,218 / 7,923 · 91.1% |
| Current-build direct probes        | 2 / 2 measured · 5 repeats each · 0 expectation misses |

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
| Retrieval evidence  | Answer packets, source-completeness labels, capability footprints, and `source_body_chunk` ranking reasons from persisted local source-body/code-token chunks; exact symbol/path/trace evidence remains higher priority.                                                              |
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

Default indexer commands:

| Language              | Command           |
| --------------------- | ----------------- |
| TypeScript/JavaScript | `scip-typescript` |
| Go                    | `scip-go`         |
| Rust                  | `scip-rust`       |
| Python                | `scip-python`     |
| C#                    | `scip-dotnet`     |

If an indexer is missing or no SCIP file is imported, the AST graph still works.

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

On Windows network drives or SMB shares, put `--data-dir` on a local disk to avoid SQLite locking issues.

## License notices

Third-party notices are kept in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md) and [`docs/third-party-licenses/`](docs/third-party-licenses/).
