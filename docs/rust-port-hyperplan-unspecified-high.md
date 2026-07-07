# Hyperplan Review: Mostly-Porting SolidKG to Rust

Reviewer: unspecified-high
Mode: hostile senior architecture review
Date: 2026-05-28

## Verdict

Do not port SolidKG mostly to Rust now.

The strongest adversarial read is that a broad Rust port would burn the product's most valuable assets: a working npm-first install path, a TypeScript library contract, provider-specific agent installer behavior, a heavily debugged Node/MCP process model, and a large language/framework extraction surface whose value depends on behavioral fidelity more than raw implementation language. Rust could be valuable for a few isolated hot paths, but only after a measured bottleneck proves that TypeScript/Node is the limiting factor and after the seam is made protocol-stable.

If the team wants Rust, the defensible shape is not "rewrite SolidKG in Rust." It is "keep the Node/TypeScript package, CLI shim, MCP compatibility, and SDK facade stable; optionally add a Rust engine or parser/indexer sidecar behind a versioned JSON/SQLite/protocol boundary, one vertical slice at a time."

## Current Architecture Facts That Matter

SolidKG is not just an indexer. It is a multi-surface product:

- Public npm package `solidkg` exports `dist/index.js`, `dist/index.d.ts`, and a `solidkg` bin.
- The supported library API is TypeScript-first: `SolidKG.init/open`, public graph types, options, snapshot and architecture report types, SCIP types, and helper exports all come from `src/index.ts`.
- The CLI in `src/bin/solidkg.ts` is broad: install/uninstall, init/uninit, index/sync/status/query/files/context, trace-style graph tools, snapshots, architecture, affected, SCIP generate/import, daemon MCP startup, path/data-dir handling, and Node runtime safety checks.
- MCP is a major product surface, not an adapter afterthought. `src/mcp/index.ts`, `daemon.ts`, `engine.ts`, `session.ts`, `transport.ts`, `proxy.ts`, and `tools.ts` encode direct/proxy/daemon modes, JSON-RPC, roots/list, cross-project tool calls, watchdog behavior, named pipes/sockets, daemon locks, idle shutdown, and shared file watchers/SQLite handles.
- Packaging deliberately removed native addons: release bundles copy a pinned official Node runtime plus compiled JS, production dependencies, WASM grammars, and schema assets. The npm package is a thin shim plus per-platform optional bundles, with a GitHub Release fallback cache.
- Storage is SQLite via Node's built-in `node:sqlite`; `src/db/sqlite-adapter.ts` is intentionally a thin better-sqlite3-shaped adapter and `src/db/index.ts` owns WAL, FTS5, PRAGMAs, migrations, and status surfacing.
- Extraction is a large behavioral surface: `src/extraction/grammars.ts` maps 40+ languages/extensions to `web-tree-sitter` WASM grammars; `src/extraction/tree-sitter.ts` contains generic extraction plus custom hybrid extractors; `src/extraction/languages/*` contains per-language mappings.
- Dynamic/semantic value is in resolver logic: `src/resolution/*`, framework resolvers, callback synthesis, and `src/hypergraph/synthesizer.ts` create heuristic and semantic edges that agent workflows depend on.
- Product strategy in docs is agent context, not a generic code parser. Benchmarks and AGENTS guidance emphasize fewer Read/Grep/tool calls, sufficiency of `trace`/`explore`, installer instructions, and stable MCP behavior.

These facts make a mostly-Rust port a boundary migration across every composition root at once: SDK, CLI, MCP server, daemon lifecycle, storage adapter, parser/extractor engine, resolver semantics, release artifacts, tests, docs, and agent instructions.

## Why a Mostly Rust Port Is a Bad Bet

### 1. It attacks solved constraints while risking unsolved ones

The current codebase already solved the classic Node deployment complaints by bundling a known Node runtime and avoiding native addons. `scripts/build-bundle.sh` explicitly says there is no native build or cross-compile step: it downloads Node, builds JS, installs production deps, and archives per target. `scripts/pack-npm.sh` then publishes per-platform optional bundles. A Rust binary could be smaller and avoid Node, but it reintroduces native release engineering: target triples, libc/MSVC nuances, cross-linking, reproducibility, crash diagnostics, possible code signing/notarization, and target-specific CI confidence.

The current release path builds all platform bundles on one Ubuntu runner because it is file packaging. A Rust port likely cannot preserve that property without serious cross-compilation work. That is not free operationally, and it shifts risk from a known Node runtime matrix to a Rust native-binary matrix.

