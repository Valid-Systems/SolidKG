# Selective Fallow Mining Plan

Plan generated from hyperplan debate bundle and amended after review; no implementation changes are approved by this document.

## Context

Mine useful ideas from `D:\Apps\Programming_Tools\fallow` into SolidKG without turning SolidKG into a Fallow clone. The corrected strategy is: contracts first enough to prevent drift, then runtime/data correctness, then evidence/provenance, then resolver depth.

SolidKG's core promise is correct, bounded, source-anchored code intelligence for AI agents. The graph/index must not lie to the agent, so known correctness blockers must be addressed before richer evidence presentation.

## Explicit Non-Goals

Reject outright:

- Rust rewrite / N-API transplant.
- Fallow dead-code CLI/product suite.
- Security scanner, fix workflows, suppressions.
- Telemetry, licensing, release/process tooling.
- Runtime coverage/editor/plugin product surfaces.
- Safe deletion / unused-code verdict language.
- New public MCP tools before proof.
- Blind durable-facts schema migration before a failing fixture and explicit approval.

Defer until proven necessary:

- Runtime/test/story reachability, except as context/ranking evidence.
- Broad resolver parity or Oxc-assisted extraction.
- Cache model/path serialization changes.
- New tools like `why_reachable` or `inspect_target`.

Durable extracted facts are not product creep when they preserve source facts required for correct incremental sync. If the target-file-only sync fixture cannot be fixed safely within the existing schema, a durable extracted-facts mechanism or equivalent durable source-fact mechanism is required.

## Revised Critical Path

Critical path: Task 0 -> Task 1 -> Task 1.5 -> Task 5 -> Tasks 2/3 -> Task 4 -> Task 6.

1. **Baseline Review Packet**: inventory candidates, non-goals, known blockers, hypotheses, kill criteria.
2. **Contract Drift Harness**: MCP manifest/schema/tool drift tests.
3. **Runtime/Data Correctness Regression Harness**: failing tests for known production-readiness blockers.
4. **Path/Resource Guardrails and Atomicity**: stat-before-read, oversized/excluded tombstones, per-file transactionality, watcher/MCP freshness.
5. **Answer/Evidence Contract Enrichment**: enrich existing outputs only after graph freshness/correctness failures are explicit.
6. **Provenance/Freshness Discipline**: resolver/synthesizer provenance plus MCP startup freshness semantics.
7. **JS/TS Resolver/Re-Export Proof Slice**: narrow resolver/re-export fixtures and adapter improvements behind existing APIs.
8. **Eval, Review, and Go/No-Go**: build/tests/probes and ship/revise/defer decisions.

## Execution Waves

### Wave 1: Planning and Known-Failure Tests

Run Task 0, expanded to include known blockers as pre-seeded hypotheses. Stop for user approval.

### Wave 2: MCP Contract Harness

Run Task 1. This is a safe early investment because it prevents tool/schema drift before outputs change.

### Wave 3: Runtime Correctness Hardening

Run Task 1.5 and Task 5 before answer enrichment. This wave covers stat-before-read, oversized/excluded tombstones, per-file DB transactionality, target-only sync reference preservation, MCP startup stale/catch-up behavior, and watcher scope parity.

### Wave 4: Evidence and Provenance Enrichment

Run Tasks 2 and 3 after runtime/data correctness is locked or honestly marked as unresolved. At this point, output enrichment can expose freshness, provenance, uncertainty, blind spots, resolver rule IDs, source spans, and synthesized-vs-extracted facts.

### Wave 5: JS/TS Resolver/Re-Export Proof Slice

Run Task 4. Use Fallow ideas for package exports/imports, tsconfig/jsconfig paths, extension aliases, dynamic import literals, re-export chains, and namespace re-exports.

### Wave 6: Eval and Go/No-Go

Run Task 6. User decides ship, revise, defer, or reject.

## Tasks

### Task 0: Baseline Review Packet

Create the review baseline before implementation. Inventory Fallow candidates, map each to existing SolidKG surfaces, define hypotheses, kill criteria, exact proof commands, and known production-blocker mapping.

Acceptance criteria:

- Candidate list is split into adopt/defer/reject.
- Every adopt candidate names an existing SolidKG surface.
- Every candidate has a proof gate and kill condition.
- Known blockers are represented as explicit failing-test hypotheses.
- No schema migration or new MCP tool is approved in this phase.

Stop/go review point: user approves the candidate list, known-blocker mapping, and kill criteria before code changes.

### Task 1: Contract Drift Harness

