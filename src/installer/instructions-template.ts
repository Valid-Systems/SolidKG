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

This project has a SolidKG MCP server configured. SolidKG is a tree-sitter-parsed knowledge graph of source files, symbols, relationships, and line-numbered source.

### Default workflow

The default MCP profile exposes only \`solidkg_explore\`, the answer-producing tool. Give it a natural-language structural question or precise symbol/file/code terms. It returns the best production source grouped by file, relationship and flow evidence, dynamic-dispatch links, and an answer packet.

ONE call usually answers a structural question. Treat returned source as already Read. Do not re-open shown files with Read/Grep, and do not call \`solidkg_explore\` again unless the question needs a different named symbol or file.

- **Interpret source completeness narrowly.** Source-completeness fields are returned-source coverage only, not answer/path/runtime correctness, confidence, query quality, or global false-path guarantees. Omitted peripheral candidates and bounded windows do not make selected evidence unusable.
- **Stop on sufficient evidence.** When an answer packet says the returned context is sufficient, answer from that context instead of drilling further.
- **Follow up only for a real blocker.** Another graph call is warranted for missing required anchors, stale or unreadable required source, no results, no static path, or explicit endpoint ambiguity. Do not follow up solely because candidate coverage is partial, omitted, or truncated.
- **Prefer SolidKG over broad grep/read loops.** Fall back to targeted Read only when the answer packet is insufficient because required source is stale, unreadable, or absent.
- **Natural language is not symbol ambiguity.** Generic words such as "send" or "request" in a prose question do not become flow endpoints. Explicit unqualified duplicate symbols still require a qualified or path-qualified name.
- **Exclusions are constraints.** Phrases such as "not tests" or "excluding generated metadata" are not positive search terms. \`missing_query_concept\` means explicit counterfactual concepts were not all evidenced, so the packet is intentionally partial.
- **Index lag.** When a response names files pending re-index, Read only those stale files. Files not listed in the staleness banner remain graph-fresh.

The raw MCP server tool names use \`solidkg_*\`. Some clients display a host-specific server prefix around those names; do not add another \`solidkg_\` prefix in calls.

### Advanced profile

Set \`SOLIDKG_MCP_TOOLS=all\` on the MCP server to expose every advanced graph tool. Explicit comma-separated names remain supported for custom profiles.

| Need | Advanced tool |
|---|---|
| Exact call path | \`solidkg_trace\` inlines each hop's body/source and destination callees in one call |
| Exact symbol references | \`solidkg_precise_refs\` uses optional SCIP facts |
| One missing symbol or hop | \`solidkg_node\`. Use solidkg_node for one specific missing symbol or hop, not as a loop over many symbols |
| Callers / callees / impact | \`solidkg_callers\`, \`solidkg_callees\`, \`solidkg_impact\` |
| Search / context / status | \`solidkg_search\`, \`solidkg_context\`, and \`solidkg_status\` (including SCIP import/link/generation state) |
| Repository map | \`solidkg_files\` with \`format: "overview"\`, derived from the index |
| Refactor graph diff | \`solidkg_snapshot\` before and after indexing |
| Package/layer coupling | \`solidkg_architecture\` |

Capability footprints in \`solidkg_trace\` and \`solidkg_node\` are may-behavior evidence, not runtime proof. Coverage states (\`complete\`, \`partial\`, \`unsupported\`, \`failed\`, \`not_run\`, \`stale\`) describe producer coverage; empty assertions do not prove no capability exists.

### Retrieval extensions

- Source-body chunk retrieval is local and deterministic: persisted source-body/code-token chunks can seed or boost results with visible \`source_body_chunk\` ranking evidence. Exact symbols, paths, flow evidence, semantic relations, and SCIP facts remain higher-salience.
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