### 2. It breaks or hollows out the TypeScript library API

The package's public SDK is not an accident. `package.json` exports JS and declarations; README documents root imports and warns against deep imports. A mostly Rust implementation has three bad SDK options:

- N-API binding: reintroduces native modules, per-platform ABI/package complexity, and install failures that the current bundle design intentionally eliminated.
- WASM module: awkward for filesystem, SQLite, worker/process, file watcher, and external SCIP indexer execution; likely loses the benefits of native Rust while preserving runtime complexity.
- Child-process RPC from JS to Rust: preserves npm import shape but makes `SolidKG` a client stub, changes lifecycle/error/performance semantics, and turns synchronous APIs like `openSync` into awkward wrappers or footguns.

The TypeScript declarations are also product documentation. Recreating them from Rust types is a maintenance burden, not a one-time conversion.

### 3. MCP process semantics are more expensive than they look

A Rust MCP server can speak JSON-RPC over stdio. That is the easy part. The hard part is reproducing every edge case already encoded in the Node implementation:

- direct/proxy/daemon selection and fallback
- detached daemon spawning using the same launcher context
- host PPID watchdog behavior
- per-project daemon lock arbitration
- Unix socket versus Windows named pipe behavior
- versioned daemon hello handshake
- idle timeout and client refcounting
- shared engine initialization and retry semantics
- file watcher debounce and disabled-reason logging
- roots/list request/response handling
- cross-project tool calls and default project hints

These are exactly the areas that tend to fail only on specific hosts, OSes, and MCP clients. Rewriting them because Rust feels cleaner is a regression factory.

### 4. The extraction surface is too wide to port casually

The parser layer is not just `tree-sitter.parse()`. It includes:

- 40+ language identifiers and extension mappings
- WASM grammar asset rules and vendored grammar exceptions
- generic node/name/signature/call/import extraction machinery
- language-specific extractors for TypeScript, Python, Go, Rust, Java, C#, PHP, Ruby, C/C++, Swift, Kotlin, Dart, Lua, Nix, SQL, Bash, PowerShell, and many more
- hybrid extractors for Svelte, Vue, Liquid, Astro, Jinja, Razor, DFM, ArkTS, SCL
- framework relation hints that feed semantic hyperedges
- worker recycling, parse timeouts, memory-error handling, and V8/WASM-specific mitigations

A Rust tree-sitter stack could be faster and avoid V8 WASM heap issues, but it means either finding/building equivalent grammar crates for every supported language or embedding C grammars with native build complexity. Worse, exact behavioral parity matters: node IDs, line/column ranges, unresolved references, synthesized edges, semantic relations, and context output all become compatibility surfaces.

### 5. The actual product moat is retrieval sufficiency, not implementation language

AGENTS.md is explicit: the optimization target is fewer Read/Grep/tool calls and sufficient answers from `trace`/`explore`/`context`, especially dynamic-dispatch coverage. That work lives in heuristics, graph shape, MCP output formatting, and agent ergonomics. A Rust rewrite does not automatically improve any of those. It risks freezing feature work while the team chases parity.

If a port takes months, the opportunity cost is severe: fewer framework resolvers, fewer dynamic edges, fewer installer targets, fewer benchmark loops, less MCP/tool output tuning. Those are user-visible wins. "Now written in Rust" is mostly invisible unless it measurably improves install reliability, indexing speed, memory, or crash rate.

### 6. The database boundary is portable but not the hard problem

SQLite is one of the few clean Rust candidates. `rusqlite` or `libsql` could model the schema, migrations, PRAGMAs, WAL, FTS5, and prepared query layer well. But storage is not isolated from the rest of the product: query rows map directly into TypeScript graph types, context builders, snapshot diffs, MCP output, and tests. Porting storage first gives little user benefit unless Node `node:sqlite` is a real bottleneck. The current adapter is already thin and intentionally stable.

### 7. Test and validation burden is multiplicative

A credible port would require conformance tests across:

- every public SDK method and exported type shape
- every CLI command and JSON schema
- every MCP tool schema and output format
- daemon/proxy lifecycle on macOS/Linux/Windows
- SQLite schema/migration compatibility against existing `.solidkg/` directories
- graph equivalence for real repositories, not just unit fixtures
- language extraction parity for all supported languages
- dynamic-dispatch and semantic hyperedge parity
- SCIP import/generation parity
- npm install/reinstall/uninstall/self-heal behavior
- benchmark no-regression runs showing fewer or equal Read/Grep/tool calls

