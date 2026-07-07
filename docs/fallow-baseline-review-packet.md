# Fallow Baseline Review Packet

This packet applies Task 0 from `docs/fallow-mining-plan.md`. It is an implementation gate, not a product roadmap: each idea below must improve SolidKG's existing local-first code-intelligence surfaces without importing Fallow's dead-code, CI, editor, telemetry, licensing, or cleanup product scope.

## Adopt

| Candidate | Existing SolidKG surface | Hypothesis | Proof gate | Kill condition |
| --- | --- | --- | --- | --- |
| MCP contract drift checks | `src/mcp/tools.ts`, `__tests__/mcp-tool-allowlist.test.ts`, `__tests__/mcp-initialize.test.ts`, `__tests__/answer-packets.test.ts` | A manifest/schema test harness prevents low-salience tool drift before output changes. | Live tool names match the documented allowlist; key schemas expose expected params; suggested next tools are registered `solidkg_*` tools only. | Any check requires a new public tool or host-specific naming rule. |
| Runtime/data correctness fixtures | `src/index.ts`, `src/extraction/index.ts`, `src/db/queries.ts`, `__tests__/sync.test.ts`, `__tests__/extraction.test.ts`, `__tests__/watcher.test.ts` | SolidKG can preserve graph truth during target-only sync, oversized transitions, file removal, failed writes, and watcher lag. | Targeted sync/extraction/watcher tests pass with stale nodes removed, durable references replayed, and failed stores atomic. | Fix requires broad schema migration before a failing fixture proves current storage cannot work. |
| Path/resource guardrails | `src/extraction/index.ts`, `src/sync/watcher.ts`, `src/utils.ts`, security/path tests | Stat-before-read, max-size diagnostics, root validation, and watcher/indexer scope parity protect local-first indexing without hiding graph failures. | Oversized files are not read; skipped/tracked oversized files produce deterministic diagnostics and stale-symbol cleanup; watcher ignores match indexer defaults. | Guardrails silently drop indexed facts without stale/unknown reporting. |
| Answer/evidence enrichment on existing tools | `src/evidence/packets.ts`, `src/evidence/contracts.ts`, `src/mcp/tools.ts`, context/trace/node/explore output tests | Existing tool outputs can expose status, evidence anchors, freshness, provenance, uncertainty, blind spots, and read-only next actions without adding tools. | `answer-packets` and retrieval tests prove deterministic statuses and no raw file-tool suggestions. | Output implies absence, safety, or cleanup confidence from incomplete graph evidence. |
| Provenance/freshness discipline | `src/hypergraph`, `src/resolution`, `src/context`, `src/mcp/tools.ts`, `__tests__/hypergraph-synthesis.test.ts` | Resolver and synthesized-edge metadata can make heuristic/freshness boundaries visible to agents. | Heuristic edges remain marked; stale/catch-up states are surfaced; missing/static/heuristic provenance changes actionability. | Any persisted fact has no stale/delete path or no visible output use. |
| Narrow JS/TS resolver proof slice | `src/resolution`, `__tests__/resolution.test.ts`, `__tests__/package-exports.test.ts`, `__tests__/selective-dataflow.test.ts` | Fallow's fixture catalog is useful for package exports/imports, path aliases, extension aliases, dynamic import literals, and re-export chains behind existing APIs. | A specific failing fixture improves `trace`, `context`, `node`, or `explore` after a minimal resolver change. | Only first-hop resolution improves while downstream blind spots remain unmarked. |

## Defer

| Candidate | Reason | Revisit only if |
| --- | --- | --- |
| Runtime/test/story reachability | Product scope and data model are not SolidKG's current promise. | It becomes ranking context for existing graph evidence, not a cleanup verdict. |
| Oxc-assisted or broad resolver parity | Parser/runtime replacement is outside the plan. | A narrowly scoped JS/TS fixture cannot be solved with current extraction and resolver seams. |
| Cache model/path serialization changes | High migration risk for local indexes. | A failing path/resource fixture proves the current normalized path model cannot represent correct facts. |
| New tools such as `why_reachable` or `inspect_target` | The plan prioritizes existing agent-called tools. | Existing output enrichment is proven insufficient by an eval/probe. |

## Reject

| Candidate | Reason |
| --- | --- |
| Rust rewrite or N-API transplant | Violates SolidKG's TypeScript/Node architecture and release model. |
| Dead-code or safe-cleanup product suite | Conflicts with SolidKG's code-context purpose and risks false safety claims. |
| Security scanner, fix workflows, suppressions | Out of scope and already rejected by the plan. |
| Telemetry, licensing, cloud/runtime coverage, editor product surfaces | Product/process scope, not graph/index correctness. |
| New public MCP tools before proof | Low-salience tool-choice risk; enrich existing surfaces first. |

## Known Blocker Mapping

| Blocker | Required failing-test hypothesis | Approved implementation boundary |
| --- | --- | --- |
| Target-file-only sync drops or fails to reopen cross-file references. | A caller in one file imports/calls a target in another; changing/removing/renaming only the target preserves correct callers or reopens unresolved reference facts. | Durable source facts are allowed only if current unresolved/ref replay storage cannot pass the fixture safely. |
| Oversized tracked file leaves stale symbols. | A tracked file becomes larger than `maxFileSizeBytes`; old nodes and file record disappear or are explicitly tombstoned. | Stat before read; deterministic `size_exceeded` diagnostics; no hidden stale graph data. |
| Per-file replacement is non-atomic. | Inject failure after partial insert during `indexFiles`; old graph remains and new partial nodes do not leak. | One transaction around delete, node insert, edge insert, ref insert, and file upsert. |
| MCP startup/watch lag serves unqualified stale truth. | Pending files are visible before sync completes or output marks `stale` / `catch_up_running`. | Staleness/freshness metadata on existing outputs; no blocking startup regression. |
| Watcher scope diverges from indexer scope. | Watcher include/exclude/vendored/default-ignore behavior matches index discovery for source events. | Reuse indexer ignore policy; no separate broad watcher recursion. |

## Stop/Go Gates

Proceed through tests and fixes only when the next slice satisfies these gates:

1. Contract harness changes do not introduce new public MCP tools.
2. Correctness fixes pass the targeted red-to-green fixture without schema migration unless the fixture proves one is unavoidable.
3. Diagnostics or tombstone semantics stay deterministic and source-anchored.
4. Evidence output never says or implies `safe to delete`; acceptable language is `candidate`, `unknown`, `unresolved`, or `needs verification`.
5. Resolver work starts only after runtime/data correctness is green or explicitly marked unresolved.

## Proof Commands

```bash
pnpm exec vitest run __tests__/mcp-initialize.test.ts
pnpm exec vitest run __tests__/mcp-tool-allowlist.test.ts
pnpm exec vitest run __tests__/answer-packets.test.ts
pnpm exec vitest run __tests__/sync.test.ts
pnpm exec vitest run __tests__/extraction.test.ts -t "oversized|stale graph|failed"
pnpm exec vitest run __tests__/watcher.test.ts
pnpm exec vitest run __tests__/resolution.test.ts
pnpm exec vitest run __tests__/package-exports.test.ts
pnpm exec vitest run __tests__/selective-dataflow.test.ts
pnpm exec tsc
```
