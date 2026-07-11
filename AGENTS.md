# AGENTS.md

This file provides guidance to Agents when working with code in this repository.

## Project Overview

SolidKG is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols, pairwise edges, semantic hyperedges, and files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent) over MCP. Per-project data lives in `.solidkg/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `solidkg` on npm; same binary serves as installer, indexer, and MCP server.

## Build, Test, Run

Use pnpm for local agent work in this repo. The package scripts are npm-compatible for published users, but do not use bare `npm` while developing here unless a release workflow explicitly requires it.

```bash
pnpm exec tsc           # TypeScript build/check
pnpm run copy-assets    # copy schema.sql and *.wasm into dist/
node -e "require('fs').chmodSync('dist/bin/solidkg.js', 0o755)"  # executable bit

pnpm run dev            # tsc --watch
pnpm run clean          # rm -rf dist

pnpm test               # vitest run (all)
pnpm run test:watch
pnpm run test:eval      # only __tests__/evaluation/
pnpm run eval           # build then run __tests__/evaluation/runner.ts via tsx

# Single test file / pattern
pnpm exec vitest run __tests__/installer-targets.test.ts
pnpm exec vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

Node engines: `>=24.0.0 <25.0.0`; use Node 24 LTS (v24.16.0) for local development when possible. The CLI hard-blocks Node <24 and Node 25.x unless explicitly overridden (see `src/bin/node-version-check.ts`). Released bundles ship their own Node runtime.

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/hyperedges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       Semantic hyperedge synthesis (route chains, event channels, bridges)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `SolidKG` class wires all the layers and re-exports types, including explicit graph snapshots/diffs and package/layer architecture rollups. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `SolidKG` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `getHyperedgesByNode`, `findHyperedgesBetweenNodes`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`, migrations, and `sqlite-adapter.ts`. Stores files, graph facts, semantic hyperedges, explicit graph snapshots, architecture rollup reports, and SCIP facts. The active backend is Node's built-in `node:sqlite` via a better-sqlite3-shaped adapter; released bundles carry the Node runtime, so there is no native build or wasm fallback in current builds. `solidkg status` surfaces backend and journal mode.
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, `callback-synthesizer.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes, `references` edges, and relation hints for semantic hyperedge synthesis.
- `src/hypergraph/` — deterministic semantic hyperedge IDs and synthesis from resolved framework/dynamic-dispatch metadata. Hyperedges preserve ordered multi-symbol relationships that pairwise edges flatten.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries).
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/overview/` — derived repository overview projection and progressive renderer over indexed files, symbols, and architecture assignments. This is not a second scanner or documentation authority; `.solidkg/` remains the source of truth.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`) plus shared daemon plumbing (`daemon.ts`, `daemon-paths.ts`, `engine.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- SCIP support is additive: generated or imported `.scip` indexes provide compiler-grade definitions/references/implementation/type-definition facts on top of the normal AST graph. Keep `solidkg_precise_refs`, status SCIP import/link/generation state, and primary-tool SCIP hints documented together when changing this surface.
- `src/installer/` — see below.
- `src/bin/solidkg.ts` — CLI (commander). Subcommands include `install`, `uninstall`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `overview`, `context`, `snapshot`, `architecture`, `callers`, `callees`, `impact`, `affected`, `scip generate`, `scip import`, and `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### NodeKind / EdgeKind / HyperedgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.
- **HyperedgeKind**: `route_binding`, `event_channel`, `ui_render`, `dynamic_dispatch`, `native_bridge`, `type_contract`. These are n-ary semantic relationships stored in `hyperedges` + `hyperedge_members`; pairwise edges remain the compatibility/projection layer.

### Multi-agent installer

`src/installer/` is the entry point for `solidkg install` (and the bare `solidkg`/`npx solidkg` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding another agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location, MCP-server JSON/TOML/JSONC writing, and instructions-file path.
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`, `hermes.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.solidkg]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` is the agent-agnostic instructions file written to each target (e.g. `CLAUDE.md`, `.cursor/rules/solidkg.mdc`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`). It explicitly says "Prefer SolidKG over broad grep/read loops." and "Fall back to targeted Read only when SolidKG reports stale, truncated, omitted, unreadable, ambiguous, or heuristic-only results." — earlier versions prescribed Claude-specific "spawn an Explore agent" and confused other agents.
- Installed guidance should describe the default compact MCP profile: only `solidkg_explore` is visible, it accepts natural-language structural questions or precise symbol/file terms, and one answer-producing call should usually end discovery.
- Installed guidance should document `SOLIDKG_MCP_TOOLS=all` as the explicit opt-in for trace, precise refs, node, callers/callees/impact, files/overview, snapshots, architecture, status, search, and context.
- Installed guidance should state: source-completeness fields are returned-source coverage only, not answer/path/runtime correctness, confidence, query quality, or global false-path guarantees.
- Installed guidance should define answer packets as deterministic returned-context metadata with evidence anchors, ranking reasons, binary sufficiency, suggested next SolidKG tools, and bounded uncertainty labels — not runtime correctness proof. When an answer packet says the returned context is sufficient, answer from that context instead of drilling further.
- Installed guidance should explain that `source_body_chunk` ranking reasons mean persisted local source-body/code-token chunks seeded or boosted a result, and that exact symbol/path/trace evidence remains higher-salience than body-only evidence.
- Installed guidance should define capability footprints as may-behavior evidence, not runtime proof. Coverage states (`complete`, `partial`, `unsupported`, `failed`, `not_run`, `stale`) describe capability-producer coverage for returned files, and empty assertions do not prove no capability exists.
- Installed guidance should never force follow-up solely because candidate coverage is omitted, truncated, or partial. Follow up only when the answer packet is insufficient because required anchors/source are missing, stale, unreadable, ambiguous, or disconnected.
- Installed guidance should state external dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default; optional hybrid extension seams remain disabled unless a future build explicitly supports and configures them.
- `claude-md-template.ts` is the legacy Claude-only template, retained for compatibility paths.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — the parameterized contract tests cover install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for agent-specific formats.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the exposed profile, so treat it as authoritative provider-neutral guidance and keep it in sync with `instructions-template.ts`, `.cursor/rules/solidkg.mdc`, the README, and public MCP docs. The compact instructions must mention only `solidkg_explore`; the full instructions may describe every advanced tool. Tool-name guidance should preserve raw server names as documented `solidkg_*` names and describe host-added display/permission prefixes as client-specific wrappers, not names to copy into calls. Keep Claude-specific behavior only in Claude target files.

