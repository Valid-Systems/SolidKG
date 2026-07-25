# SolidKG

<p align="center">
  <img width="360" alt="SolidKG code intelligence graph for AI coding agents" src="assets/logo.png" />
</p>

<p align="center"><strong>The best static intelligence for agents.</strong></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-solidkg">Why SolidKG</a> ·
  <a href="#measured-not-magic">Benchmarks</a> ·
  <a href="docs/code-intelligence-capabilities.md">Capabilities</a>
</p>

## Why SolidKG

Coding agents are good at reasoning once they have the right code. Finding that code requires fine-tuned automated assistance.

Tested error-free on 118 of the largest and most impactful OSS codebases across 40+ languages and frameworks, SolidKG indexes a project once, keeps it in sync, and gives agents a compact structural view.

- **Follow real flows.** Trace callers, routes, callbacks, UI render chains, framework conventions, and cross-language bridges.
- **Return evidence, not summaries.** Results include verbatim source, graph relationships, provenance, and explicit uncertainty when static analysis cannot prove a path.
- **Understand change risk.** Query callers, callees, impact radius, affected tests, snapshots, package boundaries, and layer coupling.
- **Stay local.** SQLite, tree-sitter, and optional SCIP run on your machine. No source uploads, embeddings, vector database, API keys, or telemetry are required.
- **Meet agents where they already work.** One installer configures Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP/Pi, and Kimi Code.

## Quick start

Requires Node.js 24.

```bash
npm install -g solidkg
solidkg install
solidkg init -i .
solidkg status .
```

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

Today that covers **43 language/source modes** and **25 framework/runtime resolvers**. It understands common application boundaries across JavaScript/TypeScript, Python, Ruby, PHP, Java, Go, Rust, C#, Swift, and more.

See the exact [language and framework coverage](docs/code-intelligence-capabilities.md) and the [tested codebases](docs/tested-codebases.md).

## Measured, not magic

In the latest matched benchmark, SolidKG substantially reduced agent search work while keeping answer quality effectively tied with the no-graph baseline.

| | No graph | SolidKG core |
|---|---:|---:|
| Mean tokens | 96,050 | **72,755** |
| Tools per task | 15.1 | **4.8** |
| Mean answer F1 | 97.5% | 97.1% |
| Mean session time | **57.9 s** | 67.4 s |

That is the honest result: fewer tools and fewer tokens did **not** make the full session faster in this run. Static analysis also cannot see every reflection-heavy, generated, or runtime-only path. SolidKG surfaces those limits rather than inventing confidence.

The benchmark covered ten repositories, seven retrieval arms, four repeats per repository and arm, and 276 completed sessions. The raw benchmark bundle is not included in this public source release, so treat the figures as maintainer-reported rather than independently reproducible.

## Built for real codebases

SolidKG goes beyond a flat symbol index:

- **Semantic hyperedges** preserve multi-symbol relationships such as route bindings, event channels, UI render chains, dynamic dispatch, native bridges, and type contracts.
- **Framework resolvers** connect conventions that syntax alone misses, including Express, Django, FastAPI, Rails, Laravel, Spring, ASP.NET, React, SvelteKit, Vue/Nuxt, and native/mobile bridges.
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

## Advanced workflows

```bash
solidkg overview . --max-depth 2
solidkg snapshot create before-refactor --path .
solidkg architecture analyze --path .
solidkg scip generate --path .
```

Set `SOLIDKG_MCP_TOOLS=all` on the MCP server to expose the advanced trace, precise-reference, snapshot, architecture, and status tools. Run `solidkg <command> --help` for the complete CLI.

## Install from source

The public source archive includes the maintained SCIP integrations and pinned native grammar manifest needed to reproduce supported behavior.

```bash
git clone https://github.com/Valid-Systems/SolidKG.git
cd SolidKG
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run verify:source:full
```

`verify:source:full` builds the project, validates required assets and vendored sources, indexes a real fixture, exercises the stdio MCP server and `solidkg_explore`, runs the public test suite, and checks release-package contents.

## License

SolidKG is source-available under the [SolidKG Evaluation and Personal Use License](LICENSE): a 15-day evaluation plus personal, non-commercial use. Commercial use after the evaluation requires a separate license.

Third-party notices are in [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md). SolidKG builds on ideas explored by [Codegraph](https://github.com/colbymchenry/codegraph), [Sverklo](https://github.com/sverklo/sverklo), [Tilth](https://github.com/jahala/tilth), and [Cartog](https://github.com/jrollin/cartog).
