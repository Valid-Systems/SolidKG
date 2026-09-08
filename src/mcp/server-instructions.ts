/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients and supported agent hosts surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the solidkg toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when solidkg_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# SolidKG: code intelligence over an indexed knowledge graph

SolidKG is a local SQLite graph of source files, symbols, relationships, and
line-numbered source. Use it before filesystem search for structural questions.

## One default tool: solidkg_explore

The compact MCP profile exposes one answer-producing tool: \`solidkg_explore\`.
It accepts either a natural-language question or precise symbol/file names and
returns the relevant verbatim, line-numbered source grouped by file, plus call
paths, dynamic-dispatch links, and blast-radius context where available.

ONE call usually answers a structural question. Treat every returned source
block as already Read. Call \`solidkg_explore\` again only when the question needs
a different named symbol or file; do not re-read shown files with Read/Grep.

Source-completeness fields are returned-source coverage only, not answer/path/runtime
correctness, confidence, query quality, or global false-path guarantees.
When the answer packet says the selected evidence is sufficient, answer from it
even if peripheral candidates were omitted or source windows were bounded.
Explicit exclusions such as "not tests" or "excluding generated metadata" are
retrieval constraints, not positive search terms. A \`missing_query_concept\`
uncertainty label means the returned source did not cover every explicit
counterfactual concept, so the packet is intentionally partial.
Ask \`solidkg_explore\` explicit questions such as "Show repository architecture
health" or "What architecture health drifted since snapshot baseline?". A drift
label in an explore question must match one saved snapshot label exactly,
including case.
Do not follow up solely because candidate coverage is partial, omitted, or
truncated. Prefer SolidKG over broad grep/read loops. Fall back to targeted Read
only when the answer packet is insufficient because required source is stale,
unreadable, or absent.

The raw MCP server tool names use \`solidkg_*\`; this profile exposes
\`solidkg_explore\`. A client may display a host-specific server prefix around it;
do not add another \`solidkg_\` prefix in calls.

Set \`SOLIDKG_MCP_TOOLS=all\` on the MCP server to expose the full advanced tool
surface for explicit trace, impact, SCIP, snapshot, and architecture workflows.
`;