## Retrieval performance & dynamic-dispatch coverage (do not regress)

SolidKG's core value is letting an agent answer **structural/flow** questions ("how does X reach Y", trace, impact, callers) with a few **fast** solidkg calls and **zero Read/Grep**. The optimization target is **wall-clock latency + tool-call count** — *don't optimize for token cost*. In the matched OpenCode / `openai/gpt-5.6-sol` comparison, SolidKG used **16.7% fewer tool calls and 15.9% fewer tokens** than CodeGraph across the seven README repositories; both products had zero median Read/Grep/Glob calls in every repository. The matrix has four successful repeats per repository/product cell; see `docs/benchmarks/opencode-head-to-head-2026-07-10.md`. The mechanism that drives everything here: **an agent falls back to Read/Grep the instant a SolidKG answer is insufficient.** So every change is judged by one question — is SolidKG's answer sufficient enough to *stop* the agent from reading?

**Target behavior:** a flow question resolves in **1 solidkg call on small repos, scaling to 3–5 on large**, with **Read/Grep = 0**. When reviewing a PR or trying something new, do not regress this.

### Adapt the tool to the agent — don't try to change the agent

The lever that decides whether a retrieval change lands. **Test before building anything here: does this make a tool the agent _already calls_ do more with the input it _already gives_? If it instead needs the agent to behave differently — pick a different tool, query differently, learn from examples — it hits the low-salience wall and won't land.**

Instruction wording and examples remain low-salience. Tool visibility is different: an unlisted tool cannot be selected, so the default compact MCP profile is a high-salience composition boundary rather than prompt steering. `SOLIDKG_MCP_TOOLS=all` retains the full expert surface without making every ordinary question choose among thirteen tools.

