# README Claims Register And Attribution Rules

This register governs future README and comparison language for SolidKG. It is the source of truth for what claims may be made, what evidence they need, and how alternatives must be described.

Use this register as the approval checklist for README, website, release note, buyer, and comparison copy.

## Tone Rules

All README and comparison language must be respectful, factual, and non-bullying.

Rules:

- Describe alternatives by scope, fit, public statements, and documented capabilities, not by rank.
- Do not claim universal superiority without evidence scoped to the exact repository set, prompt set, model, date, and measurement method.
- Do not say or imply that Graphify, KiroGraph, an upstream project, a fork, or any other alternative is inferior overall.
- Do not use aggressive competitor-page framing.
- Prefer plain measured phrases such as "built for", "optimized for", "measured on", and "in our benchmark runs".
- Avoid absolute or accusatory wording such as "always", "inferior", "copy", "better overall", "obsolete", or "replaces every".
- Unsupported README claims must be removed rather than softened into vague claims.

## Ancestry And Attribution Rules

Treat ancestry conservatively.

Rules:

- "Inspired by" and "credits" are safe only where public sources say so.
- "Fork", "derived from", "based on", or "copied from" require maintainer confirmation unless the referenced repository states that relationship itself.
- If ancestry is uncertain, say that maintainer confirmation is required, or omit the ancestry claim.
- Attribute upstream work plainly and separately from SolidKG's own local evidence.
- Do not imply Graphify ancestry because the reviewed Graphify README does not mention SolidKG.
- KiroGraph may be described as publicly saying it is inspired by CodeGraph and credits Colby McHenry's SolidKG concept, but it must not be called a fork unless separate evidence proves that.

## Claims Register

| Claim | Evidence | Allowed wording | Forbidden wording | Attribution | Verification source |
|---|---|---|---|---|---|
| SolidKG is a TypeScript MCP server, CLI, and SDK that builds a local SQLite graph. | Current source, README, and public API. | Describe implemented local graph surfaces. | A complete replacement for compilers, language servers, or security tools. | Local implementation. | `README.md`, `src/index.ts` |
| SolidKG stores deterministic AST-derived facts. | Tree-sitter extraction and persisted graph records. | Deterministic AST-derived facts, not LLM-written summaries. | Never wrong or complete runtime truth. | Local extraction design. | `AGENTS.md`, `src/extraction/` |
| Product comparisons must be scoped. | Linked peer documentation and dated local evidence. | Compare documented fit, surfaces, and bounded measurements. | Universal ranking, bullying language, or unsupported ancestry claims. | Attribute each peer claim to its source. | `README.md`, `docs/benchmarks/` |
| Claim-grade answer-quality results require a passing benchmark passport. | Passport code records hashes, provenance, freshness, repeats, and raw sidecars. | Claim-grade only when every gate passes. | Presenting missing-passport results as independently reproducible. | Exact profile, model, seed, binaries, and date. | `scripts/agent-eval/benchmark-passport.mjs` |
| The 2026-07-10 and 2026-07-11 reports are bounded local diagnostics. | Dated reports preserve their own scope and caveats. | Quote only their explicitly supported observations. | Universal quality, speed, or generated-code claims. | Dated report. | `docs/benchmarks/opencode-head-to-head-2026-07-10.md`, `docs/benchmarks/opencode-expanded-head-to-head-2026-07-11.md` |
| The 2026-07-12 seven-arm study is a local diagnostic, not claim-grade. | 280 terminal cells, 276 completed answers, blinded AI review, adjudication, four latency repeats, and API-equivalent costs calculated from raw token categories using official GPT-5.6 Sol rates; raw trajectories and source snapshots are not versioned here. | Descriptively, SolidKG core used 70.0% fewer paired tool calls and had 8.31% lower mean API-equivalent cost than baseline; SolidKG + SCIP used 71.0% fewer calls and cost 5.92% less. Holm-adjusted p was 0.140625. | Observed billing savings, independent reproducibility, multiplicity-adjusted significance, or universal quality, token, speed, cost, or productivity wins. | Dated report, official pricing date, model, repositories, repeats, review protocol, and evidence boundary. | `docs/benchmarks/opencode-seven-arm-2026-07-12.md`, `docs/benchmarks/opencode-seven-arm-2026-07-12-presentation.html` |
| Lifecycle diagnostics use best-effort atomic publication. | Random exclusive temp creation, bounded transient rename retries, and atomic replacement on success. | Updates are attempted immediately and become visible atomically after successful publication. | Guaranteed persistence, recovery, or instantaneous counts. | Current implementation and dated reliability evidence. | `src/index-lifecycle-atomic-file.ts`, `docs/benchmarks/opencode-expanded-head-to-head-2026-07-11.md` |
| Unsupported claims must be removed. | Claims policy and repository evidence requirements. | Remove the claim until evidence exists. | Vague substitutes such as industry-leading or enterprise-grade. | Add evidence before restoring wording. | This register |

## Verification Checklist For Future README Changes

Before any README or comparison change ships:

1. Match every claim to a row in this register.
2. Add or update evidence when a claim depends on new benchmarks, new external README facts, package metadata, license files, or maintainer confirmation.
3. Keep benchmark wording scoped to tested repos, tested prompts, model or agent setup, date, and median-of-4 runs when that is the evidence base.
4. For OpenCode answer-quality benchmark claims, require a claim-grade benchmark passport: matching implementation/scenario hashes, explicit SolidKG binary provenance, fresh index metadata, complete planned result rows, at least four scoreable repeats per selected scenario/arm, and validated raw tool-output sidecars.
5. Treat missing-passport, stale-index, low-repeat, or raw-sidecar-missing reports as diagnostic or smoke evidence only.
6. Remove unsupported claims instead of replacing them with vague marketing language.
7. Check that Graphify, KiroGraph, upstream, and fork references follow the attribution rules above.
8. Check that the final tone remains respectful, factual, non-bullying, and free of universal superiority claims.
