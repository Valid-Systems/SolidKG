# Code Mapper Capability Footprint Integration Plan

Plan generated from hyperplan team bundle, plan-agent sequencing, and external verifier review; no implementation performed.

## Context

This plan covers how to integrate useful concepts from `D:\Apps\Programming_Tools\code-mapper` into SolidKG's agent-only MCP code intelligence scope. The goal is better LLM agent sufficiency, not human visualization.

Code-mapper contributes a useful conceptual split: deterministic graph facts plus optional semantic annotation. Its transferable ideas are dependency/call graphs, focus neighborhoods, optional annotations with `summary`, `writes`, `reads`, `config`, `auth`, and `flows`, plus flow-level footprint aggregation. SolidKG already has the stronger substrate: tree-sitter extraction, SCIP facts, SQLite storage, graph traversal, semantic hyperedges, answer packets, and MCP tools.

The verifier approved the direction with required changes: the original `CapabilityKind` taxonomy mixed operations, domains, and presentation categories; provenance conflated origin with certainty; node-level aggregation could overstate path-specific behavior; and lifecycle/absence semantics were underspecified. This revision makes those constraints first-class.

## Non-Goals

- Do not implement code-mapper's web UI, Obsidian vault, Markdown note workflow, or human visualization flow.
- Do not let LLM annotations create topology: no call, import, reference, contains, ranking, path-selection, or hyperedge truth from annotations.
- Do not add a new MCP tool in phase 1 unless existing tools cannot expose the capability packet cleanly.
- Do not make a TypeScript-only integration. Every concept must fit SolidKG's language extractor, resolver, framework, SCIP, or hypergraph extension points.
- Do not rely on agents learning a new query style as the primary success mechanism.
- Do not store free-form `flow_hint` as normalized fact data. Deterministic flows belong to paths and hyperedges; LLM flow prose belongs to annotation storage.
- Do not store `side_effect` as a fact kind. It is a derived presentation category.

## Core Decisions

1. Add a provenance-labeled capability assertion layer over existing nodes, semantic relations, hyperedges, and traces.
2. Use orthogonal fields for operation and resource domain, not a single mixed taxonomy.
3. Keep graph topology separate from capability evidence.
4. Surface compact capability packets first in existing `solidkg_trace` and `solidkg_node`, then `solidkg_context`, and only later `solidkg_explore` if evaluation proves value.
5. Add capability coverage as a separately versioned output contract, for example `solidkg.capability-footprint.v1`, rather than silently expanding existing answer-packet semantics.
6. Use two provenance axes: origin and certainty.
7. Describe trace aggregates as may-effects from functions or relations on the returned static path unless evidence is callsite- or relation-scoped.
8. Implement a small vertical slice before broad schema/tool rollout: config-read producer plus query-time projection of existing hyperedges into `trace` and `node`.
9. Implement optional cached LLM annotations last, behind egress, invariance, and prompt-injection gates.

## Revised Fact Contract

Use one row per evidence assertion. Deduplicate semantically at query time so multiple independent supports preserve their own provenance.

```typescript
type CapabilityOperation =
  | 'read'
  | 'write'
  | 'guard'
  | 'emit'
  | 'subscribe'
  | 'send'
  | 'mutate';

type CapabilityResourceKind =
  | 'datastore'
  | 'config'
  | 'auth'
  | 'channel'
  | 'filesystem'
  | 'network'
  | 'process'
  | 'state'
  | 'ui';

type CapabilityOrigin =
  | 'ast'
  | 'scip'
  | 'framework_resolver'
  | 'semantic_synthesis'
  | 'annotation';

type CapabilityCertainty =
  | 'precise'
  | 'static'
  | 'heuristic'
  | 'unverified';

type CapabilityScope =
  | 'node_scoped'
  | 'callsite_scoped'
  | 'relation_scoped';

interface CapabilityAssertion {
  id: string;
  subjectNodeId: string;
  operation: CapabilityOperation;
  resourceKind: CapabilityResourceKind;
  resourceKey: string;
  targetNodeId?: string;
  scope: CapabilityScope;
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  origin: CapabilityOrigin;
  certainty: CapabilityCertainty;
  producerId: string;
  ruleId: string;
  producerVersion: string;
  supportingHyperedgeId?: string;
  metadata?: BoundedValidatedMetadata;
}
```

### Contract Rules

