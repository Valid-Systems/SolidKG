# SolidKG

<p align="center">
  <img width="360" alt="SolidKG code intelligence graph for AI coding agents" src="assets/logo.png" />
</p>

<p align="center"><strong>The best static intelligence for agents*.</strong></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-solidkg">Why SolidKG</a> ·
  <a href="#benchmark-results">Benchmarks</a> ·
  <a href="docs/code-intelligence-capabilities.md">Capabilities</a>
</p>

## Why SolidKG

Coding agents are good at reasoning once they have the right context. Finding that requires fine-tuned automated assistance.

Tested error-free on 112 of the largest and most impactful OSS codebases, SolidKG indexes a project once, keeps it in sync, and gives agents an optimized structural view.

- **Follow real flows.** Trace callers, routes, callbacks, UI render chains, framework conventions, and cross-language bridges.
- **Return evidence, not summaries.** Results include verbatim source, graph relationships, provenance, and explicit uncertainty when static analysis cannot prove a path.
- **Understand change risk.** Query callers, callees, impact radius, affected tests, snapshots, package boundaries, layer coupling, deterministic architecture health, and snapshot health drift.
- **Stay local.** SQLite, tree-sitter, and optional SCIP run on your machine. No source uploads, embeddings, vector database, API keys, or telemetry are required.

## Quick start

Published packages bundle the Node.js 24 runtime SolidKG executes on, so you do not need Node.js 24 installed separately.

> **Agent-led setup:** For a first installation, give [`docs/setup.md`](docs/setup.md) to your coding agent. It guides the agent through read-only preflight, approved configuration changes, project indexing, and a real `solidkg_explore` acceptance check.

```bash
npm install -g solidkg
solidkg install
solidkg init -i .
solidkg status .
```

