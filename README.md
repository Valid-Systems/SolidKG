# SolidKG

<p align="center">
  <img width="500" alt="SolidKG" src="https://github.com/user-attachments/assets/6c138932-b594-4dd2-8393-62197bc057de" />
</p>

Our take on a codebase knowledge graph for AI agents. We combined the best ideas we found in respected graph tools and research papers. Tested error-free indexing and use for 118 of the largest and most important OSS codebases.

Current coverage: **43 language/source modes**, and **25 dedicated framework/runtime resolvers** that connect routes, middleware, controllers and views, UI components, dependency injection, and native bridges instead of leaving the agent to guess from raw AST calls.

SolidKG creates a database to store deterministic AST-derived facts: files, symbols, calls, imports, references, source chunks, semantic hyperedges, and optional SCIP compiler references. The benchmarks below include the wins, losses, and awkward parts. No spin.

## Why SolidKG

Our goal was the most correct, useful context without making the agent crawl the repository first. It's not about winning a token-count contest, or bragging about initial indexing speed (useless benchmark for something you build once and update incrementally).

SolidKG returns the source behind its answers, shows where synthesized links came from, and says when the evidence is incomplete. The same graph powers tracing and change work: impact analysis, affected tests, snapshots, and architecture views.

It is still static analysis. Meaning it won't catch reflection, generated code, runtime-only dispatch, and unsupported language tricks. When the graph doesn't, it tells the agent with honesty.

## Benchmarks

The latest run used OpenCode with `openai/gpt-5.6-sol`: ten repositories, seven arms, four repeats per repository/arm, 280 scheduled sessions, and 276 completed. CodeGraph's four .NET Runtime cells were unavailable in our frozen setup.

| Arm               | Completed | Mean F1 | Mean tokens | Tools/task | Session time | API-equivalent cost |
| ----------------- | --------: | ------: | ----------: | ---------: | -----------: | ------------------: |
| No graph baseline |        40 |   97.5% |      96,050 |       15.1 |   **57.9 s** |             $0.2316 |
| SolidKG core      |        40 |   97.1% |  **72,755** |        4.8 |       67.4 s |         **$0.2124** |
| SolidKG + SCIP    |        40 |   97.2% |      84,166 |    **4.0** |       59.8 s |         **$0.2179** |
| CodeGraph         |        36 |   98.0% |      89,552 |       13.8 |       65.6 s |             $0.2249 |
| Sverklo           |        40 |   98.1% |     109,315 |       15.1 |       78.6 s |             $0.2593 |
| Cartog            |        40 |   97.4% |     124,735 |       15.9 |       74.0 s |             $0.2789 |
| Tilth             |        40 |   98.1% |     107,748 |       14.2 |       74.7 s |             $0.2450 |

The short version: graph tools cut the agent's search work. In this benchmark they did not make the complete session faster or improve already-near-ceiling answer quality. Whether that changes real coding outcomes requires longer and more thorough benchmarks.

- SolidKG core used the fewest mean tokens and had the lowest estimated cost. SolidKG + SCIP used the fewest tools.
- SolidKG core used 70.0% fewer paired tool calls than baseline; SCIP used 71.0% fewer. Big descriptive drops, but not statistically significant after the predeclared multiple-comparison correction (`Holm p = 0.140625`).
- None of that made the full task faster. Baseline averaged 57.9 seconds. Core took 67.4; SCIP took 59.8. Every graph arm had a slower mean.
- The low core token mean was not universal. Paired repository medians were +0.2% for core and +11.5% for SCIP. The VS Code repository in our benchmark was the huge win: 70,897 tokens versus baseline's 268,642.
- Answer quality was effectively tied. Mean F1 stayed between 97.1% and 98.1%, with zero paired median difference from baseline for every arm.
- Raw retrieval was not fastest either. Sverklo and Cartog posted lower direct MCP latency medians.

### Earlier internal runs

| Run     | What happened                                                                       | Timing                                                                  |
| ------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| July 10 | SolidKG used 16.7% fewer tools and 15.9% fewer tokens than CodeGraph across 7 repos | Omitted. The concurrent host could not support a fair speed comparison  |
| July 11 | SolidKG used 34.6% fewer tools and 34.7% fewer tokens across 4 repos                | Nominally 3.3% lower, but concurrent and descriptive. Not a speed claim |
| July 12 | SolidKG had the lowest mean-token, tools/task, and estimated-cost results           | Neither SolidKG arm beat baseline                                       |

These were architecture-explanation tasks, not coding tasks. They say nothing about patch quality, tests, regressions, security work, or human productivity.

The benchmark reports, raw trajectories, evidence bundles, and source snapshots are intentionally not part of this initial public release. These numbers are maintainer-reported claims and cannot be independently reproduced from this repository alone yet.

### Precision checks

Here is what the separate 51-repository reference-quality sweep actually found. It was not a competitor benchmark.

