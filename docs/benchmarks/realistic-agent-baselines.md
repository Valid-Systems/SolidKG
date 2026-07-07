# Realistic Agent Baseline Methodology

This document describes the small offline benchmark fixture added for context-gathering comparisons. It is a methodology artifact, not a published performance claim.

## Purpose

SolidKG should be compared against the way modern coding agents actually gather context: search, targeted reads, diffs, LSP-style navigation, and focused tool calls. The fixture in `__tests__/evaluation/realistic-baselines.test.ts` and the offline artifact script at `scripts/agent-eval/realistic-baselines.mjs` keep that comparison fast, deterministic, and local.

The fixture uses a tiny checkout flow with `CheckoutService`, `PaymentGateway`, and `ReceiptMailer`. It records one JSON-compatible object per arm with:

- `baselineKind`
- `prompt`
- `toolCalls`
- `filesRead`
- `estimatedTokens`
- `success`

## Included Arms

| `baselineKind` | What it models | Why it is fair |
|---|---|---|
| `rg_read` | A modern agent searches for precise symbols or terms, then reads matching files. | This is the common fallback when no graph tool is available. |
| `diff_read` | A review-oriented agent starts from a diff and changed/supporting files. | Many real tasks begin from changed files rather than from the whole repository. |
| `solidkg_context` | A single `solidkg_context` call against the same tiny local fixture. | This measures SolidKG on its existing context surface without requiring network access or external repositories. |

## Rejected Baseline

`whole_repo_read` is explicitly labeled `rejected_unfair_antipattern` in the generated artifact. Reading every source file into a prompt is not a realistic baseline for modern agents that have search, diffs, symbol navigation, and targeted reads. It can be useful as an anti-pattern example, but it must not be used as a headline comparison.

## Claim Hygiene

The fixture exists to prove that SolidKG can be evaluated against tool-assisted baselines, not to publish universal savings. Do not turn this artifact into a README headline. Any future numeric claim should name the prompt set, repositories or fixtures, number of runs, model/host, commands used, and variance. Results depend on task shape, repository structure, indexed coverage, and the agent workflow.

Conservative wording is acceptable: SolidKG can reduce rediscovery and support targeted context gathering. Universal token-reduction claims against whole-repository ingestion are not acceptable.

When this methodology is referenced from product docs or agent guidance, keep it tied to realistic baselines such as targeted search/read, diffs, changed files, candidate files, and candidate symbols. It is also acceptable to mention compact first-pass context with `solidkg context "..." --detail minimal` or MCP `solidkg_context` with `detailLevel: "minimal"` as an ergonomic workflow. Do not convert the fixture into a whole-repository savings headline.

## Running

Run the deterministic Vitest coverage:

```bash
pnpm exec vitest run __tests__/evaluation/
```

Emit the standalone offline JSON artifact:

```bash
node scripts/agent-eval/realistic-baselines.mjs
```

Neither command clones repositories or requires network access.