[Standalone GitHub Release bundles](https://github.com/Valid-Systems/SolidKG/releases) also include the runtime and require no separately installed Node.js, npm, or build tools.

Then ask your coding agent a normal question:

> How does authentication work in this project?

The default MCP profile exposes one answer-producing tool, `solidkg_explore`, so the agent can send the question it already has and receive ranked source plus structural evidence in one response.

Prefer the CLI?

```bash
solidkg context "how does authentication work?" --path .
solidkg callers UserService --path .
solidkg impact UserService --path .
solidkg affected src/auth.ts --path .
```

## What SolidKG understands

SolidKG stores deterministic facts derived from source, not LLM-generated descriptions:

```text
source files
    ↓ tree-sitter extraction
symbols + calls + imports + references
    ↓ framework and dynamic-dispatch resolution
routes + callbacks + render chains + semantic hyperedges
    ↓ optional SCIP linking
compiler-grade definitions + references + implementations
    ↓ query surfaces
MCP + CLI + TypeScript API
```

Today that covers **43 language/source modes** and **25 framework/runtime resolvers**:

| Ecosystem | Language/source modes | Framework/runtime resolvers |
|---|---|---|
| Web and JavaScript | TypeScript, JavaScript, TSX, JSX, Svelte, Vue, Astro, Liquid | Hono, Express/Koa-style routing, NestJS, React/React Router, Svelte/SvelteKit, Vue/Nuxt |
| Python and templates | Python, Jinja | Django/DRF, Flask/Flask-RESTful, FastAPI |
| JVM | Java, Kotlin, Scala, Groovy | Spring, Play Framework |
| Native and Apple | C, C++, Objective-C, Swift, SystemVerilog | SwiftUI, UIKit, Vapor, Swift–Objective-C bridge |
| .NET | C#, VB.NET, Razor | ASP.NET Core |
| PHP and Ruby | PHP, Ruby, Twig | Laravel, Drupal, Rails |
| Go and Rust | Go, Rust | Go routers (Gin, chi, gorilla/mux), Rust web (Axum, actix-web, Rocket) |
| Mobile bridges | Dart, ArkTS | React Native (legacy/TurboModules), Expo Modules, React Native Fabric/Codegen |
| Scripting and scientific | Lua, Luau, Julia, Fortran, R, Pascal | — |
| Data, config, and shell | SQL, HCL, Nix, SCL, Solidity, Bash, PowerShell, YAML | dbt |

See the exact [language and framework coverage](docs/code-intelligence-capabilities.md) and the [tested codebases](docs/tested-codebases.md).

## Benchmark results

A [July 2026 local OpenCode benchmark](docs/benchmarks/opencode-seven-arm-2026-07-12.md) ran 276 completed post-indexing sessions across ten repository-specific architecture questions, seven retrieval arms, and four repeats per launchable cell. Mean answer F1 was similar across all arms at 97.1% to 98.1%. SolidKG core had the lowest mean API-equivalent cost, while SolidKG + SCIP used the fewest agent tool calls.

| Arm | Completed | Mean F1 | Mean tokens | Tools/task | Session time | API-equivalent cost |
|---|---:|---:|---:|---:|---:|---:|
| No graph baseline | 40 | 97.5% | 96,050 | 15.1 | **57.9 s** | $0.2316 |
| SolidKG core | 40 | 97.1% | **72,755** | 4.8 | 67.4 s | **$0.2124** |
| SolidKG + SCIP | 40 | 97.2% | 84,166 | **4.0** | 59.8 s | $0.2179 |
| CodeGraph | 36 | 98.0% | 89,552 | 13.8 | 65.6 s | $0.2249 |
| Sverklo | 40 | **98.1%** | 109,315 | 15.1 | 78.6 s | $0.2593 |
| Cartog | 40 | 97.4% | 124,735 | 15.9 | 74.0 s | $0.2789 |
| Tilth | 40 | **98.1%** | 107,748 | 14.2 | 74.7 s | $0.2450 |

Against the no-graph baseline, SolidKG core used a paired median 8 fewer tool calls per task, or 70.0% fewer; SolidKG + SCIP used 8.5 fewer, or 71.0% fewer. The default SolidKG profile packages retrieval into one answer-producing tool, so this measures agent interaction efficiency rather than computation alone. The raw exact sign-flip p-value was 0.00195, while the predeclared Holm-adjusted value was 0.140625.

The aggregate mean token values remain useful descriptive results, but the paired analysis did not show a reliable token or session-time reduction. The lower SolidKG core token mean was driven largely by the VS Code runs. CodeGraph completed 36 of 40 cells because its four .NET Runtime cells were unavailable, so its aggregate covers a different task mixture.

Indexing time was excluded. The benchmark used one architecture question per public repository and did not test patches, builds, regressions, security, maintenance, or developer productivity. Two blinded reviewers from the same model family disagreed in at least one scored field on 269 of 276 answers, followed by separate AI adjudication. Raw trajectories, exact source snapshots, resolved configurations, scoring inputs, and the analysis package are not published here; see the detailed report for the complete methodology and limitations.

## Built for real codebases

SolidKG goes beyond a flat symbol index:

- **Semantic hyperedges** preserve multi-symbol relationships such as route bindings, event channels, UI render chains, dynamic dispatch, native bridges, and type contracts.
- **Framework resolvers** connect routes, handlers, composition, and native bridges that syntax alone misses.
- **Optional SCIP** adds compiler-grade navigation without replacing the always-available AST graph.
- **Source-body retrieval** improves natural-language discovery while exact symbol, path, trace, semantic, and SCIP evidence stays higher priority.
- **Architecture and snapshots** make package coupling and graph changes explicit instead of leaving them as review intuition.

Retrieval stays deterministic and transparent:

- Persisted local source-body/code-token chunks can seed or boost a result and appear as the `source_body_chunk` ranking reason. Exact symbol, path, trace, semantic, and SCIP evidence still outranks body-only matches.
- External embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default; the optional hybrid retrieval seams remain disabled.
- Query exclusions are retrieval constraints, not search terms. A `missing_query_concept` label means the returned source did not cover every explicit concept, so the answer is intentionally partial.

## TypeScript API

```typescript
import SolidKG from "solidkg";

const graph = await SolidKG.init("/path/to/project", { index: true });

const matches = graph.searchNodes("UserService");
const match = matches[0];
if (!match) throw new Error("UserService not found");

const impact = graph.getImpactRadius(match.node.id);
const overview = graph.getOverviewText({ maxDepth: 2 });

console.log(matches.length, impact.nodes.size, overview);
graph.close();
```

Architecture health is a read-only deterministic report of structural findings, metrics, evidence anchors, and per-signal coverage. It does not assign a score, grade, severity, or runtime verdict. Static unreferenced results are candidates, not proof that code is dead.

Before this example, save the `before-refactor` snapshot with the command below. The example opens an existing index with a new read-only handle.

```typescript
import SolidKG from "solidkg";

const graph = await SolidKG.open("/path/to/project", { readOnly: true });
try {
  const health = graph.getArchitectureHealth({
    layers: [{ name: "api", paths: ["src/api/**"] }],
  });
  const drift = await graph.getSnapshotHealthDrift("before-refactor");
  console.log(health, drift);
} finally {
  graph.close();
}
```

Health drift always includes graph-diff counts. Its semantic comparison is `comparable`, `partially_compatible`, `incompatible_analysis`, or `baseline_analysis_unavailable`; incompatible or unavailable analysis never produces a guessed finding comparison.

## Advanced workflows

```bash
solidkg overview . --max-depth 2
solidkg snapshot create before-refactor --layers '[{"name":"api","paths":["src/api/**"]}]' --path .
solidkg architecture health --layers '[{"name":"api","paths":["src/api/**"]}]' --json --path .
solidkg snapshot drift before-refactor --json --path .
solidkg architecture analyze --path .
solidkg scip generate --path .
```

Health and drift reads are read-only and require schema 11. If an existing index needs a schema upgrade, run `solidkg sync <project>` once with write access. Then retry the read. Human and MCP output caps each finding or delta category at 20 items and reports the remainder. CLI `--json` and TypeScript API results remain complete.

The compact MCP profile still exposes only `solidkg_explore`. Ask it explicit questions such as "Show repository architecture health" or "What architecture health drifted since snapshot before-refactor?". A drift label in an explore query must match one saved snapshot label exactly, including case. Set `SOLIDKG_MCP_TOOLS=all` to expose the advanced `solidkg_architecture` tool with `action="health"` and `solidkg_snapshot` with `action="drift"`. Run `solidkg <command> --help` for the complete CLI.

## Install from source

The public source archive includes the maintained SCIP integrations and pinned native grammar manifest needed to reproduce supported behavior.

Source checkout and development require Node.js 24 and the pnpm version pinned in `package.json` (`10.34.5`).

```bash
git clone https://github.com/Valid-Systems/SolidKG.git
cd SolidKG
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run verify:source:full
```

`verify:source:full` builds the project, validates required assets and vendored sources, indexes a real fixture, exercises the stdio MCP server and `solidkg_explore`, runs the public test suite, and checks release-package contents.

## License

SolidKG is open source under the [MIT License](LICENSE).

Third-party notices are in [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md). SolidKG builds on ideas explored by [Codegraph](https://github.com/colbymchenry/codegraph), [Sverklo](https://github.com/sverklo/sverklo), [Tilth](https://github.com/jahala/tilth), and [Cartog](https://github.com/jrollin/cartog).

\* “The best static intelligence for agents” is based on SolidKG's analyses of non-commercial alternatives; commercial offerings were excluded.