What works is meeting the agent where it already is:
- **Compact answer surface** — the default MCP profile exposes only `solidkg_explore`. It accepts the natural-language question the agent already has and must return enough ranked production source and graph evidence to answer in one call. `SOLIDKG_MCP_TOOLS=all` restores advanced tools for explicit workflows.
- **Sufficiency** — `solidkg_trace` inlines each hop's body/source and the destination's own callees, so one trace call ends the flow investigation for those returned hops (no follow-up explore/node/Read just to fetch them).
- **Answer packets** — high-salience tool outputs include deterministic evidence anchors, ranking reasons, binary returned-context sufficiency, suggested next SolidKG tools, and bounded uncertainty labels so agents can stop or continue for a specific reason. When an answer packet says the returned context is sufficient, answer from that context instead of drilling further. Use solidkg_node for one specific missing symbol or hop, not as a loop over many symbols.
- **Counterfactual concept coverage** — explicit exclusions such as "not tests" or "excluding generated metadata" are retrieval constraints rather than positive terms. If returned source does not cover every explicit concept in that query, `solidkg_explore` emits `missing_query_concept` and a partial packet instead of overstating sufficiency.
- **Source-body chunk evidence** — `solidkg_context`, `solidkg_explore`, and `solidkg_search` can use persisted local source-body/code-token chunks to seed or boost results and surface a `source_body_chunk` ranking reason. This is deterministic local evidence; exact symbols, paths, trace paths, semantic relations, and SCIP facts must still outrank body-only evidence.
- **Disabled hybrid seam** — external dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default. Optional extension seams are typed for future experiments only; do not assume LanceDB, API keys, network calls, or telemetry are active.
- **Capability footprints** — high-salience `solidkg_trace` / `solidkg_node` sections summarize may-read/write/guard/emit/subscribe/send/mutate behavior. Treat them as evidence with explicit coverage states, not runtime proof; empty assertions are absence of returned evidence, not proof of no capability.
- **Overview projection** — `solidkg_files format=overview` gives agents a budgeted repository map with language, symbol-kind, conservative anchor, and architecture hints through an existing tool they already call. Keep it derived from indexed facts; do not introduce a parallel filesystem authority.
- **explore-flow** — `solidkg_explore` accepts natural-language questions for retrieval and precise symbol bags for exact flow rendering. Automatic flow endpoints come only from explicit/anchored callable intent; generic prose verbs such as `send` and `request` must not create ambiguity. For precise names (including qualified `Class.method`), explore finds the call path among those symbols using synthesized edges and leads its output with it.
- **Ambiguity beats false confidence** — unqualified duplicate callable names are intentionally conservative: `trace` asks for a qualified/path-qualified endpoint, and `explore` omits the Flow section for unanchored duplicates instead of stitching together unrelated same-name functions.

What fails is requiring a fuzzy-input agent to discover precise endpoints before the tool can help. Retrieval must rank useful production evidence from the natural-language question; exact flow rendering remains conservative and activates only when explicit symbols are present.

