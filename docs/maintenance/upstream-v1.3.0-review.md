# Upstream CodeGraph v1.3.0 Review

Reviewed range: `v1.0.1...v1.3.0`  
Reviewed on: 2026-07-07  
Upstream: `colbymchenry/codegraph`

Durable action record: `.upstream-watch/reports/v1.0.1-to-v1.3.0.md`

## Report summary

`scripts/upstream-watch/report.mjs` found 262 changed upstream files and 175 manifest-matched files. The touched surfaces overlap every protected area: extraction/language coverage, resolution/dynamic dispatch, MCP/daemon behavior, installer/release packaging, tests, and docs.

## Adapted

- `adapt`: v1.1.6 standalone/npm installer pruning. SolidKG now prunes older standalone bundle versions after successful `scripts/install.sh` installs and prunes older same-platform fallback bundles in `scripts/npm-shim.js`. This preserves the local release boundary and avoids accumulating stale vendored Node runtimes.

## Already present or partially superseded locally

- `investigate`: Nix, Terraform/HCL, Solidity, VB.NET, and ArkTS extraction surfaces exist locally, but they are not treated as fully equivalent to upstream v1.3.0 without language-specific validation on real repositories.
- `investigate`: include/exclude configuration, hidden child process options, daemon/orphan handling, source completeness, answer packets, and local retrieval ranking already diverge substantially from upstream and must stay governed by local tests and benchmarks.

## Deferred

- `investigate`: upstream v1.3.0 language additions and deeper coverage for CFML, COBOL, Erlang, CUDA, Metal, ArkUI, NixOS option wiring, Terraform module/provider/state wiring, C++ namespace/template/CUDA recovery, and MyBatis/iBatis robustness. These require extractor/resolver implementation plus the full language/framework validation matrix before they can be claimed locally.
- `investigate`: upstream v1.2.x broad local-variable method-call resolution, Ruby receiver-call linking, graph traversal fixes, and C++ macro/forward-declaration recovery. These touch protected extraction/resolution/traversal behavior and need focused tests before adaptation.
- `ignore`: upstream Claude Code front-load hook, telemetry, discontinued managed-reasoning cleanup, and CodeGraph-specific product wording. SolidKG has different provider-neutral instructions, local telemetry posture, and package identity.

## Validation required before future adaptations

- Extraction/language changes: `pnpm exec vitest run __tests__/extraction.test.ts`, language-specific tests, and real-repo probes.
- Resolution/dynamic-dispatch changes: `pnpm exec vitest run __tests__/resolution.test.ts __tests__/frameworks-integration.test.ts` plus retrieval-quality probes.
- MCP/daemon changes: MCP daemon/startup/orphan and tool contract tests.
- Installer/release changes: standalone installer tests, npm shim tests, release artifact readiness checks, and package smoke.
