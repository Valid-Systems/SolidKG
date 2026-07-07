# OpenCode LLM Answer Quality Benchmark

This document describes the OpenCode answer quality harness under `scripts/agent-eval/`. It is a methodology and usage note, not a results page.

The benchmark asks a live coding agent to answer repository questions under several structural code-intelligence tool surfaces, then scores the final answer against scenario rubrics. It measures whether the agent's final answer is more helpful when it can use those measured structural surfaces. It is not a natural-language query benchmark for the underlying tools, not a direct optimization benchmark for SolidKG internals, and not proof that one tool wins across agents, repositories, prompts, or tasks.

Caveat language for reports and summaries: `Scores compare measured scenarios only and do not prove universal superiority.`

## Requirements

- The OpenCode CLI is required for live runs and judge runs. Set `OPENCODE_BIN` or pass `--opencode-bin` if the binary is not named `opencode`.
- `OPENCODE_MODEL` defaults to `openai/gpt-5.5`; pass `--model` to override it.
- Use `--variant medium` or `OPENCODE_VARIANT=medium` to pin OpenCode's provider-specific reasoning effort for comparable live runs.
- The Claude evaluation scripts in this repository are reference-only for this benchmark. They document prior agent-eval patterns, but this harness is built around OpenCode transcripts and OpenCode runner behavior.
- Peer tools must be installed or reachable when their arms are enabled. Missing or unsupported peers are reported as reliability statuses, not as low-quality answers. Peer arms are exposed through per-run scenario-targeted wrapper scripts generated under the run output directory, not through global OpenCode config or generic `--help` placeholders.

## What It Measures

The harness compares answer quality across these arms:

| Arm | Tool surface |
|---|---|
| `solidkg` | SolidKG MCP plus local read/search fallback. |
| `grep_read` | Local read/search fallback only. |
| `tilth` | Tilth structural lookup wrapper plus local read/search fallback. |
| `cartog` | Cartog structural lookup wrapper plus local read/search fallback. |
| `sverklo` | Sverklo repo proof wrapper plus local read/search fallback; the OpenCode prompt carries the scenario question. |

Each scenario contains a repository, a user-facing question, expected evidence, required answer elements, forbidden claims, and gold provenance with second review. Peer wrappers must use public scenario inputs and documented tool surfaces. Rubric expected-evidence symbols or files are answer keys and must not be passed as hidden query hints unless every arm receives the same explicit public hint. The score is about the final answer that the agent gives, not just tool-call count.

Reports separate answer quality, evidence quality, and tool economy lanes before showing any diagnostic composite score. The composite is a debugging summary, not a claim-grade scoreboard. Tool economy must not make a wrong or generic answer look good, and answer quality must not hide repeated tool over-drilling.

The deterministic rubric score is primary. The optional blinded OpenCode judge score is secondary and must not overwrite deterministic scoring. Judge output is useful as a qualitative cross-check, but reports and decisions should lead with separated score lanes, reliability rates, raw-evidence status, and coverage readiness.

## Profiles

| Profile | Purpose | Scenario selection | Default repeats |
|---|---|---|---|
| `calibration` | Prove the runner, transcript parser, scoring, and report path on one scenario across all arms. | One configured calibration scenario. | 1 |
| `smoke` | Check all repositories on the architecture-flow scenario shape before any larger run. | Nine `architecture_flow` scenarios. | 1 |
| `full` | Run the full scenario matrix with repeat blocks for variance reporting. | Twenty-seven scenarios across all scenario kinds. | 2 |

Smoke and full live benchmarks are not run by default. A dry run only writes the planned run order and estimated cost. Non dry-run execution requires `--confirm-live`, a finite positive `--max-runs`, and a finite non-negative `--max-estimated-cost-usd`, and those caps are checked before setup, OpenCode execution, or transcript parsing. Live runs also require OpenCode preflight to pass before any setup or model execution. Smoke/full live runs are guarded by `calibration-success.json` evidence.

Generated live outputs should stay uncommitted by default. Write them under a scratch path such as `D:/tmp/opencode/...` or another ignored working directory, then copy only deliberate methodology artifacts into the repo.

