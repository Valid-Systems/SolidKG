---
title: Getting Started
description: Start using SolidKG, then inspect its implementation and measured research inventory.
---

SolidKG combines static parsing, graph storage, reference resolution, semantic modeling, compiler indexes, and agent protocols into one local code-intelligence system. This page records the technologies and evaluation corpus behind that system so future research can trace claims back to implementation evidence.

## Start here

1. [Install SolidKG](/solidkg/getting-started/installation/) and configure a supported coding agent.
2. [Build your first graph](/solidkg/getting-started/your-first-graph/) and ask a structural question through the compact `solidkg_explore` MCP surface.
3. Read the implementation and measured-research inventory below when evaluating or extending the system.

<span id="research-inventory-page" aria-hidden="true"></span>

:::note[Research snapshot: 2026-07-10]
The available external inventory contained **118 repository directories**. The reference-quality baseline found **52 SolidKG indexes**, of which **51 produced measurable results** and one was empty. The remaining 66 directories are presence records only, not measured or validated repositories.
:::

## System at a glance

```text
source files
    ↓
tree-sitter + standalone format extractors
    ↓
SQLite graph: files, symbols, edges, semantic hyperedges, source chunks
    ↓
import/name/framework resolution + dynamic-dispatch synthesis + optional SCIP
    ↓
graph traversal, trace, impact, architecture, snapshots, context building
    ↓
MCP server, CLI, TypeScript API, and coding-agent integrations
```

## Integrated technology map

On narrow screens, scroll tables horizontally to view every column.

| Area | Integrated technologies | Role in SolidKG |
|---|---|---|
| Runtime and implementation | TypeScript, Node.js 24, ESM/CommonJS package exports, pnpm | Implements the library, CLI, MCP server, installer, workers, and release build. |
| Parsing | tree-sitter, `@xberg-io/tree-sitter-language-pack`, per-platform native grammar libraries | Parses supported languages into deterministic ASTs without sending source to an LLM. Heavy parsing runs in worker threads. |
| Hybrid and standalone extraction | Dedicated Svelte, Vue, Liquid, and Delphi-form extractors; static Razor and Jinja/HTML template handling | Covers hybrid or nonstandard formats that need more than a normal tree-sitter language adapter. |
| Storage and search | Node's built-in `node:sqlite`, SQLite, FTS5, WAL mode, prepared statements, schema migrations | Stores files, symbols, pairwise edges, semantic hyperedges, source-body chunks, snapshots, architecture reports, and optional SCIP facts locally. |
| Graph and hypergraph analysis | Directed edges, ordered semantic hyperedges, BFS/DFS traversal, path finding, impact radius, Ca/Ce/instability metrics | Preserves direct relationships and multi-symbol structures such as route chains, event channels, UI render paths, native bridges, and type contracts. |
| Resolution and synthesis | Import resolver, tsconfig path aliases, Cargo workspace members, name matching, callback synthesis, framework resolvers | Connects extracted names across files and bridges validated dynamic-dispatch boundaries that plain AST calls miss. |
| Compiler-grade references | SCIP, `@sourcegraph/scip-typescript`, `@c4312/scip`, Protocol Buffers via `@bufbuild/protobuf` | Adds definitions, references, implementations, and type-definition relationships when a SCIP index is generated or imported. |
| Agent protocol | Model Context Protocol over stdio, bounded tool execution, local daemon IPC | Exposes search, context, trace, callers, callees, impact, repository overview, snapshots, architecture, and precise-reference tools to coding agents. |
| Agent integrations | Claude Code, Cursor, Codex CLI, OpenCode, Hermes Agent, Antigravity, OMP/Pi, Kimi Code; manual MCP setup for other hosts | Installs reversible MCP configuration and provider-neutral usage instructions while preserving sibling settings and comments where formats allow it. |
| Configuration and file selection | Commander, `jsonc-parser`, TOML serialization, `ignore`, `picomatch` | Powers the CLI, surgical JSONC/TOML installer edits, ignore rules, path matching, and source-file filtering. |
| Synchronization | Chokidar/native OS events, FSEvents, inotify, ReadDirectoryChangesW, debounce, incremental sync, Git hooks | Keeps the graph current while files change without rescanning the entire repository. |
| Evaluation | Vitest, real SQLite integration tests, OpenCode and Claude agent harnesses, reference-quality baselines, TypeScript 7 native-preview comparison builds | Tests extraction, resolution, storage, retrieval sufficiency, installer behavior, agent effort, and cross-repository graph quality. |
| Documentation and distribution | Astro, Starlight, Vite, Pagefind, Sharp, Fontsource, GitHub Actions, per-platform Node bundles, npm shim packages | Publishes documentation and ships reproducible platform bundles without requiring users to supply the development toolchain. |