- `read` and `write` describe operations. `config`, `auth`, and `channel` are resource kinds.
- `side_effect` is derived from operation/resource combinations during presentation.
- `flow_hint` is not a normalized fact. Annotation flow prose stays in annotation storage and is excluded by default.
- `origin` records where evidence came from. `certainty` records reliability. Reproducible rules can still be heuristic.
- Avoid numeric confidence unless calibrated per rule. Never store model self-confidence.
- Include `producerId`, `ruleId`, and `producerVersion` for invalidation and audit.
- Do not use `edge_id` in v1. SQLite edge IDs are not stable public identifiers across deletion and re-indexing. Use node IDs, source ranges, semantic relation IDs, and hyperedge IDs where stable enough.
- Existing hyperedges such as `event_channel`, `route_binding`, `ui_render`, `dynamic_dispatch`, and `native_bridge` should be projected into capability output at query time before duplicating them as persisted assertions.

## Coverage And Lifecycle Contract

An empty assertion set is not evidence that a file, function, or path has no capability. Store producer coverage separately.

```typescript
interface CapabilityAnalysisRun {
  filePath: string;
  producerId: string;
  producerVersion: string;
  sourceHash: string;
  status: 'complete' | 'partial' | 'unsupported' | 'failed';
  diagnostics?: string;
}
```

Lifecycle requirements:

- Stable assertion IDs are content hashes over subject node, operation, resource kind/key, scope, source range, origin, producer ID, rule ID, producer version, and relevant support IDs.
- Per-file deletion must remove stale assertions and producer-run records for that file.
- `clear` must clear assertions and producer-run records.
- Re-indexing must be idempotent.
- Producer-version changes invalidate affected assertions.
- Framework detection changes invalidate framework-derived assertions.
- Post-resolution producers must invalidate when dependency or SCIP context changes.
- Snapshots, exports, status, and statistics must either include capability counts explicitly or state that capabilities are excluded.
- Output must distinguish `complete`, `partial`, `unsupported`, `failed`, `not_run`, and `stale` coverage states.

## Trace Semantics

Trace output must not imply branch-precise runtime flow unless evidence supports that claim.

Rules:

- Show capability assertions per hop before showing a deduplicated aggregate.
- Call the aggregate a may-footprint unless all included facts are callsite- or relation-scoped to the returned path.
- Distinguish `node_scoped`, `callsite_scoped`, and `relation_scoped` evidence in output.
- Never silently include capabilities from off-path callers, callees, or neighboring hyperedges.
- Existing topology frontier and capability coverage are separate concepts.
- Capabilities must not alter trace path selection or `bounded_no_static_path` behavior.

## Tool Surface Strategy

### `solidkg_trace`

Highest-value surface. Return:

1. The unchanged deterministic path.
2. Per-hop capability evidence.
3. A deduplicated may-footprint.
4. Capability-analysis coverage separate from path/source completeness.
5. Existing topology frontier separate from capability coverage.

### `solidkg_node`

Return local capability assertions for the node. Do not merge caller/callee capabilities into the node's own footprint. Related capabilities may appear in a separate, clearly labeled section.

Adding capability evidence is also an opportunity to normalize successful `solidkg_node` output with answer-packet-style metadata, but that should be explicitly versioned.

### `solidkg_context`

Include a compact, query-relevant summary:

- top deduplicated assertions
- source anchors
- origin and certainty counts
- coverage and truncation status

For `detailLevel="minimal"`, return counts and a few top facts rather than a full per-node listing.

### `solidkg_explore`

Defer detailed enrichment. It is source-heavy and capped. Initially include at most one compact summary for returned nodes. Add richer output only if A/B evaluation proves it reduces total agent context and follow-up reads.

### New Tool Decision

Do not add `solidkg_capabilities` in phase 1. Reconsider only if existing tools become too noisy or cannot answer direct capability-only questions without context bloat.

## Deterministic Producer Strategy

Use an explicit support and precision matrix, not a vague "where feasible" target.

Initial v1 producers:

- Config reads: explicit environment/config APIs across several language families.
- Auth guards: only frameworks where existing resolvers already understand middleware, guards, decorators, or ordered route chains.
- Channels and semantic flows: query-time projection from existing hyperedges before adding new producer logic.
- Database reads/writes: only when receiver, API, decorator, or SCIP type identifies a known datastore operation.

Deferred producers:

- Bare-name rules for `get`, `find`, `save`, `update`, and `delete`.
- Broad generic side-effect detection.
- Branch-sensitive local dataflow.

Producer registry fields:

- supported languages and frameworks
- extraction, post-resolution, SCIP, or semantic-synthesis phase
- rule and producer versions
- invalidation scope
- closed-world or open-world coverage semantics
- precision fixtures

Two-stage architecture:

1. Local AST producers emit assertions that need only syntax and local source ranges.
2. Post-resolution producers emit assertions requiring resolved receivers, route chains, semantic hyperedges, or SCIP facts.

## Optional LLM Annotation Strategy

Annotations are separate from deterministic and heuristic assertions. They are disabled by default and excluded from default query APIs.

Requirements:

- Network-disabled default.
- Explicit per-project remote-provider consent.
- Visible provider, model, and endpoint.
- Source-path deny rules for secrets, `.env`, vendor, generated, and sensitive directories.
- Redaction and payload-size limits.
- Audit manifest recording files, byte counts, provider, model, endpoint, prompt version, and redaction policy.
- Strict bounded output schemas.
- Source-code prompt-injection tests.
- Separate annotation storage or namespace.
- Default query APIs exclude annotations.

Annotation cache keys must include every prompt input and policy dimension:

- schema version
- prompt version
- provider
- model
- endpoint or model revision
- source hash
- graph/dependency-context hash
- redaction policy

Hard invariance gate: enabling annotations must leave nodes, edges, hyperedges, path selection, ranking, and deterministic answer sufficiency unchanged.

## Revised Phase Order

| Phase | Purpose | Exit Criteria |
| --- | --- | --- |
| 1. Contract and invariants | Taxonomy, provenance axes, path semantics, coverage states, annotation threat model, output budgets. | Contract accepted; topology invariance and absence semantics explicit. |
| 2. Predeclare evaluation | Fixtures, ground truth, target/control/negative prompts, pass thresholds. | Eval protocol can run before implementation as baseline. |
| 3. Storage and lifecycle | Migration, stable IDs, producer runs, invalidation, deletion, schema-versioned output contracts. | Idempotent storage and lifecycle tests designed. |
| 4. Thin vertical slice | Config-read producer plus query-time projection of existing hyperedges; expose only through `trace` and `node`. | Targeted tests pass; outputs remain compact. |
| 5. Agent-eval gate | Capability-off versus capability-on using identical topology. | No Read/Grep or correctness regression; target prompts improve. |
| 6. Producer expansion | Auth and typed datastore rules. | Precision fixtures pass; unsupported states are visible. |
| 7. Context enrichment | Add compact `context` output after trace/node pass. | Minimal and standard context outputs remain budget-safe. |
| 8. Conditional explore enrichment | Add only if A/B eval proves value. | Source-heavy output does not increase total agent context. |
| 9. Optional annotations | Add only behind egress and invariance gates. | Annotation output isolated, opt-in, and excluded by default. |

## Task Dependency Graph

| Task | Depends On | Dependents | Purpose |
| --- | --- | --- | --- |
| 1. Contract And Invariants | None | 2, 3, 4, 6, 9 | Define taxonomy, provenance, path semantics, and non-goals. |
| 2. Evaluation Contract | 1 | 5, 8 | Predeclare target/control/negative prompts and pass bars. |
| 3. Storage And Lifecycle | 1 | 4, 5, 6 | Store assertions and producer-run coverage safely. |
| 4. Thin Vertical Slice | 2, 3 | 5, 6 | Implement config-read plus hyperedge projection through trace/node. |
| 5. Repo-Native Tests | 3, 4 | 8 | Lock schema, lifecycle, output, and invariance behavior. |
| 6. Trace And Node Output | 3, 4 | 7, 8 | Surface first capability packet in high-value tools. |
| 7. Context Output | 6 | 8 | Add compact query-relevant summaries after trace/node succeed. |
| 8. Agent Eval Gates | 2, 5, 6, 7 | 10 | Prove behavior improves without correctness regression. |
| 9. Optional Annotation Design | 1 | 10 | Design isolated, opt-in annotation storage and threat model. |
| 10. Optional Annotation Implementation | 8, 9 | None | Implement only if deterministic layer passes gates. |

## Testing And Eval Gates

Use three arms on the same graph and index:

1. Current SolidKG, capability output disabled.
2. Deterministic capability output enabled.
3. Optional annotation output enabled as a separate later arm.

Prompt classes:

- Positive capability/flow questions with curated expected facts and source anchors.
- Structural control questions where capabilities should not affect the answer.
- Negative or unsupported questions testing whether agents mistake missing evidence for absence.

Measure:

- final-answer correctness and expected-evidence coverage
- unsupported or overconfident claims
- correct handling of provenance and partial coverage
- returned and used capability assertion IDs
- Read/Grep/Bash fallback
- total tool calls, tokens, response bytes, duration, and cost
- producer precision and recall independent of agent behavior

Two runs per arm are smoke tests, not proof. Use paired, randomized runs with enough repetitions to exceed known benchmark noise. Score answers blind to the arm. Existing answer-quality scorer lanes for correctness, evidence, forbidden claims, and fallback should become release gates.

Additional validation:

- migration from the current schema version
- idempotent re-indexing
- stale-fact removal after source changes
- producer-version invalidation
- framework enable/disable changes
- conflicting assertions from different producers
- fact and output cardinality limits
- query latency, index-time, and database-size budgets
- capability output truncation
- no-fact, unsupported, failed, and stale states
- branch-specific effects not presented as path-specific facts
- secret values never entering labels, metadata, cache, or MCP output
- annotations do not alter topology, ranking, path selection, or deterministic sufficiency

## Documentation And Instruction Sync

If MCP behavior or tool guidance changes, update and keep consistent:

- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `.cursor/rules/solidkg.mdc`
- `AGENTS.md`
- README or public MCP docs if public behavior changes

Required guidance:

- Capability footprints are evidence, not topology.
- Trace aggregates are may-effects unless callsite- or relation-scoped.
- Coverage states distinguish absent facts from unsupported, failed, stale, or not-run analysis.
- Annotations are optional, isolated hypotheses and are excluded by default.
- Existing enriched tools should be used before any broad Read/Grep fallback.

## TDD Sequence

1. Write contract tests for taxonomy, origin/certainty axes, and coverage states.
2. Write failing schema and lifecycle tests for assertion storage, producer-run records, deletion, clear, and idempotent re-index.
3. Write failing output tests for `trace` and `node` capability packets.
4. Implement the minimal storage/query path.
5. Add one high-precision config-read producer.
6. Add query-time projection of existing hyperedges.
7. Make `trace` per-hop and may-footprint aggregation pass.
8. Make `node` local assertion output pass.
9. Run the capability-off versus capability-on eval gate.
10. Add `context` only after trace/node pass.
11. Add `explore` only if eval proves value.
12. Add annotation tests and implementation last, if approved.

## Verification Commands

Use targeted commands first:

```bash
pnpm exec tsc
pnpm exec vitest run <targeted-test-file>
pnpm test
pnpm run build
```

For agent sufficiency, run selected `scripts/agent-eval/run-all.sh` scenarios across small, medium, and large repositories with paired randomized arms and blind answer scoring.

## Risks

- Sparse v1 extraction could be mistaken for absence. Coverage states must prevent that.
- Node-scoped facts can overstate path behavior. Output must use may-footprint language.
- Mixed taxonomy would duplicate facts. Operation and resource domain must stay orthogonal.
- Reproducible rules can still be heuristic. Origin and certainty must stay separate.
- Unstable edge IDs could corrupt lifecycle semantics. Do not bind v1 facts to SQLite edge IDs.
- Optional annotations can leak source or create false confidence. Keep them disabled, isolated, audited, and excluded by default.
- Explore enrichment can increase context. Defer it until eval proves net benefit.
- Existing answer-packet/context contracts are versioned; new capability semantics need their own versioned packet or an explicit contract bump.

## Commit Strategy

1. Contract and eval protocol documentation.
2. Capability assertion storage, producer-run coverage, and lifecycle tests.
3. Thin vertical slice: config-read producer and hyperedge projection.
4. `trace` and `node` output enrichment with tests.
5. Agent-eval fixtures, scorer gates, and benchmark report.
6. Producer expansion for auth and typed datastore rules.
7. `context` enrichment and synchronized docs/instructions.
8. Conditional `explore` enrichment if approved by eval.
9. Optional annotation support only after deterministic layer succeeds.

Each commit should be atomic, buildable, and avoid mixing docs-only changes with schema/tool behavior except where synchronization is required.

## Success Criteria

- Existing MCP tools answer more capability and flow questions without broad Read/Grep fallback.
- Deterministic graph facts remain the source of truth.
- Capability evidence never affects topology, ranking, or path selection in v1.
- Origin, certainty, scope, and coverage are visible in outputs.
- Trace aggregates are correctly framed as may-effects unless path-bound evidence exists.
- No UI, vault, or human workflow is introduced.
- No new MCP tool is added in phase 1.
- Tests and evals prove reduced agent fallback behavior without answer-quality regressions.