## Run Order And Pairing

The harness builds planned runs from `scenarioId`, `repeat`, and `armId`.

- A paired block is one `scenarioId + repeat` group containing all selected arms.
- The seed controls the block order and the arm order inside each block.
- Use `--seed` to make a planned order reproducible.
- Paired deltas compare arms inside the same scenario and repeat block, usually against `grep_read`.

This blocked design reduces noise from prompt and repository differences. It does not remove live model variance, especially at low repeat counts.

## Timing And Reporting

Reports split time into setup and query phases.

- `setupDurationMs` covers per-arm preparation such as indexing or preflight checks.
- `queryDurationMs` covers the OpenCode answer run itself.
- Answer duration uses the query phase, not setup plus query, so agent answer latency is visible apart from index or peer setup cost.

The report writes:

- `llm-answer-quality.json`
- `llm-answer-quality.md`
- `llm-answer-quality.html`

Aggregate tables use medians and ranges for diagnostic composite score, answer quality, evidence quality, tool economy, total tool calls, SolidKG MCP calls, peer wrapper calls, reads, greps, fallback loops, setup time, and query time. Per-run rows include deterministic scoring component breakdowns for correctness, evidence coverage, forbidden-claim avoidance, fallback efficiency, answer economy, scoring notes, and tool-call sequence diagnostics. Paired blocks report deltas within each `scenarioId + repeat` group. Reliability tables show pass and failure rates per arm.

raw evidence status is reported separately from answer quality. Claim-grade runs require validated evidence dossiers with raw tool-result sidecars. Diagnostic reports should explain unavailable raw evidence with cause codes such as missing evidence dossier, transcript-only tool output, missing payload file, payload hash mismatch, no tool results, or validated sidecar payloads. Do not weaken `raw_tool_outputs_unavailable` to make reports look better.

Tool-call sequence diagnostics identify patterns such as repeated SolidKG node calls, repeated context/explore loops, peer-wrapper repetition, and structural-tool-then-read fallback. These diagnostics explain why a run was inefficient; they are not a substitute for reading the final answer.

Low-repeat results are smoke evidence only. Treat one or two repeats as a guardrail and debugging signal, not as a stable product claim. If publishing any future result, state the profile, seed, scenario set, repositories, model, host, number of repeats, failure statuses, medians, ranges, paired deltas, and caveats.


## Benchmark Passport And Claim-Grade Gates

Every dry-run and live result now carries a machine-readable benchmark passport. The passport records hashes for the benchmark implementation files, the scenario matrix hash, configured SolidKG binary, SolidKG binary probe output, planned/result row counts, and SolidKG index data-directory freshness metadata. Reports also evaluate passport readiness for `--from-results`; older result files without a passport remain reportable, but they are diagnostic only and surface `missing_benchmark_passport`.

A report is claim-grade only when all of these gates pass:

- Passport readiness is true and no passport stop conditions are present.
- Required benchmark implementation file hashes and the scenario hash are present and match the files used for the report. The implementation set includes the orchestrator, scenarios, arms, OpenCode runner, transcript parser, scorer, raw-evidence contract, report writer, and passport module.
- The configured SolidKG binary matches the passport provenance. Use `--solidkg-bin` or `SOLIDKG_BIN` when the benchmark should use a specific binary instead of PATH-resolved `solidkg`.
- SolidKG index metadata is available and fresh for the measured SolidKG data directories.
- Coverage readiness is true: every planned selected-arm run has a result row.
- Each selected scenario/arm has at least four scoreable repeats. Low-repeat calibration, smoke, and ad hoc full runs are smoke or diagnostic evidence only.
- Validated raw evidence dossiers with raw tool-result sidecars are available for scoreable runs. If sidecars are absent, reports must keep `raw_tool_outputs_unavailable` visible.

Passport stop condition codes include `missing_benchmark_passport`, `benchmark_code_hash_missing`, `benchmark_code_hash_mismatch`, `scenario_hash_missing`, `scenario_hash_mismatch`, `solidkg_binary_mismatch`, `solidkg_index_unavailable`, `solidkg_index_stale`, `low_repeat_claim_grade_blocked`, and `raw_tool_outputs_unavailable`.

