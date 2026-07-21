# Agent Steering Hyperplan Report

Date: 2026-06-05
Audience: AI agents working on SolidKG
Status: planning report, not an implementation record

## Purpose

This report captures the adversarial planning outcome for applying ideas from Blue Guardrails' article, "Improving knowledge graph creation in life sciences through agent steering," to SolidKG's AI-agent-only scope.

The article's useful transfer is not LLM-created knowledge graphs, hosted guardrails, or human-facing review interfaces. SolidKG already builds deterministic AST/SCIP-derived graph facts. The relevant idea is evaluator-localized correction: observe agent trajectory failures, identify state-specific issues, and test whether precise corrections improve the next agent step.

For SolidKG, that idea should start as local evaluation methodology and only later become deterministic tool-output guidance if measured evidence supports it.

## Executive Summary

SolidKG should not build live full-trajectory interception into core MCP behavior. MCP servers generally see SolidKG tool calls and outputs, not the agent's hidden reasoning, native Read/Grep/Bash calls, editor state, or final answer unless a host-specific eval harness captures them.

The defensible path is:

1. Build a local offline `agent-eval` trajectory failure taxonomy and analyzer.
2. Use that analyzer to run bounded replay or A/B correction experiments.
3. Promote only successful corrections into compact deterministic guidance inside existing SolidKG tool outputs.
4. Keep graph truth deterministic and local-first.
5. Reject hosted telemetry, human dashboards, generic steering tools, tool hiding, and LLM judges as graph truth.

The durable product lever remains graph connectivity, source/output sufficiency, evidence anchors, answer-packet clarity, ambiguity handling, and calibrated uncertainty.

## Source Context

The hyperplan team evaluated the article against SolidKG's current scope and surfaces:

- MCP tools: `solidkg_context`, `solidkg_trace`, `solidkg_explore`, `solidkg_search`, `solidkg_node`, `solidkg_impact`, and related outputs.
- Agent guidance: MCP server instructions and installer instruction templates.
- Evaluation harnesses: existing agent workflow A/B scripts and benchmark docs.
- Existing product metrics: Read/Grep avoidance, tool-call count, wall-clock time, trace adoption, payload size, and returned-context sufficiency.

Adversarial roles converged on one main constraint: SolidKG can reliably change the evidence and guidance it returns through its own tools, but it cannot portably control the whole agent trajectory in production MCP hosts.

## Recommended Direction

### 1. Treat Agent Steering As An Eval Lane First

Build a local analyzer that mines real or fixture trajectories for observable SolidKG failure states. This should be part of `agent-eval`, not the production MCP path.

Required failure classes:

- Sufficient SolidKG packet followed by broad Read/Grep.
- Flow prompt not using `solidkg_trace`.
- `context`/`search`/`explore` path reconstruction on flow questions.
- Duplicate-symbol or wrong-entity choice.
- No-path drift.
- Stale, truncated, or omitted source ignored.
- Unsupported final-answer claim.
- Missed gold-path symbol or evidence.
- Overbroad fallback.
- Premature answer from partial context.

This analyzer should emit terminal/report output for agents and maintain deterministic labels where possible.

### 2. Define Privacy And Artifact Rules Up Front

Trajectory artifacts are more sensitive than ordinary graph output because they can include user intent, prompts, file paths, source snippets, and secrets.

Rules:

- No hosted telemetry.
- No raw trajectory storage by default.
- Saved eval artifacts must require an explicit eval command.
- Fixtures must be sanitized and minimized.
- Retention guidance must be documented.
- LLM judges, if ever used for sampled analysis, must not be graph truth.

### 3. Run Baseline Measurement Before Product Changes

Before changing tool outputs, record the current failure distribution and metrics.

Metrics to capture:

- Read count.
- Grep count.
- SolidKG tool calls.
- Total tool calls.
- Turns.
- Wall-clock time.
- Payload/output size.
- Cost/tokens where available.
- Trace adoption.
- Retry success after ambiguity/no-path/stale/truncated responses.
- Final-answer evidence coverage.
- False-positive steering rate.
- Wrong endpoint suggestions.
- Added calls.
- Premature-stop or under-verification regressions.
- Non-flow regression rate.
- Privacy footprint.

