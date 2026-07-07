---
title: MCP Server
description: The tools SolidKG exposes to AI agents over MCP.
---

SolidKG runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Start it with:

```bash
solidkg serve --mcp
```

Agents configured by the installer launch this automatically. When a `.solidkg/` index exists, the agent uses the tools below.

MCP is the supported agent-facing graph interface. SolidKG does not provide a Studio app, browser visualization, interactive graph canvas, or graph UI. Agents should use the graph through these tools instead of expecting SolidKG to open a browser.

## Tools

The raw MCP server tool names are the documented `solidkg_*` names below. Some clients display those names with their own server prefix in UI, logs, or permission strings; that display prefix is not part of the server tool name and should not be copied into config or tool calls.

| Tool | Purpose |
|---|---|
| `solidkg_search` | Find symbols by name across the codebase |
| `solidkg_context` | Build relevant code context for a task — composes search + node + callers + callees in one call, including semantic relations and top-level returned-source coverage metadata when context output is built |
| `solidkg_trace` | Trace the call path between two symbols ("how does X reach Y") in one call — each hop with its body inline, following dynamic-dispatch hops (callbacks, React re-render, interface→impl) that grep can't; asks for a qualified/path-qualified endpoint when an unqualified callable name is ambiguous |
| `solidkg_callers` | Find what calls a function |
| `solidkg_callees` | Find what a function calls |
| `solidkg_impact` | Analyze what code is affected by changing a symbol |
| `solidkg_node` | Get details about a specific symbol (optionally with source code and semantic relations) |
| `solidkg_precise_refs` | Return SCIP definitions/references/implementation/type-definition facts when SCIP data has been generated or imported |
| `solidkg_explore` | Return source for several related symbols grouped by file, plus a relationship map, in one call; labels returned-source coverage at top level and per file (`complete`, `partial`, `omitted`, `skipped`, `unreadable`, `truncated`, including hard-truncated output cases); omits flow summaries for unanchored duplicate callable names rather than showing misleading same-name paths |
| `solidkg_files` | Get the indexed file structure, or `format="overview"` for a progressive repository map with language, symbol-kind, conservative anchor, and architecture hints |
| `solidkg_status` | Check index health, statistics, semantic relation counts, and optional SCIP import/link/generation state |
| `solidkg_snapshot` | Create, list, delete, or diff explicit graph snapshots for refactor verification |
| `solidkg_architecture` | Analyze or retrieve package/layer architecture rollups with Ca/Ce/instability metrics |

## Semantic relations

Some code relationships involve more than two symbols. Express route chains, event channels, dynamic dispatch, state updates, and native bridges are stored as ordered semantic relations, then shown inline by the tools agents already call.

Example `solidkg_context` output for an Express route:

```markdown
### Semantic Relations

- **route_binding** - src/app.ts:26
  - route: GET /widgets/:id
  - middleware: requireAuth
  - validator: validateWidget
  - handler: getWidget
```

## Capability footprints

`solidkg_trace` and `solidkg_node` also include compact capability footprints when SolidKG has evidence that a returned symbol may read config, guard auth, emit or subscribe to a channel, send to UI/native code, or perform similar effects. These are evidence packets, not runtime proof.

Coverage states (`complete`, `partial`, `unsupported`, `failed`, `not_run`, `stale`) describe the capability producers for the returned files. An empty footprint means no assertion was returned, not that the code has no capability.

`solidkg_status` reports capability assertion and producer-run counts for the current index.

## Repository overview

`solidkg_files` supports `format="overview"` for orientation questions such as “what lives where?” or “where should I start?”. The overview is derived from the current `.solidkg/` index rather than a separate filesystem scan: it rolls up files, languages, symbol counts, conservative symbol anchors, and existing architecture assignments.

Use `maxDepth`, `expandPaths`, and `maxEntries` to progressively disclose large repositories without dumping the whole tree.

## How agents should use it

SolidKG *is* the pre-built search index. For "how does X work?", architecture, trace, or where-is-X questions, an agent should answer in a handful of SolidKG calls and stop, typically with **zero file reads**, rather than re-deriving the answer with `grep` + `Read`. A direct SolidKG answer is a handful of calls; a grep/read exploration is dozens.

Make `solidkg_context` queries precise. Include concrete symbols, classes, methods, annotations, framework keywords, and file or package hints when you have them. For example, prefer anchors such as `EventPublisher`, `Consumer`, `DomainEvent`, `StreamBridge`, `@Async`, `AiTaskExecutorService`, and `AsyncConfig` over vague natural language like "async queue flow" alone.

For flow questions, start with `solidkg_trace` from the source symbol to the destination symbol. When `solidkg_context`, `solidkg_trace`, or `solidkg_node` surfaces SCIP precise-reference hints, call `solidkg_precise_refs` for compiler-grade locations instead of grepping. Treat source returned by `solidkg_explore` as already read, and use another focused explore call if you need more related symbols.

For repository orientation, call `solidkg_files` with `format="overview"` before reading directories manually. Broad minimal `solidkg_context` responses may include a compact overview when the task is clearly about repository structure or onboarding.

`solidkg_context` and `solidkg_explore` source-completeness signals describe returned source coverage only. They are not answer/path/runtime correctness signals, confidence scores, query-quality scores, or global false-path guarantees. When an answer packet says the returned context is sufficient, answer from that context instead of drilling further. When source is omitted/truncated/unreadable/skipped, prefer focused SolidKG follow-up first (for example a narrower `solidkg_explore`, qualified `solidkg_trace`, or `solidkg_node`) instead of jumping straight to broad file reads. Use solidkg_node for one specific missing symbol or hop, not as a loop over many symbols.

Ranking reasons may include `source_body_chunk` when persisted local source-body/code-token chunks seeded or boosted `solidkg_context`, `solidkg_explore`, or `solidkg_search` results. Treat this as deterministic body evidence below exact symbols, paths, trace paths, semantic relations, and SCIP facts.

External dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default. Optional hybrid extension seams remain disabled unless a future build explicitly supports and configures them; SolidKG does not require LanceDB, API keys, network calls, or telemetry for retrieval.

MCP tool calls are bounded by a server-side timeout so a slow context build returns a tool-level error instead of hanging the session. Override the default with `SOLIDKG_MCP_TOOL_TIMEOUT_MS` only when a host or repository needs a different bound.

For refactor verification, use `solidkg_snapshot` with `action=create` before the change and `action=diff` after indexing/syncing. For package and layer questions, use `solidkg_architecture` with `action=analyze`; pass `layersJson` when explicit layer rules are needed, then reuse `get`, `coupling`, or `package` actions for follow-up views.

The installer writes this guidance into each agent's instructions file automatically.