These gates do not change answer-quality scorer thresholds, scoring weights, reliability statuses, raw evidence retention, or tool-call visibility. Read/Grep fallback is allowed and counted. Answer-packet sufficiency is a returned-context diagnostic, not proof of answer correctness.
## Failure Statuses

Quality averages exclude runs that did not produce a scoreable answer, but those runs remain visible in reliability counts.

| Status | Meaning | Score handling |
|---|---|---|
| `unsupported` | The arm cannot answer the scenario through a supported scenario-targeted command or tool surface. | `score: null`; counted in reliability. |
| `setup_failed` | A required setup or preflight step failed, for example a missing peer binary or failed index command. | `score: null`; counted in reliability. |
| `runner_failed` | OpenCode or the judge runner could not run, or the transcript format was unsupported for live parsing. | `score: null`; counted in reliability. |
| `parse_failed` | A known transcript format was malformed or incomplete enough that the answer could not be scored safely. | `score: null`; counted in reliability. |

Do not convert these statuses into answer-quality failures. They answer a different question: whether the arm was runnable and observable under the benchmark contract.

## Commands

### Calibration Dry Run

This writes a run plan without invoking OpenCode or any model. The expected plan has five runs, one scenario across five arms.

```bash
node scripts/agent-eval/opencode-answer-benchmark.mjs --profile calibration --dry-run --out D:/tmp/opencode/cg-answer-bench-calibration-dry-run
```

### Smoke Dry Run

Use this before any smoke live run to inspect order, selected scenarios, arm count, and estimated cost.

```bash
node scripts/agent-eval/opencode-answer-benchmark.mjs --profile smoke --dry-run --out D:/tmp/opencode/cg-answer-bench-dry-run
```

### Fixture Report

This path is offline and deterministic. It converts saved fixture results into JSON, Markdown, and HTML reports.

```bash
node scripts/agent-eval/opencode-answer-benchmark.mjs --from-results fixtures/agent-eval/answer-quality/sample-results.json --out D:/tmp/opencode/cg-answer-bench-fixture
```

You can also call the report writer directly:

```bash
node scripts/agent-eval/report-answer-quality.mjs --from-results fixtures/agent-eval/answer-quality/sample-results.json --out D:/tmp/opencode/cg-answer-report-fixture
```

### Judge Dry Run

The standalone judge is dry-run-by-default. It builds the blinded judge packet and prompt without invoking OpenCode or a model.

```bash
node scripts/agent-eval/judge-opencode-answer.mjs --from-run D:/tmp/opencode/run.json --from-scenario D:/tmp/opencode/scenario.json
```

### Smoke Live Run

Run this only after calibration evidence exists and you are ready to spend live model budget. The caps must be set deliberately.

```bash
node scripts/agent-eval/opencode-answer-benchmark.mjs --profile smoke --out D:/tmp/opencode/cg-answer-bench-smoke-live --seed answer-quality-smoke-001 --variant medium --confirm-live --max-runs 45 --max-estimated-cost-usd 2.25
```

### Full Live Run

Run this only after calibration and smoke evidence are acceptable. Keep outputs out of commits unless a maintainer explicitly asks for a curated artifact.

```bash
node scripts/agent-eval/opencode-answer-benchmark.mjs --profile full --out D:/tmp/opencode/cg-answer-bench-full-live --seed answer-quality-full-001 --variant medium --confirm-live --max-runs 270 --max-estimated-cost-usd 13.50
```

## Safety And Claim Hygiene

- Default to dry runs and fixture reports while developing the harness.
- Never run smoke or full live benchmarks by accident. `--confirm-live` and caps are required before any model invocation.
- Never run the standalone judge live by accident. It defaults to dry-run and requires explicit live confirmation and caps before invoking OpenCode.
- Do not commit raw live outputs by default.
- Do not publish or imply benchmark results from this methodology page.
- Avoid universal claims. Say what happened in the measured profile, with the measured repositories, seed, model, and run count.
- Judge scores are secondary to deterministic rubric scores.