This is not "rewrite then run tests." Existing tests were written against a TypeScript implementation. The port needs a golden-output compatibility suite before the rewrite starts.

## Hidden Costs and Failure Modes

- Existing `.solidkg/` data compatibility: changing schema, node IDs, path normalization, timestamps, or metadata shapes can invalidate user indexes or make snapshots/diffs noisy.
- Agent instruction drift: MCP tool descriptions, server initialize instructions, installer-written guidance, `.cursor/rules`, README, and AGENTS guidance must remain synchronized. A Rust split doubles places where behavior and docs can drift.
- Installer blast radius: installer targets manipulate JSON, JSONC, TOML, markdown, permissions, local/global paths, backups, and idempotency. Rewriting this in Rust buys little and risks every new install.
- Windows risk: current docs already call out Windows-specific symlink and MCP cleanup quirks. A native Rust daemon adds a second platform-specific process/runtime model.
- Npm ecosystem fit: SolidKG's audience installs with npm/npx and imports from JS/TS. A Rust-first package risks feeling alien unless the JS facade remains excellent.
- Debuggability: current support can inspect JS stack traces, Node version, bundled runtime, logs, and SQLite status. Native crashes require symbols, minidumps/backtraces, and target-specific triage.
- Contributor funnel: adding language support today is a TS extractor plus tests. A Rust port raises the contributor skill floor and may slow community additions.
- Dual-runtime transition: during migration, the team would maintain Node and Rust implementations, shared schemas, IPC boundaries, two test stacks, and cross-language type generation.
- Performance mirage: faster parsing may not translate to agent-visible speed if bottlenecks are resolver quality, output sufficiency, MCP host behavior, or agent tool selection.

## Where Rust Could Be Justified

Rust is worth considering only behind narrow seams with measured pain:

1. Native parser/indexer sidecar: If benchmarks show `web-tree-sitter` WASM/V8 memory, Node 25 instability, or parse throughput is the dominant user pain, build a Rust sidecar for one or two languages first. It must output the existing `ExtractionResult`/node/edge/unresolved-reference shape exactly.
2. Standalone CLI engine behind JSON protocol: If the SDK can tolerate async process-backed calls, a Rust binary could own indexing/querying while the TypeScript package remains a stable facade. This needs a versioned protocol and a hard compatibility suite.
3. SQLite query accelerator: If profiling proves query building/traversal is CPU-bound, a Rust library or binary could own specific read-only graph queries. This is lower value than parser work unless proven.
4. Release binary experiment: A Rust `solidkg` binary may simplify final artifacts after a full engine exists, but it should not be the starting point.

Any Rust slice must pass a simple gate: it improves a user-visible metric without forcing users or agents to change behavior.

## If the Team Ignores This and Ports Anyway

Minimum safe migration plan:

1. Freeze public contracts first: SDK method signatures, CLI JSON schemas, MCP tool schemas/output, SQLite schema, node/edge/hyperedge ID rules, path normalization, error shapes, and status fields.
2. Build a golden corpus: small/medium/large real repos across supported languages, with saved graph facts, context output, trace output, MCP tool responses, and benchmark prompts.
3. Keep TypeScript as the product facade until the Rust core proves parity. Do not remove `dist/index.d.ts`, npm root exports, installer behavior, or MCP tool names.
4. Port one vertical slice at a time. Start with extraction for a small language set or a read-only query engine, not installer or MCP daemon lifecycle.
5. Store the Rust boundary behind a versioned protocol. Treat IPC/schema compatibility as an API, not an internal detail.
6. Require parity and improvement before expanding. If a slice does not reduce crashes, memory, index time, or support burden, stop.
7. Only consider replacing the Node CLI/MCP process after the Rust core has survived real MCP host testing on macOS, Linux, and Windows.

## Strategic Recommendation

Required now: do not approve a mostly-Rust rewrite as a product strategy.

Required before any Rust production work: collect profiling evidence showing Node/TypeScript is the bottleneck; define stable contracts; create golden conformance tests; choose one narrow seam.

Later if pain appears: add Rust as an internal engine/sidecar for parser or query hot paths while preserving the npm/TypeScript/MCP surfaces.

The hostile bottom line: a broad Rust port optimizes for maintainer aesthetics and theoretical systems quality while putting the installed product, SDK compatibility, MCP reliability, and extraction coverage at risk. SolidKG's current edge is not that it lacks Rust. Its edge is that agents can install it easily and get sufficient graph answers without rediscovery. Protect that first.