### 4. Test Bounded Corrections In The Eval Harness

Use replay or A/B experiments to test state-specific corrections. Experiments should target observed failures only.

Allowed experiment forms:

- State-specific correction shown in the eval harness.
- Exact next SolidKG call or retry suggestion.
- Evidence-anchor-based retry prompt.
- Correction triggered by an explicit failure state.

Disallowed experiment forms:

- Generic agent steering.
- Generic advisor tools.
- Hosted tracing endpoint.
- LLM judge as correctness source.
- Full live trajectory interception in core MCP.
- Tool hiding/removal to force behavior.
- Broad prompt rewrites as the primary lever.

### 5. Promote Only Deterministic Existing-Tool Output Changes

If an experiment wins, translate the lesson into deterministic output guidance in existing tools. Do not ship a new `solidkg_steer` or `advisor` tool.

Candidate trigger states:

| Trigger State                             | Candidate Output Behavior                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Duplicate callable names                  | Provide qualified or path-qualified retry examples.                                          |
| No path found with qualified candidates   | Provide bounded candidate retry guidance and evidence anchors.                               |
| Stale index banner                        | Provide exact sync/retry guidance bounded to stale files.                                    |
| Omitted/truncated source                  | Suggest narrower `solidkg_explore` or targeted `solidkg_node`, not broad Read.               |
| Heuristic-only path segment               | Surface calibrated uncertainty and evidence.                                                 |
| Low source coverage                       | Surface bounded insufficiency and next SolidKG call.                                         |
| Traceable flow not using trace            | Provide `solidkg_trace(from,to)` guidance only when deterministic traceable evidence exists. |
| Evidence insufficient for requested claim | State insufficiency and suggest exact evidence-gathering SolidKG call.                       |

Optional minimal metadata, only if needed:

| Field        | Constraint                                              |
| ------------ | ------------------------------------------------------- |
| `state`      | Explicit trigger state only.                            |
| `confidence` | Calibrated to deterministic evidence, not LLM judgment. |
| `evidence`   | Anchors from returned graph/source metadata.            |
| `nextTool`   | Exact existing SolidKG tool and retry example.          |

Avoid broad frameworks, session ledgers, persistent trajectory memory, and branding-led concepts until a narrow correction proves value.

## Phased Work Plan

### Phase 1: Eval Taxonomy And Artifact Boundaries

Define failure labels, observable evidence sources, metric names, sanitized fixture format, and artifact/privacy rules.

Verification gates:

- Every failure class has a deterministic label and evidence source.
- No raw/default trajectory persistence.
- No hosted telemetry.
- No production MCP behavior changes.

Kill criteria:

- A label requires hidden reasoning or non-portable host data.
- The analyzer would require hosted storage or default raw trajectory retention.

### Phase 2: Offline Analyzer MVP

Build a local analyzer that parses eval trajectories, classifies observable failure states, and emits terminal/report metrics.

Verification gates:

- Analyzer tests classify sanitized fixtures correctly.
- Same input produces same labels and metrics.
- Analyzer runs offline.
- No product output changes occur in this phase.

Kill criteria:

- Classifier results are too ambiguous to drive A/Bs.
- Reports produce no actionable experiment targets.
- Privacy footprint expands beyond explicit eval artifacts.

### Phase 3: Baseline Measurement

Run the analyzer on representative trajectories and identify top failure states.

Candidate priority:

1. Sufficient packet followed by Read/Grep.
2. Flow prompt not using trace.
3. Duplicate-symbol or wrong-entity choice.
4. Stale/truncated/omitted source ignored.
5. No-path drift.
6. Evidence insufficient for requested claim.

Kill criteria:

- No repeated observable failures are found.
- Failures are dominated by unsupported host behavior.
- Metrics are unstable enough to make comparison meaningless.

### Phase 4: Bounded Correction Experiments

Run replay/A/B experiments for observed failure classes.

Verification gates:

- Correction improves the target failure metric versus baseline.
- Harm metrics do not regress.
- Correction maps to an existing deterministic tool-output state.
- Payload growth is measured.

Kill criteria:

