# SolidKG 10/10 Readiness Rubric

This rubric defines technical readiness for the core SolidKG and installation push. It is not marketing copy, a release checklist, or a visualization plan. Score each dimension from 0 to 10 using measured evidence, not intent.

## Scoring Rules

- Score 10: the dimension has passing deterministic checks, representative agent or smoke evidence where relevant, no known blocker, and a durable evidence path or summary.
- Score 7 to 9: the dimension works for the primary path, but has a documented gap, limited corpus coverage, or platform coverage still pending.
- Score 4 to 6: the dimension has partial implementation or synthetic proof only, but still forces fallback, ambiguous claims, or incomplete install evidence in normal use.
- Score 1 to 3: the dimension exists mostly as a plan, prompt wording, or isolated code path without end-to-end evidence.
- Score 0: the dimension is missing, contradicted by evidence, or relies on unsupported claims.

A readiness item cannot score 10 when it depends on a known failing guardrail in the failure taxonomy below. A benchmark result must name the repo, prompt, run count, commands, and evidence path. Do not generalize beyond the repos and prompts measured.

## Dimension 1: Answer Sufficiency

Checklist for a 10:

- [ ] Structural and flow questions can be answered from SolidKG output without broad raw Read/Grep rediscovery on the measured prompts.
- [ ] The answer includes the key symbols, relationships, and glue hops needed to explain the path or dependency shape.
- [ ] Agent runs show lower or stable Read/Grep counts, tool-call count, and wall-clock time against the relevant baseline.
- [ ] Residual gaps are named as unsupported or uncertain instead of hidden behind confident prose.
- [ ] Evidence records the prompt, repo, command, Read count, Grep count, SolidKG tool calls, duration, and pass/fail result.

Allowed implementation levers: improve returned tool output, add missing graph connectivity, add precise source or relation summaries, tune payload budgets, and add focused evidence checks. Do not rely on instruction wording alone when measured output sufficiency is the real blocker.

## Dimension 2: Trace Correctness

Checklist for a 10:

- [ ] `solidkg_trace` returns the correct from-symbol to to-symbol path for the measured flow.
- [ ] Each hop is backed by stored graph edges, synthesized edge metadata, semantic relations, or SCIP facts where present.
- [ ] Duplicate or ambiguous endpoints are rejected or require qualified input instead of stitching unrelated same-name symbols.
- [ ] Trace output provides enough hop source and destination context to avoid follow-up raw reads for the same path.
- [ ] Deterministic probes prove the path before agent A/B runs claim readiness.

Allowed implementation levers: extraction fixes, resolver fixes, synthesizer edges, semantic hyperedges, qualified disambiguation, trace output sufficiency, and deterministic probe scripts.

## Dimension 3: Source Completeness

Checklist for a 10:

- [ ] Source completeness is defined only as returned-source coverage, not correctness, confidence, query quality, or global path truth.
- [ ] `solidkg_context` and `solidkg_explore` label omitted, truncated, skipped, unreadable, and stale source clearly.
- [ ] Missing source points users toward focused SolidKG follow-up first, such as narrower explore, qualified trace, or targeted node.
- [ ] Explore output budgets keep larger repo tiers from receiving smaller per-file limits than smaller tiers.
- [ ] Evidence proves that source returned is enough for the measured answer without forcing broad Read/Grep fallback.

Allowed implementation levers: source range extraction, completeness metadata, output labels, monotonic budget tiers, and focused follow-up wording in tool output.

## Dimension 4: Uncertainty Calibration

Checklist for a 10:

- [ ] Heuristic, synthesized, inferred, incomplete, and missing paths are labeled in the answer surface.
- [ ] No-path trace results distinguish unsupported dynamic dispatch from proven absence when the evidence supports that distinction.
- [ ] Partial source coverage does not get presented as a complete answer.
- [ ] README and docs use measured scope language, such as repos and prompts tested, rather than universal guarantees.
- [ ] Evidence includes both pass cases and named residual gaps.

Allowed implementation levers: uncertainty labels, provenance metadata, confidence notes, failure tags, no-path explanations, and claims wording limits tied to evidence.

## Dimension 5: Retrieval Latency/Tool-Call Count

Checklist for a 10:

- [ ] Flow questions resolve within the expected SolidKG call budget for the repo size, usually 1 call for small repos and 3 to 5 for large repos.
- [ ] Agent runs show fewer or stable total turns and tool calls versus the baseline.
- [ ] Payload size is measured alongside wall-clock time so large context dumps cannot hide behind low Read counts.
- [ ] Small repos do not receive breadth-heavy output that exceeds the needs of a short flow.
- [ ] Cost and token data are secondary diagnostics after Read/Grep avoidance, wall-clock time, and tool-call count pass.

Allowed implementation levers: path-scoped trace output, adaptive explore budgets, source caps, destination context, and evidence parsers that sum per-turn usage correctly.

## Dimension 6: Install Success

Checklist for a 10:

- [ ] Source checkout install, shell installer, PowerShell installer, npm shim, local bundle cache, and supported agent installs each have platform-specific smoke checks.
- [ ] Installer behavior preserves idempotency, sibling configuration, uninstall reversibility, and partial-state recovery.
- [ ] Smoke tests isolate HOME, USERPROFILE, APPDATA, TEMP, TMP, and npm user config state where relevant.
- [ ] Windows, Linux, and macOS readiness states are recorded separately, with blocked platforms named rather than implied.
- [ ] Released bundle paths do not require system Node when the bundle design vendors Node.

Allowed implementation levers: installer tests, matrix docs, temp-home smoke scripts, platform-specific validation, offline/no-download checks, and actionable install errors.

## Dimension 7: Package Artifact Integrity

Checklist for a 10:

- [ ] Local package and bundle checks prove expected files are included and non-allowlisted corpora, caches, tests, and private evidence are excluded.
- [ ] SQL, native parser metadata, and target parser libraries required by runtime are present in built artifacts.
- [ ] Per-platform optional dependency packages map to the correct OS and CPU combinations.
- [ ] Offline cache and checksum behavior is verified before any release workflow is considered ready.
- [ ] Artifact evidence uses dry-run packaging, unpacked bundle smoke tests, and checksum or digest checks without publishing.

Allowed implementation levers: `npm pack --dry-run`, bundle unpack smoke tests, checksum validation, file-list assertions, platform package metadata tests, and corpus exclusion rules.

## Dimension 8: README Truthfulness

Checklist for a 10:

- [ ] Every comparative, quantitative, or superiority claim maps to a claims register entry and evidence source.
- [ ] Benchmark language states the measured repos, prompts, and run method, such as median of 4 runs per arm where that is the source evidence.
- [ ] Unsupported claims are removed instead of softened into vague claims.
- [ ] README install and release statements match the current package, private/public, and release workflow state.
- [ ] Static-analysis limits are stated clearly, including runtime edges that SolidKG does not model.

Allowed implementation levers: claims register, README claim audit, forbidden wording checks, evidence links, and scoped benchmark wording.

## Dimension 9: Attribution

Checklist for a 10:

- [ ] Upstream, fork ancestry, inspiration, and alternatives are credited where evidence or maintainer confirmation supports the wording.
- [ ] Alternative projects are described by scope and fit, not rank or insult.
- [ ] Claims about Graphify, KiroGraph, upstream SolidKG, or other tools stay tied to observed public docs or confirmed facts.
- [ ] Missing ancestry evidence is labeled as requiring maintainer confirmation.
- [ ] Attribution appears in the user-facing material before publication readiness is claimed.

Allowed implementation levers: attribution section, claims register entries, source links, maintainer-confirmation notes, and non-bullying language checks.

## Dimension 10: Maintainability

Checklist for a 10:

- [ ] Fixes target measured failure classes and avoid broad refactors not tied to evidence.
- [ ] Extraction, resolver, synthesizer, hyperedge, MCP, and installer changes keep existing module boundaries clear.
- [ ] Graph growth is bounded, with node, edge, and hyperedge count checks where new synthesis or dataflow is added.
- [ ] Tests cover the changed behavior at the narrowest useful layer and include regression controls.
- [ ] Tool guidance stays synchronized across server instructions, installer template, Cursor rules, README, and docs when that surface changes.

Allowed implementation levers: focused tests, count caps, provenance metadata, module-local fixes, snapshot or architecture checks, and synchronized documentation updates.

## Failure Taxonomy