The remaining lever under this axis is **coverage**: every flow made to connect statically (a new dynamic-dispatch synthesizer) is then surfaced automatically by explore-flow/`trace`, no agent change needed. Reactive/reconciler runtimes (Halo's `ReactiveExtensionClient`, MediatR, Vue Proxy) are the frontier — flows there have no static edges, so nothing surfaces (correctly — silent beats wrong). Full investigation + A/B record: `docs/benchmarks/call-sequence-analysis.md`.

### Explore budget — keep BOTH budgets monotonic with repo size

Two functions in `src/mcp/tools.ts` scale explore with indexed file count. This is the expected resolution (a regression here silently forces agents back to Read):

| Repo | files | explore calls | chars/call | per-file |
|---|---|---|---|---|
| express (small) | 147 | 1 | 18K | 3800 |
| excalidraw/django (medium) | 643–3043 | 2 | 28K | 6500 |
| vscode (large) | 10446 | 3 | 35K | 7000 |
| ~20k / ~40k | — | 4 / 5 | 38K | 7000 |

- `getExploreBudget(fileCount)` → **call** budget: `<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5` (max 5).
- `getExploreOutputBudget(fileCount)` → **per-call** output (chars / files / per-file). **Invariant: a larger tier must never get a smaller `maxCharsPerFile` than a smaller tier.** (Regression that motivated this doc: the `<5000` tier's 2500 was *below* the `<500` tier's 3800, so on a god-file repo — excalidraw's 415 KB `App.tsx` — one explore returned <1% of the file and forced a Read.)
- Explore output must **never tell the agent to "use Read"** for source already returned. Do not follow up solely because peripheral candidate coverage is partial, omitted, or truncated. Prefer SolidKG over broad grep/read loops. Fall back to targeted Read only when the answer packet is insufficient because required source is stale, unreadable, or absent.

### Dynamic-dispatch coverage — the flow must EXIST in the graph end-to-end

Static tree-sitter extraction misses computed/indirect calls, so flows break at dynamic dispatch and the agent reads to reconstruct them. Synthesizers/resolvers bridge these so `trace`/`explore` connect end-to-end (`src/resolution/callback-synthesizer.ts`, `src/resolution/frameworks/`, `src/hypergraph/synthesizer.ts`). Channels today: callback/observer, EventEmitter, **React re-render** (`setState`→`render`), **JSX child** (`render`→child component), django ORM descriptor, and route-chain semantic relations. Synthesized pairwise edges use `provenance:'heuristic'` with `metadata.synthesizedBy` + `registeredAt` (the wiring site), surfaced inline in `trace`, the `node` trail, and `context` call-paths. Multi-symbol shapes that pairwise edges flatten are stored as semantic hyperedges and surfaced in `context`, `node`, and `status`.

**Principle: partial coverage is WORSE than none.** Bridging one boundary but not the next reveals a hop the agent then drills + reads to finish. Measured on excalidraw: react-render alone *raised* reads to 5–7; only completing the flow (adding the jsx-child hop) dropped it to 0–1. **Always close the flow end-to-end and re-measure** — never ship a half-bridged flow.

### Validation methodology (REQUIRED for every new language/framework)

For each **language × framework**, validate on **small, medium, and large** real repos with **≥3 different flow prompts** each:

1. **Pick the canonical flow** for the framework ("how does X reach Y": state→render, request→handler→view, query→SQL, action→reducer→store…).
2. **Deterministic probes** (`scripts/agent-eval/probe-{trace,node,context,explore}.mjs` against the built `dist/`): `trace(from,to)` connects end-to-end with no break; **no node/hyperedge explosion** (`select count(*) from nodes` and `hyperedges` stable before/after re-index); synthesized-edge and semantic-relation **precision** spot-check (`select … where provenance='heuristic'`).
3. **Agent A/B** (`scripts/agent-eval/run-all.sh <repo> "<Q>"`): with vs without solidkg, **≥2 runs/arm** (run-to-run variance is large — never conclude from n=1). Record **duration, total tool calls, Read, Grep**. Optional forced-Read-0 sufficiency proof via the block-read hook (`scripts/agent-eval/hook-settings.json`).
4. **Pass bar:** a normal flow question reaches **~0 Read/Grep within the repo's explore-call budget**, runs **faster** than without-solidkg, and shows **no regression on a control repo**. Record the numbers in `docs/design/dynamic-dispatch-coverage-playbook.md` (the coverage matrix).

Full playbook + per-mechanism design: `docs/design/dynamic-dispatch-coverage-playbook.md` and `docs/design/callback-edge-synthesis.md`.

### Worked example — Excalidraw (TS/React, medium, 643 files)

The template to replicate per language/framework. Question: *"how does updating an element re-render the canvas on screen?"* (the full flow crosses three React boundaries: observer callback, `setState`→`render`, and JSX child).

| Stage | duration | Read | Grep | solidkg |
|---|---|---|---|---|
| Without solidkg | 115–139s | 9–10 | 10–11 | 0 |
| Broken (explore-budget regression) | 131–139s | 5–10 | 3–5 | 6–14 |
| Fixed (budget + msgs + synthesis) | 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first steering | **51–74s** | **0–2** | 0–4 | **3–4** |

n=4 unhooked runs/stage, same prompt. After steering flow questions to `solidkg_trace` first: **best run 0 Read / 0 Grep / 3 solidkg / 51s**; **2 of 4 fully clean** (0 Read, 0 Grep). Steering eliminated the over-drill variance — call count tightened from 3–10 to 3–4, trace adoption went 3/4 → 4/4, and the `search`+`callers` path-reconstruction floundering dropped to 0. Run-to-run variance is still real; report the range, never a single run. **Residual reads/greps are all the nonce data-flow** (`canvasNonce` — a local prop with no graph edges); that's the def-use/data-flow frontier, left deliberately uncovered (tracking every local would explode the graph). Validated: `trace(mutateElement, renderStaticScene)` connects in **6 hops** across all three boundaries (`mutateElement → triggerUpdate → [callback] triggerRender → [react-render] render → [jsx] StaticCanvas → renderStaticScene`), each hop showing inline source + the wiring site; node count stable at 9,289; 1 callback + 46 react-render + 280 jsx-render synthesized edges (no explosion, precision-checked).

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise solidkg against synthetic projects and score the results; run via `pnpm run eval` (builds first). Not part of `pnpm test`.
- `hypergraph-storage.test.ts`, `hypergraph-synthesis.test.ts`, `hypergraph-traversal.test.ts`, `mcp-hyperedges.test.ts` — semantic hyperedge storage, synthesis, traversal, and MCP surfacing.
- `sqlite-backend.test.ts` — covers the `node:sqlite` adapter and status reporting.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

### Windows-gated tests

Behavior that differs by platform (path resolution, drive letters, `SENSITIVE_PATHS`, `%APPDATA%` config dirs, CRLF) must be gated, not assumed. Use `it.runIf(process.platform === 'win32')(...)` for Windows-only assertions and `it.runIf(process.platform !== 'win32')(...)` for POSIX-only ones — e.g. `/etc` is sensitive on POSIX but resolves to `C:\etc` (non-existent) on Windows, so an ungated `/etc` assertion fails on Windows. Validate the Windows side for real (see below); don't merge a Windows-gated test you haven't seen run.

## Cross-platform validation

When a change is platform-sensitive (file watching, sockets / named pipes, path & symlink handling, process lifecycle, inotify budget), validate the relevant platform for real rather than guessing. Do not treat a passing local run as coverage for OS-specific behavior.

### Linux (Docker)

When asked to test or validate on Linux, use **Docker** — there's no Linux box, but Docker runs on the macOS host. Build a throwaway image from the repo and run the suite inside it:

- `FROM node:22-bookworm`; `COPY` the repo with a `.dockerignore` excluding `node_modules`/`dist`/`.git`/`.solidkg`; `RUN npm ci && npm run build`. Don't reuse the Mac `node_modules` — `esbuild`/`rollup` ship platform-specific binaries.
- Run with **`docker run --rm --init`**. The `--init` is load-bearing for any process-lifecycle test (daemon reaping, the #277 PPID watchdog, idle-timeout): without a zombie-reaping PID 1, a SIGKILL'd/exited process lingers as a zombie and `process.kill(pid, 0)` still reports it *alive*, so exit-detection assertions false-fail even though the process did exit.
- Linux is where the inotify watch budget actually bites: count a process's watches via `/proc/<pid>/fdinfo/*` (sum `^inotify ` lines on the fd whose `readlink` is `anon_inode:inotify`).

### Windows (Parallels VM + SSH)

For any Windows-specific PR, bug, or implementation, validate it on the real Windows VM rather than guessing. Connection details live in the gitignored **`.parallels`** file at the repo root (VM name, guest IP, SSH user/key). `prlctl exec` needs Parallels Pro and is unavailable, so SSH is the bridge.

- Connect / run from the Mac host: `ssh <user>@<guest_ip> "..."`. For multi-line work, pipe PowerShell over stdin and **refresh PATH from the registry** first (sshd's session has a stale PATH after winget installs):
  ```
  ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  Set-Location C:\dev\solidkg
  PS
  ```
- Clone fresh into a **Windows-local** path (`C:\dev\solidkg`) and `npm ci` there — never run npm against the shared Mac repo, since `esbuild`/`rollup` ship platform-specific binaries.
- Guest toolchain (winget): Node LTS, Git, and the **VC++ ARM64 redistributable** (required by `@rollup/rollup-win32-arm64-msvc`, which vitest pulls in).
- Fetch a contributor PR head straight from their fork to dodge `pull/<n>/head` lag: `git fetch <fork-url> <branch>` then `git checkout -f FETCH_HEAD`.
- Known pre-existing Windows failures (they reproduce on `main`, unrelated to your change — confirm against `origin/main` before blaming your PR, and don't let them mask new regressions): `security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink` (symlink creation needs privileges on Windows); and the `mcp-initialize.test.ts` / `mcp-roots.test.ts` suites, which fail in `afterEach` with `EPERM` removing the temp dir because a spawned `serve --mcp` (its `--liftoff-only` re-exec grandchild) still holds the cwd / SQLite file open — a Windows file-locking quirk, not a logic bug.

## Releases

Released to npm and mirrored as [GitHub Releases](https://solidkg.local/repository/releases). Release notes are generated by GitHub during the Release workflow; this repository does not maintain a root changelog.

### Release flow (the user runs these)

Releases are built and published by the **GitHub Actions "Release" workflow**
(`.github/workflows/release.yml`). It bundles a Node runtime per platform (`scripts/build-bundle.sh`)
and publishes both the GitHub Release and the npm thin-installer
(`scripts/pack-npm.sh`: a shim package + per-platform packages).
Publishing manually is **wrong** now — a plain `npm publish` ships the root
package (non-bundled), which breaks anyone on Node < 22.5.

**Agents do NOT bump the version unless explicitly asked.** The maintainer
typically does it themselves — often by editing `package.json` directly via
the GitHub web UI. Don't proactively commit a version bump as part of
unrelated work, and don't propose one when summarizing a PR.

When the maintainer DOES bump the version, the only edit strictly required is
to `package.json` — the workflow's "Sync package-lock.json" step detects a
mismatch between `package.json` and `package-lock.json`, runs
`npm install --package-lock-only --ignore-scripts` to rewrite the lock file's
version fields (top-level + `packages.""`), and auto-commits + pushes the
result back to `main` with `[skip ci]`. So a GitHub-web-UI single-file edit to
`package.json` is enough to kick off a clean release. (If they edit both files
locally, that's fine too — the sync step no-ops.)

Once `package.json` is at the target version on `main`, trigger
**Actions → Release → Run workflow** (on `main`). The workflow:

1. Syncs `package-lock.json` to `package.json`'s version if they've drifted; commits + pushes that change.
2. Builds every platform bundle on one runner, generates `SHA256SUMS`.
3. Creates the GitHub Release with GitHub-generated notes.
4. Publishes the npm shim + per-platform packages. Requires the `NPM_TOKEN` repo secret.

**Do not run `npm publish`, `git push`, or `git tag` yourself** — these are
publish actions on shared state. Write the files, hand the user the commands.

## House rules

- Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, update **all four** of `src/mcp/server-instructions.ts`, `src/installer/instructions-template.ts`, `.cursor/rules/solidkg.mdc`, and `AGENTS.md` — they're written to different places but should say the same thing. Public behavior changes also need README/site docs.
- For upstream monitoring against `colbymchenry/codegraph`, follow `docs/maintenance/upstream-watch.md`, check `docs/maintenance/upstream-divergence.md`, and use `.upstream-watch/` plus `scripts/upstream-watch/report.mjs`. Upstream is a reference feed, not the source of truth for this fork's more advanced local behavior. This is a release-diff triage workflow only; never blindly apply upstream updates, merge, cherry-pick, rebase, tag, push, publish, or update `.upstream-watch/state.json` without explicit maintainer approval.
- SolidKG provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
