# Code-on-Graph Adoption Evaluation Plan

Execute the full evaluation program for deterministic Code-on-Graph ideas before adopting any behavior into SolidKG. This plan is intentionally conservative: SolidKG's value comes from deterministic AST, graph, hyperedge, and SCIP facts. Any CoG-derived mechanism must prove it improves agent retrieval sufficiency without weakening source fidelity, ambiguity handling, or local-only privacy guarantees.

## Decision Rule

Every candidate must compare three arms:

- current main
- simpler deterministic alternative
- candidate implementation

Each arm needs at least 4 runs/arm per prompt family. Report median with range, not a single run. Adoption requires better Read/Grep avoidance and answer completeness than both baselines without increasing wall-clock time, MCP tool calls, stale-file exposure, ambiguity, or fabricated evidence risk.

Primary metrics:

- `readCount`
- `grepCount`
- `answerCompleteness`
- `wallClockMs`
- `mcpCalls`
- `payloadBytes`
- `sourceFidelity`

Overhead guardrails for the eval-only follow-up candidates:

- `predictedAdditionalAgentToolCalls` must stay `0`
- candidate MCP calls must not exceed current main
- `fallbackReadGrepRisk` must stay `0`
- synthetic median and p95 helper latency must stay under the recorded local budget
- `creationUseAdditionalLatencyMs` must stay `0`
- `productionAdoptionClaim` must stay `false` until real external agent A/B proves an objective win

Secondary diagnostics:

- token and cost deltas from per-turn usage
- evidence utility score
- failure hint specificity
- payload compression ratio

Absolute kill conditions:

- fabricated source path
- unsupported inferred edge
- stale file regression
- ambiguity regression
- any mechanism that requires runtime LLM planning or user-facing generated executable code

## Survivors

### deterministic-typed-summaries

Schema-compressed typed summaries may help high-fanout contexts where current markdown output is too verbose. The candidate can only summarize facts already present in nodes, edges, hyperedges, SCIP references, source-completeness status, or existing file metadata.

Proof gate: compare against current main and a simpler deterministic output-budget increase. Adopt only if typed summaries reduce reads and payload size while preserving enough cited source and relationship detail for the agent to stop investigating.

### evidence-utility-diagnostic

A SolidKG-native evidence utility diagnostic can score whether returned context contains source, relationship, ambiguity, and source-completeness evidence. It is not a primary product metric and cannot replace Read/Grep, answer completeness, or wall-clock measurements.

Proof gate: compare against existing benchmark metrics only. Adopt only if the diagnostic explains failures that the current metrics miss and does not change traversal behavior by itself.

### deterministic-failure-hints

Failure hints may explain why SolidKG stopped short: duplicate symbols, stale files, truncated source, omitted files, unreadable files, skipped source, heuristic-only edges, or missing static coverage. Hints must be rule-derived and tied to returned metadata.

Proof gate: compare against existing terse source-completeness labels. Adopt only if hints reduce follow-up Read/Grep and lead agents toward focused SolidKG follow-ups rather than broad filesystem search.

### offline-semantic-negative-control

Offline semantic retrieval/ranking is allowed only as a diagnostic negative control. It must never replace production graph traversal or claim source evidence without a source-linked graph fact.

Proof gate: compare against current lexical/structural ranking. Keep only if it helps explain why semantic-only approaches underperform SolidKG's structural answers; do not ship as a traversal path.

### offline-query-plan-harness

Offline generated query-plan/script experiments may help evaluate prompt families and probe coverage. Outputs must be read-only, deterministic after review, and never user-facing executable code.

Proof gate: compare against hand-authored deterministic probe scripts. Adopt only if the harness increases evaluation coverage without adding nondeterministic runtime planning, sandbox execution, or self-correction loops.

## Exclusions

The following mechanisms are out of scope and must remain excluded from the schema and implementation work:

- runtime-llm-planning
- llm-generated-user-facing-code
- sandbox-self-correction
- tur-primary-metric
- semantic-traversal-replacement
- kgqa-direct-evidence

Runtime CoG planning is excluded because SolidKG must return deterministic source-linked context, not dynamically decide tool plans through an LLM. User-facing generated executable code is excluded because agents and users must not receive unreviewed generated scripts as product output. Sandbox/self-correction loops are excluded because they move the product from static retrieval into autonomous execution. TUR is excluded as a primary metric because SolidKG's established proof target is answer sufficiency, Read/Grep avoidance, wall-clock time, and tool-call count. Semantic traversal replacement and direct KGQA evidence are excluded because graph traversal must remain grounded in AST, resolver, hyperedge, and SCIP facts.

## Evaluation Phases

1. Contract phase: validate schema, candidates, exclusions, proof gates, metadata-only corpus registration, and invalid-report rejection with offline tests.
2. Fixture phase: run synthetic probe reports through `scripts/agent-eval/cog-evaluation.mjs --sample` and `--validate` without launching agents or fetching real corpora.
3. Local diagnostic phase: run `scripts/agent-eval/cog-evaluation.mjs --run-local --out .omo/evidence/cog-adoption-evaluation-local.json` to generate deterministic local measurements for persistent failure situations, run-stability/overlap, raw-count baselines, high-fanout payload pain, and candidate gates. This phase is metadata-only and does not claim real agent A/B wins.
   The local report also records the minimal overhead gate for the current follow-up: deterministic failure hints and semantic negative controls must not predict extra LLM/agent tool calls, broad Read/Grep fallback, or added SolidKG creation/use latency.
4. Candidate phase: prototype one candidate at a time behind an evaluation-only script or flag. Each candidate must preserve current main as a baseline arm.
5. A/B phase: run small, medium, and large repos with at least 4 runs/arm and prompt families matching SolidKG's existing benchmark culture.
6. Adoption phase: adopt only candidates that beat current main and the simpler deterministic alternative while passing every absolute kill condition.

## Artifact Contract

The offline helper is `scripts/agent-eval/cog-evaluation.mjs`. It emits `solidkg.cog-adoption-evaluation.v1`, validates that every surviving candidate is present, validates that forbidden mechanisms remain excluded, and refuses to write invalid reports. Its `--run-local` mode emits `solidkg.cog-local-evaluation.v1`, a deterministic local report that separates locally measured fixture facts from real-agent A/B placeholders.

The readiness artifact path is `.omo/evidence/cog-adoption-evaluation-sample.json`. The corpus manifest entry is synthetic-only and must not approve, vendor, fetch, or imply a real corpus.