## Language and framework coverage

The current language reference documents **40 language or template families**, including TypeScript/JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C/C++, Swift, Kotlin, Groovy, VB.NET, Scala, Dart, Svelte, Vue, Astro, Liquid, Jinja/HTML, Razor, Pascal/Delphi, Lua/Luau, Verilog/SystemVerilog, Julia, Fortran, R, HCL/Terraform, Nix, Bash, PowerShell, SQL, ArkTS, PLC SCL, and Solidity.

Framework-aware resolution covers representative patterns from Express and Hono; Django/DRF, Flask, and FastAPI; Rails and Laravel; Spring, OpenFeign, and MyBatis; Gin; Axum, actix, and Rocket; ASP.NET/Razor; Vapor; React/React Router; Vue/Nuxt; Svelte/SvelteKit; NestJS; Drupal; React Native; and Expo Modules.

See [Languages](/solidkg/reference/languages/) and [Resolution & Frameworks](/solidkg/core-concepts/resolution/) for exact syntax boundaries and unsupported runtime behavior.

## Successfully measured reference repositories

The table below lists every repository that produced a measurable row in the 2026-07-10 reference-quality baseline. “Cross-file coverage” is file-level: the share of eligible files containing declarations for which another file has at least one qualifying dependent edge. It measures stored graph structure, not declaration coverage or universal semantic correctness.

<details>
<summary><strong>Show all 51 measured repositories</strong></summary>

On narrow screens, scroll horizontally after opening the table.