| Check                            |                                                                                                                    Result |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------: |
| Route-binding integrity          |                                                                                                      7,218 / 7,923; 91.1% |
| Source-chunk attachment          |                                                                                                   95,420 / 137,352; 69.5% |
| Capability-producer completeness |                                                                                                   85,963 / 117,482; 73.2% |
| Default retrieval probes         | 4 required-source hits; 2 calibrated abstentions; 100% useful-source recall where labeled; 0 misleading-source intrusions |
| Integrity errors                 |                                                                 0 file errors; 0 dangling edges; 0 duplicate repositories |

The supporting sweep report is not included in this initial public release. The repository does include the [tested codebases](docs/tested-codebases.md) list.

## Install

Requires Node.js 24.

```bash
npm install -g solidkg
cd /path/to/project
solidkg install
solidkg init -i .
solidkg status .
```

`solidkg install` configures Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi, and Kimi Code.

### Install from a GitHub checkout

GitHub source archives include the pinned, SolidKG-maintained SCIP indexer sources under `vendored/`, the native parser manifest at `src/extraction/native-grammars.json`, and `src/db/schema.sql`. The first build stages the host platform's parser libraries from the pinned language-pack release; runtime indexing never downloads grammars. Unpublished benchmark/evidence documents, harnesses, and fixtures are omitted because they are not product inputs.

```bash
git clone https://github.com/Valid-Systems/SolidKG.git
cd SolidKG
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run verify:source:full
```

The pinned source toolchain is Node 24 plus the exact pnpm version in `package.json`. With permission to modify the user's global pnpm bin, `pnpm run install:source` makes this verified checkout's `solidkg` command available to coding agents. Run `solidkg install --check` before changing any harness configuration.

### Why SolidKG ships maintained SCIP indexers

The repositories under `vendored/` are not disposable examples and are not interchangeable with whatever happens to be the latest official release. They are pinned SolidKG compatibility variants: they preserve the command-line, output-file, project-root, symbol-encoding, and cross-platform behavior that SolidKG expects, including SolidKG-specific changes where upstream behavior diverges. Shipping the source makes the supported variants auditable and reproducible and prevents an unrelated upstream update from silently changing SolidKG behavior.

The original projects remain the upstream authors and copyright holders; their licenses and notices are retained in each directory. Upstream fixes should be deliberately ported and retested rather than replacing these trees wholesale. See [`vendored/README.md`](vendored/README.md) for the source map and expected integration commands.

`pnpm run build` builds SolidKG and its bundled TypeScript SCIP integration; it does not compile every polyglot indexer. For another language, build the matching maintained source with that project's documented toolchain, place its expected command on `PATH`, and then run `solidkg scip generate --path .`. Existing `.scip` output can be loaded with `solidkg scip import <file> --path .`.

## Use it

The default MCP profile exposes one tool: `solidkg_explore`. Ask a normal structural question. It returns ranked source and graph evidence in one response.

```bash
solidkg context "how does auth work?" --path .
solidkg callers UserService --path .
solidkg impact UserService --path .
solidkg affected src/foo.ts --path .
solidkg architecture analyze --path .
```

Need the full MCP surface for trace, SCIP, snapshots, architecture, status, search, or context?

```bash
SOLIDKG_MCP_TOOLS=all solidkg serve --mcp
```

Run `solidkg <command> --help` for everything else.

### Retrieval behavior

Local source-body/code-token chunks can seed or boost retrieval and appear as the `source_body_chunk` ranking reason; exact symbols, paths, flow evidence, semantic relations, and SCIP facts still rank higher. External dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default; optional hybrid retrieval seams remain disabled.

Explicit exclusions such as "not tests" are retrieval constraints, not positive search terms. A `missing_query_concept` label means the returned source did not cover every explicit counterfactual concept, so the answer packet is intentionally partial.

## TypeScript API

```typescript
import SolidKG from "solidkg";

const graph = await SolidKG.init("/path/to/project", { index: true });
const matches = graph.searchNodes("UserService");
const impact = graph.getImpactRadius("UserService");
graph.close();
```

The API also covers sync/watch, context, overviews, hyperedges, snapshots, architecture, and SCIP.

## Coverage

The 43 modes are 41 symbol-extraction modes plus YAML and Twig file/framework tracking. The 25 framework/runtime resolvers detect conventions, resolve framework-specific references, create route and middleware nodes, connect them to handlers, and emit semantic relation hints for higher-order flows.

Exact lists and known gaps: [language registry](src/types.ts), [framework registry](src/resolution/frameworks/index.ts), and [capability matrix](docs/code-intelligence-capabilities.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify:source:full
```

`verify:source:full` builds the CLI, checks the SQL/native-parser metadata and host parser cache, indexes a fresh fixture, exercises the real stdio MCP server and `solidkg_explore`, runs the public product test suite, and validates release-package contents without publishing. Maintainer-only benchmark/evidence document contracts are not part of that public suite.

The repository root is marked `private: true`. Releases are generated as npm shims and per-platform bundles by GitHub Actions. Do not publish the root package directly.

## License

SolidKG is available under the [SolidKG Evaluation and Personal Use License](LICENSE). It allows a 15-day honor-based evaluation and personal, non-commercial use. Commercial use after the evaluation requires a separate commercial license.

Third-party notices: [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) and [docs/third-party-licenses/](docs/third-party-licenses/).