- Correction only works through eval hooks, append prompts, or host-specific behavior that cannot map to MCP output.
- Correction reduces Read/Grep but increases wrong claims.
- Correction increases output size without behavior gain.
- Non-flow prompts regress.

### Phase 5: Shippable Output State Selection

Select only evidence-backed deterministic states for product output changes.

Verification gates:

- Selected states have A/B evidence.
- Trigger detection uses graph/tool-output state only.
- No new generic steering/advisor tool is needed.
- No runtime session state vulnerable to daemon/proxy misattribution is required.

### Phase 6: Product Implementation And Tests

Implement only selected deterministic output changes in existing tools.

Test first:

- Duplicate callable trigger includes qualified retry examples and evidence anchors.
- No-path trigger avoids false confidence and suggests bounded retry.
- Stale/truncated trigger steers to sync or narrow SolidKG follow-up, not broad Read.
- Heuristic-only trigger labels uncertainty without suppressing evidence.
- Low-coverage trigger includes insufficiency state and exact next tool.
- Payload growth stays within budget.
- Normal successful outputs do not emit steering blocks.

Kill criteria:

- Output blocks appear in common success cases.
- Output blocks introduce ambiguous or wrong endpoint suggestions.
- Added metadata requires a broad new framework.
- Tests rely on LLM judgment.

### Phase 7: Regression Eval And Release Readiness

Compare the candidate product output against baseline.

Release gate metrics:

| Metric                                                | Desired Direction                            |
| ----------------------------------------------------- | -------------------------------------------- |
| Read count                                            | Down.                                        |
| Grep count                                            | Down.                                        |
| Trace adoption                                        | Up where flow is traceable.                  |
| Retry success after ambiguity/no-path/stale/truncated | Up.                                          |
| Final-answer evidence coverage                        | Up.                                          |
| Wrong endpoint suggestions                            | No increase.                                 |
| Added calls                                           | No harmful increase.                         |
| Payload/output size                                   | Bounded increase only.                       |
| Premature-stop/under-verification regressions         | No increase.                                 |
| Non-flow regression rate                              | No increase.                                 |
| Privacy footprint                                     | No increase outside explicit eval artifacts. |

Kill criteria:

- Eval gains do not survive MCP/tool-output form.
- Read/Grep reduction comes from premature stopping.
- Non-flow prompts regress.
- Payload bloat causes more turns or cost.
- Privacy footprint expands.

## Task Sequence

### Wave 1: Foundation

| ID  | Task                              | Category | Skills                                | QA                                                                           |
| --- | --------------------------------- | -------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Define Eval Taxonomy Contract     | `deep`   | `agent-eval`, `software-architecture` | All required failure classes have deterministic labels and evidence sources. |
| 2   | Define Privacy And Artifact Rules | `deep`   | `software-architecture`               | No raw/default trajectory persistence; explicit eval artifact rules exist.   |

### Wave 2: Analyzer Setup

| ID  | Task                          | Depends On | Category           | Skills       | QA                                               |
| --- | ----------------------------- | ---------- | ------------------ | ------------ | ------------------------------------------------ |
| 3   | Build Offline Analyzer MVP    | 1, 2       | `unspecified-high` | `agent-eval` | Analyzer runs locally and emits labels/metrics.  |
| 4   | Add Golden/Sanitized Fixtures | 1, 2       | `unspecified-low`  | `agent-eval` | Fixtures cover all failure classes and controls. |

### Wave 3: Analyzer Verification

| ID  | Task                   | Depends On | Category          | Skills       | QA                                                 |
| --- | ---------------------- | ---------- | ----------------- | ------------ | -------------------------------------------------- |
| 5   | Add Analyzer Tests     | 1, 3, 4    | `unspecified-low` | `agent-eval` | Tests deterministically classify fixtures.         |
| 6   | Run Baseline Eval Pass | 3, 5       | `deep`            | `agent-eval` | Baseline metrics and top failure classes recorded. |

### Wave 4: Experiments