Add or strengthen TDD tests for MCP manifest/schema drift and existing tool contract consistency.

Acceptance criteria:

- Live MCP tools match declared manifest/allowlist both directions.
- Key params exist for current tools.
- Read-only/destructive/open-world annotations are checked.
- Suggested next tools refer only to registered tools.

Proof commands:

```bash
pnpm exec vitest run __tests__/mcp-initialize.test.ts
pnpm exec vitest run __tests__/mcp-tool-allowlist.test.ts
pnpm exec vitest run __tests__/answer-packets.test.ts
```

Stop/go review point: user approves contract deltas before user-visible output changes.

### Task 1.5: Runtime/Data Correctness Regression Harness

Add failing tests for known runtime/data correctness blockers before evidence enrichment or resolver work.

Acceptance criteria:

- Target-file-only sync preserves cross-file reference/call edges.
- Modified file becoming oversized removes or tombstones stale symbols.
- Per-file index replacement is atomic under mid-store failure.
- MCP startup catch-up either returns fresh results or marks output `stale` / `catch_up_running`.
- Watcher scope matches configured `extraRoots`, include/exclude, and vendored options.
- Durable extracted facts or an equivalent durable source-fact mechanism is required if the target-only sync fixture cannot be fixed safely within the existing schema.

Proof commands:

```bash
pnpm exec vitest run __tests__/sync.test.ts
pnpm exec vitest run __tests__/max-file-size.test.ts
pnpm exec vitest run __tests__/path-security.test.ts
pnpm exec vitest run __tests__/watcher.test.ts
```

Stop/go review point: user approves the correctness-blocker fixture set and any durable-fact decision before implementation.

### Task 5: Path/Resource Guardrails and Atomicity

Mine bounded path/resource ideas where they protect local-first indexing correctness: stat before read, bounded discovery, oversized/excluded file diagnostics, skipped/tombstone reporting, and per-file transactional replacement.

Acceptance criteria:

- Every read path performs stat/root/symlink/size validation before reading.
- Skipped oversized or excluded files have deterministic diagnostics and stale-symbol cleanup/tombstoning.
- Per-file replacement is transactional: delete old file graph, insert nodes, insert edges, insert refs, and upsert the file record in one transaction.
- Guardrails do not hide indexed-source correctness failures.
- Cross-platform path behavior is covered, with Windows/POSIX gating where needed.
- No path serialization migration occurs unless required by a failing approved test.

Proof commands:

```bash
pnpm exec vitest run __tests__/max-file-size.test.ts
pnpm exec vitest run __tests__/path-security.test.ts
pnpm exec vitest run __tests__/sync.test.ts
pnpm exec vitest run __tests__/watcher.test.ts
pnpm exec vitest run __tests__/explore-output-budget.test.ts
```

Stop/go review point: user approves diagnostics format, tombstone semantics, and persistence changes before rollout.

### Task 2: Answer/Evidence Contract Enrichment

Enrich existing answer packets and tool outputs only, not new tools. Add section status, scope, warnings, blind spots, uncertainty, stable IDs, and deterministic read-only next actions where current outputs already surface evidence.

Acceptance criteria:

- Existing tools are enriched: `solidkg_trace`, `solidkg_node`, `solidkg_context`, `solidkg_explore`.
- No new public tool is added.
- Output distinguishes `ok`, `partial`, `not_applicable`, and `error`.
- Blind spots are explicit when partial coverage exists.
- Suggested next actions are read-only and deterministic.
- No safe-cleanup or unused-code language appears.
- Output enrichment does not mask known stale, missing, or lossy graph facts. If the graph cannot prove a relationship, output says unresolved/unknown rather than inferring confidence from absence.

Proof commands:

```bash
pnpm exec vitest run __tests__/answer-packets.test.ts
pnpm exec vitest run __tests__/agent-eval/evidence-contract.test.ts
pnpm exec vitest run __tests__/retrieval-plan-gate.test.ts
```

Stop/go review point: user approves output contract and examples before resolver work consumes it.

### Task 3: Provenance/Freshness Discipline

Tighten provenance and freshness semantics for resolver/synthesizer output and MCP startup behavior: resolver identity, rule id, `synthesizedBy`, source spans where available, stale/fresh state, uncertainty labels, and bounded catch-up state.

Acceptance criteria:

- Every new provenance field has an existing output use.
- Every persisted fact has a stale/delete path and schema test.
- Heuristic edges remain clearly marked.
- Partial dynamic/resolution coverage is represented as uncertainty, not confidence.
- MCP tools do not silently serve stale startup data while catch-up sync is running; they either await bounded catch-up or mark output `stale` / `catch_up_running`.

