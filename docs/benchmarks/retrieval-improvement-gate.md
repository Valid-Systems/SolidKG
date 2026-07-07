# Retrieval Improvement Gate

This gate turns the six-point retrieval improvement plan into a binary evidence check for implementation candidates. It is intentionally local, deterministic, and scoped to SolidKG's MCP/CLI/API retrieval surfaces.

The gate accepts only candidates that include a reproducible current-main failure, baseline metrics, target metrics, control coverage, kill criteria, and verification commands. It rejects candidates that cannot be tied to objective retrieval metrics or that lack enough evidence to enter one of the bounded workstreams.

## Failure Classes

- `dynamic_path_gap`
- `trace_explore_insufficiency`
- `scip_fidelity_gap`
- `ranking_wrong_symbol`
- `missing_relation_family`
- `sync_freshness_gap`
- `benchmark_claim_drift`

## Workstreams

- `deterministic_dynamic_connectivity_bridges`
- `trace_explore_sufficiency`
- `additive_scip_precision`
- `deterministic_explainable_ranking`
- `narrow_relation_family`
- `sync_freshness_correctness`

Evidence-scoped release review is a governance gate after integrated evaluation, not an admitted implementation workstream.

## Usage

```bash
node scripts/agent-eval/retrieval-plan-gate.mjs fixtures/retrieval-plan/valid-candidate.json
```

A passing candidate prints `status: pass`. A rejected candidate prints `status: fail`, exits non-zero, and writes deterministic rejection reasons to stderr.

The gate is not a claim that a candidate is implemented or successful. It is only the admission check before implementation and integrated A/B evaluation against current main and controls.