| ID  | Task                                  | Depends On | Category | Skills                                | QA                                                                 |
| --- | ------------------------------------- | ---------- | -------- | ------------------------------------- | ------------------------------------------------------------------ |
| 7   | Design Bounded Correction Experiments | 6          | `deep`   | `agent-eval`, `software-architecture` | Each experiment maps to an observed failure and harm metric.       |
| 8   | Run Replay/A/B Experiments            | 7          | `deep`   | `agent-eval`                          | Results distinguish successful, failed, and eval-only corrections. |

### Wave 5: Product Selection

| ID  | Task                                     | Depends On | Category           | Skills                                | QA                                                                 |
| --- | ---------------------------------------- | ---------- | ------------------ | ------------------------------------- | ------------------------------------------------------------------ |
| 9   | Decide Shippable Output States           | 8          | `ultrabrain`       | `agent-eval`, `software-architecture` | Only evidence-backed deterministic states selected.                |
| 10  | Specify Deterministic Tool-Output Blocks | 9          | `unspecified-high` | `software-architecture`               | Each block has trigger, evidence, confidence, and exact next tool. |

### Wave 6: Shippable Changes

| ID  | Task                               | Depends On | Category           | Skills | QA                                                                     |
| --- | ---------------------------------- | ---------- | ------------------ | ------ | ---------------------------------------------------------------------- |
| 11  | Implement Shippable Output Changes | 10         | `unspecified-high` | None   | Existing tool outputs enhanced without new generic steering tool.      |
| 12  | Add MCP/Tool-Output Tests          | 10, 11     | `unspecified-low`  | None   | Trigger, false-positive, payload, and deterministic-output tests pass. |

### Wave 7: Release Gate

| ID  | Task                      | Depends On | Category  | Skills                                              | QA                                                           |
| --- | ------------------------- | ---------- | --------- | --------------------------------------------------- | ------------------------------------------------------------ |
| 13  | Run Regression Eval Gate  | 11, 12     | `deep`    | `agent-eval`                                        | Target metrics improve; harm metrics do not regress.         |
| 14  | Update Docs And Changelog | 13         | `writing` | `crafting-effective-readmes` if README/docs touched | Docs distinguish eval experiments from product MCP behavior. |

## Atomic Commit Strategy

| Commit | Contents                                                                    |
| ------ | --------------------------------------------------------------------------- |
| 1      | Taxonomy contract, privacy/artifact rules, and no product behavior changes. |
| 2      | Offline analyzer MVP with sanitized fixtures.                               |
| 3      | Analyzer tests and baseline report plumbing.                                |
| 4      | Replay/A/B experiment harness additions.                                    |
| 5      | Experiment result fixtures or recorded sanitized summaries.                 |
| 6      | Selected deterministic tool-output specification.                           |
| 7      | Product output changes for one trigger family only.                         |
| 8      | Product tests for that trigger family.                                      |
| 9      | Additional trigger families, one commit per family.                         |
| 10     | Regression eval results and docs.                                           |

Rules:

- Keep eval-harness commits separate from shippable MCP/tool-output commits.
- Do not combine analyzer work with product behavior changes.
- Commit each trigger state independently so harmful states can be reverted cleanly.
- Do not include raw trajectories in commits.
- Include tests in the same commit as the behavior they validate where practical.

## Success Criteria

- Offline analyzer identifies the listed failure classes from local eval artifacts.
- Analyzer output is deterministic and privacy-bounded.
- Baseline metrics exist before product output changes.
- Experiments distinguish eval-only wins from portable MCP-output improvements.
- Shipped changes are compact deterministic blocks inside existing tool outputs.
- No generic steering/advisor tool is added.
- No hosted telemetry or human dashboard is introduced.
- Read/Grep fallback decreases for targeted failure states.
- Trace adoption increases for traceable flow questions.
- Wrong endpoint suggestions, added calls, premature-stop regressions, and non-flow regressions do not increase.
- Documentation clearly separates eval harness methodology from shippable product behavior.

## Agent Handoff Notes

If another agent picks this up, start with Wave 1. Do not implement tool-output steering before the taxonomy, artifact rules, analyzer tests, and baseline metrics exist.

The first implementation branch should not touch production MCP output. It should establish the eval taxonomy and privacy rules, then prove an offline analyzer can classify sanitized fixtures. Product changes are gated on observed failures and successful bounded experiments.