| Local directory | Project | Indexed files | Cross-file coverage |
|---|---|---:|---:|
| `angular__angular` | angular/angular | 2,230 | 65.6% |
| `ansible` | Ansible | 4,317 | 27.9% |
| `ansible__awx` | ansible/awx | 1,202 | 24.2% |
| `apache__airflow` | apache/airflow | 8,772 | 41.1% |
| `apple__swift-nio` | apple/swift-nio | 657 | 59.5% |
| `Azure__azure-powershell` | Azure/azure-powershell | 6,029 | 0.0% |
| `BurntSushi__ripgrep` | BurntSushi/ripgrep | 104 | 57.3% |
| `dart-lang__pub` | dart-lang/pub | 509 | 30.1% |
| `dbt-labs__dbt-core` | dbt-labs/dbt-core | 770 | 32.7% |
| `django__django` | django/django | 3,331 | 34.4% |
| `electron__electron` | electron/electron | 1,831 | 51.0% |
| `etcd-io__etcd` | etcd-io/etcd | 1,139 | 48.3% |
| `ethereum__solidity` | ethereum/solidity | 8,422 | 10.6% |
| `facebook__react` | facebook/react | 591 | 52.3% |
| `hashicorp__consul` | hashicorp/consul | 2,909 | 52.2% |
| `hashicorp__nomad` | hashicorp/nomad | 3,499 | 39.4% |
| `hashicorp__terraform` | hashicorp/terraform | 4,167 | 31.0% |
| `hashicorp__vault` | hashicorp/vault | 4,911 | 42.2% |
| `Homebrew__brew` | Homebrew/brew | 1,778 | 47.6% |
| `jekyll__jekyll` | jekyll/jekyll | 285 | 52.9% |
| `julia` | Julia local checkout | 1,210 | 54.7% |
| `JuliaLang__julia` | JuliaLang/julia | 1,200 | 54.8% |
| `laravel__framework` | laravel/framework | 2,797 | 53.4% |
| `mastodon__mastodon` | mastodon/mastodon | 4,603 | 46.7% |
| `moby__moby` | moby/moby | 2,219 | 48.9% |
| `numpy__numpy` | numpy/numpy | 1,082 | 43.2% |
| `nuxt__nuxt` | nuxt/nuxt | 607 | 9.6% |
| `pallets__flask` | pallets/flask | 107 | 45.5% |
| `pallets__jinja` | pallets/jinja | 68 | 42.4% |
| `pandas-dev__pandas` | pandas-dev/pandas | 1,664 | 26.3% |
| `pointfreeco__swift-composable-architecture` | pointfreeco/swift-composable-architecture | 798 | 26.2% |
| `PowerShell__PowerShell` | PowerShell/PowerShell | 1,932 | 60.7% |
| `prometheus` | Prometheus | 1,334 | 62.6% |
| `rails__rails` | rails/rails | 3,674 | 50.2% |
| `Roblox__luau` | Roblox/luau | 847 | 55.3% |
| `rust-lang__cargo` | rust-lang/cargo | 1,198 | 26.0% |
| `saltstack__salt` | saltstack/salt | 3,002 | 24.3% |
| `scikit-learn__scikit-learn` | scikit-learn/scikit-learn | 1,072 | 40.6% |
| `serde-rs__serde` | serde-rs/serde | 208 | 20.9% |
| `Shopify__dawn` | Shopify/dawn | 126 | 37.4% |
| `Shopify__liquid` | Shopify/liquid | 194 | 32.9% |
| `sveltejs__kit` | sveltejs/kit | 11 | 20.0% |
| `sveltejs__svelte` | sveltejs/svelte | 41 | 34.5% |
| `swiftlang__swift-package-manager` | swiftlang/swift-package-manager | 1,733 | 49.6% |
| `tauri-apps__tauri` | tauri-apps/tauri | 474 | 50.9% |
| `terraform` | Terraform local checkout | 4,245 | 31.0% |
| `tokio-rs__tokio` | tokio-rs/tokio | 775 | 46.8% |
| `vercel__next.js` | vercel/next.js | 18,743 | 18.8% |
| `vuejs__core` | vuejs/core | 70 | 47.9% |
| `withastro__astro` | withastro/astro | 235 | 30.4% |
| `WordPress__wordpress-develop` | WordPress/wordpress-develop | 3,760 | 36.1% |

</details>

The remaining repository directories were available to the external snapshot but did not have a measurable index row. Their presence is recorded in `docs/tested-codebases.md`; it is not evidence that those repositories were indexed, validated, or stress-tested.

## Validation scope

| Question | Maintainer-reported work | Important limitation |
|---|---|---|
| Can one local graph represent many languages and frameworks? | Language adapters, framework resolvers, and 51 measured reference indexes within a larger 118-directory availability inventory | Presence and extraction coverage do not prove runtime equivalence. |
| Do semantic hyperedges and synthesis recover relationships missed by direct AST calls? | Route, event, UI-render, dynamic-dispatch, native-bridge, and type-contract fixtures plus real-repository playbooks | Synthesized edges are heuristic and must retain provenance. |
| Does graph retrieval reduce agent rediscovery work? | OpenAI/OpenCode comparison chart, tool-call logs, and reference-quality probes | Results are reported with model, repository, repeat-count, and harness scope. |
| Does graph context improve generated-code quality? | Not yet measured | Requires matched implementation tasks, executable hidden tests, regression and security checks, diff-quality measures, and blinded patch review. |
| Can compiler facts complement parser facts? | Optional SCIP generation/import, node linking, precise-reference tools, and status metrics | SCIP coverage depends on external indexers and language support. |
| Can the system remain local-first and reproducible? | SQLite storage, deterministic AST extraction, hashed diagnostic manifests, benchmark-specific revisions where recorded, and per-platform bundles | Baseline source revisions are not frozen, and an MCP host may send returned snippets to its configured model provider. |

## Public validation material

The initial public release includes the capability/frontier record, tested-codebase list, and dynamic-dispatch validation method. Benchmark reports, raw trajectories, evidence bundles, and paper-preparation material are intentionally omitted until the maintainers are ready to publish and defend them. Treat the reported numbers as maintainer claims, not a reproducible paper artifact bundle.