export const FULL_SERVER_INSTRUCTIONS = `# SolidKG: code intelligence over an indexed knowledge graph

SolidKG is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during.

## Answer directly — don't delegate exploration

For ordinary structural questions, call \`solidkg_explore\` with the natural-
language question or precise symbol/file terms and answer from one sufficient
result. Use the advanced tools below only for an explicit trace, impact, SCIP,
snapshot, architecture, status, or one-symbol workflow.
SolidKG IS the pre-built search index — so delegating the lookup to a
separate file-reading sub-task/agent, or running your own grep + read
loop, repeats work solidkg already did and costs more for the same
answer. Reach for raw Read/Grep only to confirm a specific detail
solidkg didn't cover. A direct solidkg answer is typically a handful
of calls; a grep/read exploration is dozens.

## Tool selection by intent

The raw MCP server tool names are the documented \`solidkg_*\` names below.
Some clients display a host-specific server prefix around those names in their UI
or permission strings; do not add another \`solidkg_\` prefix when calling tools.

- **"What is the symbol named X?"** → \`solidkg_search\`
- **"What's the deal with this task / feature / area?"** -> \`solidkg_context\` (PRIMARY, composes search + node + callers + callees in one call; include concrete symbol/class/method/annotation/framework keywords in the query)
- **"How does this area work? / show related production source."** -> \`solidkg_explore\` (PRIMARY answer tool for natural-language questions or precise names; one call returns ranked source and graph evidence)
- **"How does X reach/become Y? / trace the flow / the path from X to Y"** -> \`solidkg_trace\` (ONE call returns the whole call path with each hop's body/source inlined, plus the destination symbol's outgoing callees; it already bridges dynamic-dispatch hops like callbacks, React re-render, and JSX children that grep can't follow)
- **"What calls this?"** → \`solidkg_callers\`
- **"What does this call?"** → \`solidkg_callees\`
- **"What would changing this break?"** → \`solidkg_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`solidkg_node\` (includes semantic relations touching the symbol)
- **"Show exact definitions/references for X."** → \`solidkg_precise_refs\` when SCIP data is present (accepts a node ID from search/node output or a symbol name)
- **"What's in directory X? / what lives where?"** → \`solidkg_files\` (use \`format: "overview"\` for a progressive repository map with language, symbol-kind, conservative anchor, and architecture hints)
- **"Is the index ready / what's its size?"** → \`solidkg_status\` (includes semantic relation counts plus SCIP import/link/generation state)
- **"Save/diff the graph or compare saved health."** → \`solidkg_snapshot\`; use \`action="drift"\` and an exact snapshot label for health drift
- **"Show package/layer coupling or architecture health."** → \`solidkg_architecture\`; use \`action="health"\` for health

## Common chains

- **Flow / "how does X reach Y"**: \`solidkg_trace\` from -> to FIRST. One call returns the entire path with each hop's body/source inlined and the destination symbol's outgoing callees already included. Use a second source-oriented lookup only for additional related symbols/source, not for hop bodies. Do NOT reconstruct the path with \`solidkg_search\` + \`solidkg_callers\`, that's exactly what trace does in a single call.
- **Code Context query precision**: when calling \`solidkg_context\`, name concrete symbols, classes, methods, annotations, and framework keywords from the task. Add likely anchors even if you are not sure all exist. This keeps the context focused and prevents vague task descriptions from drifting to unrelated symbols.
- **Ambiguous flow endpoints**: if \`solidkg_trace\` reports multiple callable symbols for an unqualified name, retry with the qualified or path-qualified form shown in the candidates. The source-surfacing tool may omit its Flow section for duplicate unqualified names rather than show a misleading same-name path.
- **Onboarding**: call \`solidkg_explore\` with the repository question. Use \`solidkg_files format="overview"\` only when an explicit repository map is required.
- **Repository orientation**: call \`solidkg_files\` with \`format: "overview"\` before reading directories manually. The overview is derived from the index and stays budgeted with \`maxDepth\`, \`expandPaths\`, and \`maxEntries\`.
- **Source completeness interpretation**: \`solidkg_context\` and \`solidkg_explore\` source-completeness fields describe returned source coverage only. They are not answer/path/runtime correctness, confidence, query-quality, or global false-path guarantees.
- **Answer packet interpretation**: answer packets are deterministic returned-context metadata: evidence anchors, ranking reasons, binary sufficiency, suggested next SolidKG tools, and bounded uncertainty labels. Ranking reasons may include \`source_body_chunk\` when persisted source-body/code-token chunks seeded or boosted a result; exact symbol/path/trace evidence remains higher-salience than body-only evidence. When an answer packet says the returned context is sufficient, answer from that context instead of drilling further. Use them to decide whether to answer or make a focused SolidKG follow-up; they are not proof of runtime correctness.
- **Counterfactual query constraints**: phrases such as "not tests" and "excluding generated metadata" are treated as exclusions rather than positive retrieval terms. When returned source misses an explicit concept in that kind of query, \`solidkg_explore\` returns a partial packet with \`missing_query_concept\` instead of claiming sufficiency.
- **Capability footprint interpretation**: when \`solidkg_trace\` or \`solidkg_node\` includes a Capability footprint section, treat it as evidence about may-read/write/guard/emit/subscribe/send/mutate behavior, not proof of runtime execution. Coverage states (\`complete\`, \`partial\`, \`unsupported\`, \`failed\`, \`not_run\`, \`stale\`) describe capability-producer coverage for the returned files; empty assertions do not prove no capability exists.
- **Calibrated trust**: source-completeness fields are coverage metadata. When the packet is sufficient, answer even if peripheral candidates were omitted or windows were bounded. Do not follow up solely because coverage is partial, omitted, or truncated.
- **When evidence is insufficient**: use one focused advanced call only for missing required anchors, stale/unreadable required source, no results/path, or explicit endpoint ambiguity. Fall back to targeted Read only when required source is stale, unreadable, or absent.
- **Refactor planning**: \`solidkg_search\` → \`solidkg_callers\` → \`solidkg_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Refactor verification**: \`solidkg_snapshot\` action=create before the change, then action=diff after indexing/syncing to see added/removed/changed nodes, edges, hyperedges, and hyperedge members.
- **Architecture rollup**: \`solidkg_architecture\` action=analyze with explicit layer rules when you need layers; action=get/coupling/package reuses the last analyzed report.
- **Architecture health**: \`solidkg_architecture\` action=health returns deterministic structural findings, metrics, evidence anchors, and per-signal coverage. It is not a score, grade, severity, runtime verdict, or dead-code proof. Static unreferenced results are candidates, and coverage can be partial or not run.
- **Snapshot health drift**: \`solidkg_snapshot\` action=drift always returns graph-diff counts and compares saved/current findings only when the analysis is compatible. Its comparison is \`comparable\`, \`partially_compatible\`, \`incompatible_analysis\`, or \`baseline_analysis_unavailable\`; incompatible or unavailable analysis does not produce a guessed finding comparison.
- **Read-only health and drift**: health and drift reads use read-only handles and require schema 11. If an existing index needs a schema upgrade, run \`solidkg sync <project>\` once with write access. Then retry the read. Human and MCP output caps each finding or delta category at 20 items and reports the remainder. CLI \`--json\` and API values remain complete.
- **Debugging a regression**: \`solidkg_callers\` of the suspected symbol; widen with \`solidkg_impact\` if an unexpected call appears.

## Retrieval extensions

- Source-body chunk retrieval is local and deterministic: indexed symbol bodies can seed or boost \`solidkg_context\`, \`solidkg_explore\`, and \`solidkg_search\` results, with visible \`source_body_chunk\` ranking evidence when it contributes.
- External dense/vector embeddings, vector databases, rerankers, and hybrid retrieval providers are not enabled by default. Optional hybrid extension seams remain disabled unless a future build explicitly supports and configures them; do not assume LanceDB, API keys, network calls, or telemetry are active.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name. \`solidkg_search\` is faster and returns kind + location + signature.
- **Don't chain \`solidkg_search\` + \`solidkg_node\`** when you just want context. \`solidkg_context\` is one round-trip.
- **Don't loop \`solidkg_node\` over many symbols**. One \`solidkg_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use solidkg_node for one specific missing symbol or hop, not as a loop over many symbols.
- **Don't re-read source returned by \`solidkg_explore\`.** Treat it as already read. Use another focused \`solidkg_explore\` call if you need more symbols from the same area.
- **Don't flatten Semantic Relations back into pairwise edges.** When \`solidkg_context\` or \`solidkg_node\` returns a Semantic Relations section, use it as the ordered relationship shape (for example route → middleware → validator → handler).
- **Use SCIP facts when surfaced.** When \`solidkg_context\`, \`solidkg_trace\`, or \`solidkg_node\` mentions SCIP precise refs, call \`solidkg_precise_refs\` for exact compiler-grade locations instead of grepping for definitions/references.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner remains graph-fresh. \`solidkg_status\` also lists pending files under "Pending sync".

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- SCIP data is optional and additive; if no SCIP index file was generated or imported, precise refs sections simply won't appear.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. SolidKG supplements those with structural context they don't have.
`;

export function getServerInstructions(): string {
  const configuredTools = process.env.SOLIDKG_MCP_TOOLS?.trim();
  if (!configuredTools) return SERVER_INSTRUCTIONS;
  const tools = configuredTools
    .split(',')
    .map((tool) => tool.trim().replace(/^solidkg_/, ''))
    .filter((tool) => tool.length > 0);
  return tools.length === 1 && tools[0] === 'explore'
    ? SERVER_INSTRUCTIONS
    : FULL_SERVER_INSTRUCTIONS;
}