| Failure class               | Measurable evidence                                                                                                                                             | Readiness impact                                             | Allowed implementation levers                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Payload budget regressions  | Explore or context payload grows, small repos receive breadth-heavy output, or larger tiers have lower per-file limits than smaller tiers                       | Caps Dimension 3 and Dimension 5 below 10                    | Tune adaptive budgets, enforce monotonic `maxCharsPerFile`, add payload assertions, prefer path-scoped trace for flows        |
| Source completeness gaps    | Output marks source omitted, truncated, skipped, unreadable, stale, or lacks enough returned source for the answer                                              | Caps Dimension 1 and Dimension 3 below 10                    | Improve source ranges, add completeness metadata, narrow follow-up SolidKG calls, adjust per-file caps                        |
| Ambiguity                   | Duplicate names, unqualified endpoints, or fuzzy context inputs produce wrong or misleading paths                                                               | Caps Dimension 2 and Dimension 4 below 10                    | Require qualified symbols, omit misleading flow sections, return ambiguity warnings, use precise refs when available          |
| Unbridged dynamic dispatch  | `probe-trace` shows no path at a callback, event, descriptor, DI, reactive, route, or native bridge boundary                                                    | Caps Dimension 1 and Dimension 2 below 10 for that framework | Add resolver logic, synthesizer channel, extraction support, semantic relation surfacing, and deterministic probes            |
| Partial coverage            | One bridge is added but the full flow still breaks and agents drill into the new hop then Read/Grep                                                             | Caps Dimension 1, Dimension 2, and Dimension 10 below 10     | Close the end-to-end flow, re-measure on canonical prompts, add control repos, do not ship half-bridged flows as complete     |
| Read/Grep fallback          | Agent runs still use broad Read/Grep after SolidKG output for the same structural answer                                                                        | Caps Dimension 1 and Dimension 5 below 10                    | Add missing output sufficiency, reduce payload waste, connect missing edges, include last-mile context, record fallback cause |
| Install/package failures    | Smoke tests fail, artifacts miss SQL/native-parser/Node/runtime files, optional dependency mapping is wrong, offline cache breaks, or installer mutates real user config | Caps Dimension 6 and Dimension 7 below 10                    | Add isolated smoke tests, dry-run package file checks, checksum validation, platform matrix rows, installer contract tests    |
| Unsupported README claims   | README says a capability, benchmark, install state, release state, or superiority claim that lacks evidence                                                     | Caps Dimension 8 below 10                                    | Remove claim, add claims register evidence, scope wording to measured repos/prompts, add forbidden-claim checks               |
| Attribution gaps            | Fork ancestry, inspiration, or alternatives are omitted, overstated, or described disrespectfully                                                               | Caps Dimension 9 below 10                                    | Add attribution wording, source links, maintainer-confirmation notes, and respectful comparison checks                        |
| Maintainability regressions | Broad refactor creep, node/edge explosion, unsynchronized docs, brittle tests, or changes outside measured failure classes                                      | Caps Dimension 10 below 10                                   | Keep fixes local, add count caps, add regression tests, use provenance, update all linked docs together                       |

## Evidence Requirements

A readiness claim needs at least one of these evidence types, matched to the dimension:

- Deterministic graph probes: trace, node, context, explore, direct database count checks, SCIP precise refs where available.
- Agent A/B evidence: prompt, repo, run count, Read/Grep counts, SolidKG calls, total turns, duration, payload, cost, and tokens when measured.
- Installer and artifact smoke evidence: command, platform, temp state path, expected output, artifact file list, checksum or digest result.
- Documentation evidence: claims register entry, source URL or command, allowed wording, forbidden wording, attribution rule, and grep check.
- Maintainability evidence: targeted tests, graph count checks, control repo checks, and changed-surface list.

Generated run artifacts belong under `.omo/evidence/task-{N}-{slug}.{ext}` unless another task defines a committed machine-checkable manifest. Durable summaries should record command, result, timestamp, and evidence path.

## Non-Goals And Guardrails

- Visualization is not a readiness dimension. Human-centered graph visualization can be useful later, but this rubric scores agent-facing structural sufficiency and install readiness.
- Publish, release, deploy, package repository publication, GitHub Release creation, tag pushes, and website deployment are out of scope for this rubric task.
- The rubric must not create new product claims. Claims need evidence or removal.
- Whole-program dataflow is not a readiness requirement. Only narrow, measured dataflow gaps may be considered by later implementation tasks.
- Package and website readiness gates are secondary to core and install readiness unless they reveal a release-readiness regression.

## Minimum 10/10 Gate

SolidKG is 10/10 ready for this plan only when all ten dimensions score 10, every active failure taxonomy class is resolved or explicitly waived by the maintainer, visualization remains unscored, and no publish/release/deploy action has been run as part of readiness verification.