Proof commands:

```bash
pnpm exec vitest run __tests__/hypergraph-synthesis.test.ts
pnpm exec vitest run __tests__/sync.test.ts
pnpm exec vitest run __tests__/answer-packets.test.ts
pnpm exec vitest run __tests__/mcp-initialize.test.ts
```

Stop/go review point: user approves any persistence and freshness-contract changes.

### Task 4: JS/TS Resolver/Re-Export Proof Slice

Mine Fallow resolver ideas only as a contained JS/TS slice behind existing SolidKG APIs. Focus on package exports/imports, tsconfig/jsconfig discovery, path aliases, extension aliases, dynamic import literals, re-export chains, and namespace re-exports.

Acceptance criteria:

- Work is behind existing APIs in `src/resolution`.
- Fixtures prove specific missing behavior before implementation.
- Re-export/barrel cases improve existing `trace`, `context`, `node`, or `explore` results.
- Partial first-hop-only resolution is rejected unless output marks the blind spot.
- No schema migration occurs unless existing graph representation demonstrably fails.

Proof commands:

```bash
pnpm exec vitest run __tests__/resolution.test.ts
pnpm exec vitest run __tests__/package-exports.test.ts
pnpm exec vitest run __tests__/selective-dataflow.test.ts
```

Additional targeted probe after build: `scripts/agent-eval/probe-trace.mjs` on approved JS/TS fixture prompts.

Stop/go review point: user reviews fixture failures and expected graph/output deltas before implementation.

### Task 6: Eval, Review, and Go/No-Go

Run final proof gates and review whether each slice improved existing agent-called tools enough to ship.

Acceptance criteria:

- All targeted tests pass.
- TypeScript build passes.
- Approved probes show existing tool enrichment reduced fallback or improved correctness.
- No low-salience new tool was needed.
- Any deferred item has written rationale.

Proof commands:

```bash
pnpm exec tsc
pnpm test
pnpm run eval
scripts/agent-eval/run-all.sh <approved-repo> "<approved-flow-question>"
```

Stop/go review point: user decides ship, revise, defer, or reject each mined idea.

## Test Strategy

Use TDD per slice:

1. **Red**: add the smallest failing contract/fixture test for the approved idea.
2. **Green**: implement the smallest existing-surface change.
3. **Surface**: exercise the real CLI/MCP/indexing path affected by the slice.
4. **Refactor**: clean only within touched seam.
5. **Prove**: run targeted tests, then broader regression.
6. **Decide**: stop/go review before next phase.

Required before/after baselines:

- MCP contracts: run current MCP tests, then re-run MCP tests and drift checks.
- Correctness blockers: capture failing target-only sync, oversized/tombstone, atomicity, startup freshness, and watcher parity fixtures before implementation.
- Evidence packets: snapshot current packet examples, then verify deterministic enriched packet examples only after correctness blockers are addressed or honestly marked unknown.
- Resolver slice: fixture fails for known gap, then passes and existing graph output improves.
- Guardrails: current indexing behavior documented, then skipped/oversized/excluded diagnostics deterministic.
- Agent behavior: existing trace/context/explore fallback measured, then Read/Grep/tool-call deltas recorded.

## Future Commit Strategy

Atomic future commits only after user approval:

1. Baseline/contract tests only, no product behavior.
2. MCP manifest/schema drift harness.
3. Runtime/data correctness regression harness.
4. Path/resource guardrails and per-file atomicity.
5. Answer/evidence contract enrichment.
6. Provenance/freshness discipline.
7. JS/TS resolver/re-export proof slice.
8. Eval docs/results and defer/reject ledger.

Rules:

- No commit mixes resolver behavior with MCP contract changes.
- No schema migration commit without a prior failing proof and explicit user approval.
- No new public MCP tool commit unless existing output enrichment is proven insufficient.
- Release/package/process tests stay out of the runtime-readiness track unless directly relevant to the approved slice.
- If commits are requested later, use `git-master`.

## Success Criteria

The plan is successful if future implementation:

- Keeps SolidKG local-first code intelligence for AI agents.
- Makes graph/index correctness precede richer evidence presentation.
- Improves existing tools before any new tool is considered.
- Marks partial coverage as uncertainty, not truth.
- Gives every adopted idea tests, probes, and stop/go proof.
- Prevents Fallow product scope from leaking into SolidKG.
