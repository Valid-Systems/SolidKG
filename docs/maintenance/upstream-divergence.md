# Upstream Divergence Register

This checkout has moved beyond `colbymchenry/codegraph` on several core agent-retrieval and product surfaces. Treat that repository as a reference feed for possible fixes, not as the source of truth for this codebase.

An upstream update is useful only when it preserves or improves this fork's current behavior. Never apply an upstream change merely because it is newer upstream, and never replace a local subsystem with upstream code without proving the local behavior is still intact.

## Review Rule

Before proposing any patch from an upstream release:

1. Identify which divergence areas below the upstream change touches.
2. Read the local files and tests for those areas before reading upstream diffs as implementation guidance.
3. Explain whether the upstream change is a bug fix, a compatible idea to adapt, or a regression risk for this fork.
4. Prefer adapting the idea into local architecture over copying upstream code.
5. Run the protected tests named for the touched area before recommending a state update.

If an upstream patch would remove a local behavior listed here, reject it unless the maintainer explicitly chooses that tradeoff.

## Protected Divergence Areas

### Agent Tool Surface And Sufficiency

Local surfaces:

- `src/mcp/tools.ts`
- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `.cursor/rules/solidkg.mdc`
- `AGENTS.md`
- `site/src/content/docs/reference/mcp-server.md`

Protected local behavior:

- Provider-neutral SolidKG tool guidance.
- Answer packets with evidence anchors, ranking reasons, sufficiency, next-tool guidance, and bounded uncertainty labels.
- Trace/explore/context guidance that steers agents away from broad read/grep loops when returned context is sufficient.
- Source-completeness wording that means returned-source coverage only, not runtime proof.

Upstream risk pattern: simplified or different MCP tool guidance can make agents over-read, pick the wrong tool, or treat upstream's current tool surface as authoritative for this fork.

Validation gate: MCP tool tests, answer-packet tests, installer-target tests, and any docs tests for the touched guidance surface.

### Retrieval Performance And Dynamic Dispatch

Local surfaces:

- `src/resolution/callback-synthesizer.ts`
- `src/resolution/frameworks/**`
- `src/graph/**`
- `src/context/**`
- `src/mcp/tools.ts`
- `docs/design/dynamic-dispatch-coverage-playbook.md`
- `docs/benchmarks/**`

Protected local behavior:

- End-to-end synthesized flows for supported callback, UI render, route, event, and bridge patterns.
- Monotonic explore budgets by repository size.
- Zero-or-low Read/Grep retrieval validation as a product quality gate.
- Conservative ambiguity handling instead of false-confidence paths.

Upstream risk pattern: a partial synthesizer, budget change, or simplified ranking change can look cleaner while making agents fall back to raw reads or miss local dynamic edges.

Validation gate: targeted graph/context/MCP tests plus retrieval or agent-eval probes when the change touches flow construction, ranking, budgets, or synthesized edges.

### Extraction And Language Coverage

Local surfaces:

- `src/extraction/**`
- `src/resolution/**`
- `src/types.ts`
- `__tests__/extraction.test.ts`
- `__tests__/frameworks-integration.test.ts`
- `docs/design/dynamic-dispatch-coverage-playbook.md`

Protected local behavior:

- Current NodeKind, EdgeKind, and HyperedgeKind contracts.
- Local language extractors, non-tree-sitter extractors, framework resolvers, and import resolution behavior.
- Deterministic AST-derived extraction without LLM summaries.

Upstream risk pattern: upstream grammar or resolver changes may be valuable, but they can narrow local coverage or break semantic hyperedges if copied without local contract checks.

Validation gate: extraction, resolution, framework integration, hypergraph, and affected language-specific tests.

### Installer And Agent Integration Safety

Local surfaces:

- `src/installer/**`
- `__tests__/installer-targets.test.ts`
- `.cursor/rules/solidkg.mdc`
- `AGENTS.md`

Protected local behavior:

- Idempotent install/uninstall across supported agents.
- Provider-neutral installed instructions.
- Cursor working-directory handling.
- Preservation of user comments, sibling config, and partial-state recovery.

Upstream risk pattern: new target support or template edits can silently regress existing agent installs if local contract tests are not updated.

Validation gate: installer target contract tests and focused instructions diff review.

### Release And Distribution Boundary

Local surfaces:

- `.github/workflows/release.yml`
- `scripts/build-bundle.sh`
- `scripts/pack-npm.sh`
- `scripts/npm-shim.js`
- `scripts/install.sh`
- `scripts/install.ps1`
- `package.json`

Protected local behavior:

- Release workflow owns publishing.
- Agents do not bump versions, push tags, publish npm packages, or create GitHub releases.
- Changelog promotion happens under `[Unreleased]` until release workflow promotion.
- Bundle and npm shim behavior remains compatible with this fork's packaging boundary.

Upstream risk pattern: upstream release automation may target a different package state or public distribution model and must not override local private/public release boundaries.

Validation gate: release workflow tests, artifact readiness tests, and package/build tests.

### Local Claims, Positioning, And Attribution

Local surfaces:

- `README.md`
- `docs/design/claims-register.md`
- `docs/maintenance/upstream-watch.md`
- `docs/maintenance/upstream-divergence.md`

Protected local behavior:

- Claims stay tied to local evidence.
- Upstream ancestry is attributed conservatively.
- Comparisons avoid implying upstream or alternatives are inferior overall; the operational point is that this fork has local requirements and advanced surfaces that must not regress.

Upstream risk pattern: upstream wording can be accurate for upstream but inaccurate for this checkout's current feature set, package state, or evidence base.

Validation gate: claims-register review and docs review for any user-facing wording.

## Triage Language

Use these labels in upstream-watch reports:

- `adapt`: upstream has an idea or fix worth porting into local architecture.
- `ignore`: upstream changed an unrelated surface or a behavior this fork intentionally does not follow.
- `investigate`: upstream touches a protected area and local tests or code reading are required before deciding.
- `reject-as-regression`: upstream would remove or weaken a protected local behavior.

Do not use `sync`, `catch up`, or `bring up to date` as action labels unless the maintainer explicitly wants local behavior to converge with upstream.
