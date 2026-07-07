# Agent graph query accelerator implementation note

## Evaluation

The FalkorDB-inspired part that fits SolidKG is the sparse, relation-aware adjacency idea: keep SQLite as the canonical graph store, then build a rebuildable in-process adjacency projection for bounded agent traversals. The rest of FalkorDB does not fit this repository: no graph database runtime, Cypher parser, planner, server, Studio UI, or human graph product.

## Existing relevant files

- `src/db/schema.sql` stores canonical `nodes`, `edges`, `hyperedges`, `hyperedge_members`, and SCIP tables in SQLite.
- `src/db/queries.ts` owns prepared SQL access, including `getAllEdges()`, `getOutgoingEdges()`, `getIncomingEdges()`, and node batch loading.
- `src/graph/traversal.ts` owns current BFS/DFS, callers, callees, impact, and path traversal.
- `src/graph/queries.ts` wraps higher-level graph queries around `GraphTraverser`.
- `src/evidence/packets.ts` already emits versioned answer packets for context/search/node/trace-style outputs.
- `src/mcp/tools.ts` exposes `solidkg_callers`, `solidkg_callees`, `solidkg_impact`, `solidkg_trace`, `solidkg_context`, `solidkg_node`, and `solidkg_explore`.
- `src/bin/solidkg.ts` exposes CLI parity for callers/callees/impact.

## Current traversal path

Agent-facing callers/callees/impact calls resolve symbols in `src/mcp/tools.ts`, then call `SolidKG.getCallers()`, `SolidKG.getCallees()`, or `SolidKG.getImpactRadius()`. The `SolidKG` facade delegates to `GraphTraverser`, which currently walks SQLite edges with repeated `getIncomingEdges()` / `getOutgoingEdges()` calls and batch node lookup.

## Implementation location

The derived index lives under `src/graph/`:

- `adjacency.ts`: relation-aware forward/reverse adjacency built from SQLite edges.
- `traversal-primitives.ts`: bounded BFS/path/impact primitives over the adjacency projection.
- `patterns.ts`: allowlisted named templates for common agent graph tasks.
- `answerPacket.ts`: compact graph traversal packet rendering for existing MCP/CLI outputs.

`GraphTraverser` remains the public traversal adapter and lazily rebuilds the adjacency projection from SQLite when the graph revision changes.

## Existing surfaces enriched first

Initial enrichment is intentionally narrow:

- `solidkg_callers`
- `solidkg_callees`
- `solidkg_impact`
- existing TypeScript API methods behind those tools

`trace`, `context`, `node`, and `explore` already have answer packet and source-sufficiency work; they should use the new primitives only after separate trace-specific regression measurement.

## Exact non-goals

- No graph database dependency.
- No Redis, FalkorDB, Neo4j, GraphQL, Cypher, SQL exposure, web server, or Studio UI.
- No Rust rewrite.
- No LLM-generated graph topology.
- No semantic/vector result creating or overriding deterministic edges.
- No schema churn unless a later measured freshness gap proves it necessary.
- No broad new public MCP query language.
