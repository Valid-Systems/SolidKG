/**
 * Agent-instructions template, the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / solidkg.mdc / etc.).
 *
 * The body content is identical across agents because the solidkg
 * usage advice is agent-agnostic. Only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const SOLIDKG_SECTION_START = '<!-- SOLIDKG_START -->';
export const SOLIDKG_SECTION_END = '<!-- SOLIDKG_END -->';
export const LEGACY_CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const LEGACY_CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 */
export const INSTRUCTIONS_TEMPLATE = `${SOLIDKG_SECTION_START}
## SolidKG

This project has a SolidKG MCP server (\`solidkg_*\` tools) configured. SolidKG is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer solidkg over native search

Use solidkg for **structural** questions: what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

The raw MCP server tool names are the documented \`solidkg_*\` names below. Some clients display a host-specific server prefix around those names in their UI or permission strings; do not add another \`solidkg_\` prefix when calling tools.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | \`solidkg_search\` |
| "What calls function Y?" | \`solidkg_callers\` |
| "What does Y call?" | \`solidkg_callees\` |
| "How does X reach/become Y? / trace the flow from X to Y" | \`solidkg_trace\` (one call = the whole path, with each hop's body/source inlined and the destination's outgoing callees) |
| "What would break if I changed Z?" | \`solidkg_impact\` |
| "Show me Y's signature / source / docstring" | \`solidkg_node\` |
| "Show exact definitions/references for Y" | \`solidkg_precise_refs\` when SCIP data is present |
| "Give me focused context for a task/area" | \`solidkg_context\` (use \`detailLevel: "minimal"\` for broad first-pass orientation; use standard/full context for implementation, debugging, or source inspection) |
| "See several related symbols' source at once" | \`solidkg_explore\` (treat returned source as already read; output labels returned-source coverage at top level and per file) |
| "What files exist under path/" / "what lives where?" | \`solidkg_files\` (use \`format: "overview"\` for a progressive repository map with language, symbol-kind, conservative anchor, and architecture hints) |
| "Is the index healthy?" | \`solidkg_status\` (includes semantic relation counts plus SCIP import/link/generation state) |
| "Save/diff the graph before a refactor" | \`solidkg_snapshot\` |
| "Show package/layer coupling" | \`solidkg_architecture\` |

### Rules of thumb

- **Answer directly, don't delegate exploration.** For broad "how does X work" / architecture questions, start with \`solidkg_context\` using \`detailLevel: "minimal"\`, then use ONE \`solidkg_explore\` for the source of the symbols it surfaces when source is needed. For detailed implementation or debugging work, use standard/full context instead of minimal. For a specific **flow** ("how does X reach Y") start with \`solidkg_trace\` from -> to. One call returns the whole path, with each hop's body/source inlined and the destination's outgoing callees. Use the trace result directly. SolidKG IS the pre-built index, so spawning a separate file-reading sub-task/agent or running a grep + read loop repeats work solidkg already did and costs more for the same answer.
- **Make Code Context queries precise.** When calling \`solidkg_context\`, include concrete symbols, classes, methods, annotations, framework keywords, and file or package hints from the task. Prefer anchors like \`EventPublisher\`, \`Consumer\`, \`DomainEvent\`, \`StreamBridge\`, \`@Async\`, \`AiTaskExecutorService\`, and \`AsyncConfig\` over vague natural language like "async queue flow" alone.
- **Choose context detail by task depth.** Use \`detailLevel: "minimal"\` for first-pass orientation, scoping, and choosing next tools. Use the default standard detail, explicit \`includeCode\`, or \`solidkg_explore\` when you need implementation details, debugging evidence, or source inspection.
- **Use overview for repository orientation.** Call \`solidkg_files\` with \`format: "overview"\` before reading directories manually. It is derived from the current index and stays budgeted with \`maxDepth\`, \`expandPaths\`, and \`maxEntries\`.
- **Interpret source completeness narrowly.** In \`solidkg_context\` and \`solidkg_explore\`, source-completeness fields are returned-source coverage only, not answer/path/runtime correctness, confidence, query quality, or global false-path guarantees.
- **Interpret answer packets narrowly.** Answer packets are deterministic returned-context metadata: evidence anchors, ranking reasons, binary sufficiency, suggested next SolidKG tools, and bounded uncertainty labels. Ranking reasons may include \`source_body_chunk\` when persisted source-body/code-token chunks seeded or boosted a result; exact symbol/path/trace evidence remains higher-salience than body-only evidence. When an answer packet says the returned context is sufficient, answer from that context instead of drilling further. Use them to decide whether to answer or make a focused SolidKG follow-up; they are not proof of runtime correctness.
- **Interpret capability footprints narrowly.** When \`solidkg_trace\` or \`solidkg_node\` includes a Capability footprint section, treat it as may-behavior evidence (read/write/guard/emit/subscribe/send/mutate), not runtime proof. Coverage states (\`complete\`, \`partial\`, \`unsupported\`, \`failed\`, \`not_run\`, \`stale\`) describe capability-producer coverage for returned files; empty assertions do not prove no capability exists.
- **Qualify duplicate flow names.** If \`solidkg_trace\` reports multiple callable symbols for an unqualified name, retry with the qualified or path-qualified candidate. \`solidkg_explore\` may omit its Flow section for duplicate unqualified names rather than show a misleading same-name path.
- **Prefer SolidKG over broad grep/read loops.** Fall back to targeted Read only when SolidKG reports stale, truncated, omitted, unreadable, ambiguous, or heuristic-only results.
- **Don't grep first** when looking up a symbol by name. \`solidkg_search\` is faster and returns kind + location + signature in one call.
- **Don't chain \`solidkg_search\` + \`solidkg_node\`** when you just want context. \`solidkg_context\` is one call.
- **Don't loop \`solidkg_node\` over many symbols**. One \`solidkg_explore\` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more. Use solidkg_node for one specific missing symbol or hop, not as a loop over many symbols.
- **Don't re-read source returned by \`solidkg_explore\`.** Treat returned source as already read. Use another focused \`solidkg_explore\` call if you need more related symbols.
- **When source is omitted/truncated/unreadable/skipped, do focused SolidKG follow-up first.** Narrow \`solidkg_explore\`, qualify \`solidkg_trace\`, or use targeted \`solidkg_node\` before broad Read fallback.
- **Use the Semantic Relations section.** When \`solidkg_context\` or \`solidkg_node\` returns semantic relations, treat them as the ordered relationship shape, for example route -> middleware -> validator -> handler, instead of reconstructing that shape from pairwise edges.
- **Use SCIP precise refs when surfaced.** When \`solidkg_context\`, \`solidkg_trace\`, or \`solidkg_node\` mentions SCIP precise refs, call \`solidkg_precise_refs\` with the shown node ID or symbol for exact compiler-grade definitions/references instead of grepping.
- **Use snapshots for refactor verification.** Call \`solidkg_snapshot\` with action=create before a refactor, then action=diff after indexing/syncing to see added/removed/changed nodes, edges, hyperedges, and hyperedge members.
- **Use architecture rollups for package/layer questions.** Call \`solidkg_architecture\` action=analyze with explicit layer rules when you need layers; action=get/coupling/package reuses the last analyzed report.
- **Index lag — check the staleness banner, don't guess a wait.** When a solidkg response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Files NOT in that banner are fresh and solidkg is authoritative for them. \`solidkg_status\` also lists pending files under "Pending sync".

### Retrieval extensions

- Source-body chunk retrieval is local and deterministic: indexed symbol bodies can seed or boost \`solidkg_context\`, \`solidkg_explore\`, and \`solidkg_search\` results, with visible \`source_body_chunk\` ranking evidence when it contributes.
- External dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default. Optional hybrid extension seams remain disabled unless a future build explicitly supports and configures them; do not assume LanceDB, API keys, network calls, or telemetry are active.

### If \`.solidkg/\` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have SolidKG initialized. Want me to run \`solidkg init -i\` to build the index?"*
${SOLIDKG_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
