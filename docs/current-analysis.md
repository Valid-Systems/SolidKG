# SolidKG Production Readiness Gap Report

**Date:** 2026-05-29
**Scope:** current codebase.
**Verification performed:** extracted both archives, compared changed files, inspected the updated implementation surfaces, and parsed 140 TypeScript source files with the TypeScript parser. Syntax parse result: **0 parse errors**. A full `tsc`/Vitest validation was not possible from the supplied archive because project-level build/test files and dependency state were not complete.

---

## 1. Executive summary

The update moves SolidKG closer to production readiness in the most important product direction: it is no longer just reducing tool calls; it is starting to return the **evidence an agent needs to stop investigating**. The strongest changes are in `solidkg_trace` and `solidkg_explore`: trace now inlines hop bodies and destination callees, rejects ambiguous unqualified callable endpoints, and carries some synthesized-edge registration evidence; explore now leads with source completeness, whole-small-file inclusion, a symbol-bag flow section, line-numbered current source, and explicit ambiguity omission.

However, the codebase is still not ready to be marketed as serious production-grade code intelligence without several closure and truth gates. The biggest gap is not performance. It is **trust calibration**: when SolidKG output is complete, omitted, heuristic, stale, or ambiguous, the agent-facing surface must say so consistently and mechanically, not only in comments or internal metadata.

### Production verdict

| Area                 |                           Current status | Production-readiness readout                                                                                                                                   |
| -------------------- | ---------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace sufficiency    |                          Strong progress | Close to production for endpoint-known static/synthesized call paths, but synthesized-edge labels are incomplete and no-path boundaries are still too generic. |
| Explore sufficiency  |                          Strong progress | Good direction, but source-completeness accounting needs more exactness before agents can safely trust “complete/omitted/truncated.”                           |
| Context/discovery    |                             Material gap | Source completeness is computed internally but not rendered in Markdown/JSON or typed in `TaskContext`; vague-query drift remains primarily guidance-managed.  |
| Dynamic dispatch     |                      Promising but risky | Coverage is broad, but event-name, JSX-name, overload, Fabric suffix, and RN wrapper heuristics need falsifier tests and mechanism-specific evidence parity.   |
| SCIP integration     |     Useful but needs boundary discipline | SCIP relationships are added as semantic hyperedges, but runtime-flow implications must be explicit and conservative.                                          |
| Eval/release process | Not production-ready from supplied files | Generic hyperedge prompts exist, but production claims require repo-specific anchors, evidence atoms, negative controls, and repeated A/B runs.                |

### Main recommendation

Treat this update as **late beta / pre-production candidate**, not production-ready. The next milestone should not be “more graph coverage.” It should be a **truth-and-closure release gate**:

1. Every SolidKG answer that includes source must expose a compact completeness signal.
2. Every synthesized edge used in trace/context must name the mechanism and evidence atom that justifies it.
3. Every heuristic family must have a canonical positive flow and at least one negative-control fixture.
4. Agent A/B claims must be accepted only after structural truth and answer correctness pass.

---

## 2. What changed in the right direction

### 2.1 Trace now targets answer closure, not just path discovery

Evidence in `src/mcp/tools.ts`:

- The `solidkg_trace` tool description now promises a path where each hop has an inlined body and the destination’s outgoing callees are included (`src/mcp/tools.ts:687-688`).
- `handleTrace` resolves endpoints through `findAllSymbols(..., { exactQualified: true })` and rejects ambiguous unqualified callable endpoints (`src/mcp/tools.ts:1553-1562`).
- Successful traces print a “Full execution path” and inline each hop body with `sourceRangeAt` (`src/mcp/tools.ts:1612-1648`).
- Destination “last mile” callees are included with bounded source snippets (`src/mcp/tools.ts:1650-1664`).
- Synthesized edges can show registration evidence through `synthEdgeNote` and `registeredAt` (`src/mcp/tools.ts:1628-1635`, `1676-1728`).

This is aligned with production behavior: an agent should not need to rediscover the same hop bodies with Read/Grep after trace already found the decisive path.

### 2.2 Explore is becoming a source-bearing answer tool

Evidence in `src/mcp/tools.ts`:

- Explore declares `Source completeness` near the top (`src/mcp/tools.ts:2097-2103`).
- Explore explicitly tells the agent that shown source is current, verbatim, line-numbered, and not a summary (`src/mcp/tools.ts:2150-2154`).
- Whole small relevant files are included rather than lossy clusters (`src/mcp/tools.ts:2177-2188`).
- Large-file clusters are prioritized by entry-point importance, density, score, and span (`src/mcp/tools.ts:2314-2333`).
- Output is truncated at a Markdown boundary with a clear completeness marker (`src/mcp/tools.ts:2498-2503`).
- The flow preface for symbol-bag queries preserves qualified names, uses exact resolution, limits to at most one unnamed bridge, and rejects ambiguous duplicate endpoints rather than stitching same-name paths (`src/mcp/tools.ts:1872-1952`).

This is the correct product lever: not broad context, but enough path-salient source to close an answer.

### 2.3 Multi-root source resolution is now treated as a first-class operational risk

Evidence:

- `SolidKG` persists source options and rebuilds orchestrator/resolver/context builder when overrides change (`src/index.ts:369-407`, `496-522`, `702-712`, `831-838`).
- `ContextBuilder`, `tools.ts`, and `ReferenceResolver` all use root-qualified `@label/path` source resolution (`src/context/index.ts:280-326`, `src/mcp/tools.ts:3019-3035`, `src/resolution/index.ts:241-259`).
- Trace/explore source inlining reads through the indexed source resolver rather than assuming one project root (`src/mcp/tools.ts:1736-1797`, `2164-2170`).

This matters because a production code intelligence system fails hard if it can identify a symbol but cannot safely re-read the exact source backing that symbol.

---

## 3. Production blockers and ranked improvement proposals

The proposals below are ranked by production risk and by their ability to make agents correctly stop investigating without sacrificing structural truth.

---

### P0.1 — Surface `solidkg_context` source completeness in every agent-facing format

**Failure class:** Source-completeness metadata is computed but not consistently exposed. Agents cannot tell whether context source is complete, omitted, truncated, unreadable, or intentionally absent, so they either over-trust incomplete source or fall back to Read/Grep.

**Affected implementation surfaces:**

- `src/context/index.ts`
- `src/context/formatter.ts`
- `src/types.ts`
- `src/context/budget.ts`

**Current evidence:**

- `ContextBuilder` defines source-completeness metadata types (`src/context/index.ts:238-260`).
- It computes `sourceCompleteness` and attaches it to `context` via a type cast (`src/context/index.ts:371-404`).
- `extractCodeBlocks` tracks truncation, returned chars, and unreadable blocks (`src/context/index.ts:1414-1463`).
- `buildSourceCompleteness` and `summarizeSourceCompleteness` compute `complete/truncated/omitted` (`src/context/index.ts:1498-1550`).
- `TaskContext` does **not** type this metadata (`src/types.ts:838-872`).
- Markdown and JSON formatters do **not** serialize or print it (`src/context/formatter.ts:21-125`, `130-244`).

**Task class:** Endpoint-unknown discovery/survey.

**Required structural truth checks:**

- `TaskContext.sourceCompleteness` exists in the public type and is populated without casts.
- Markdown, minimal Markdown, JSON, and minimal JSON all expose the same status.
- `includeCode=false` must not imply complete source; it should report omitted source for candidate nodes.
- Unreadable source must be counted separately from omitted source.
- Redaction must not change completeness counts except where redaction actually removes source.

**Required answer evidence atoms:**

- `status`: `complete`, `omitted`, or `truncated`.
- `candidateBlocks`, `returnedBlocks`, `omittedBlocks`, `truncatedBlocks`, `unreadableBlocks`.
- For non-complete output, a compact next action: e.g. “run `solidkg_explore` for `<symbol/file>`” rather than a generic Read suggestion.

**Behavioral measurement plan:**

Run paired agent tasks using current context output vs context-with-completeness output:

- Concrete feature discovery tasks.
- Vague feature tasks that should abstain or qualify.
- Minimal-context orientation tasks.
- Standard-context implementation tasks.

Track fallback reason categories: “source missing,” “source not trusted,” “ambiguous endpoint,” “wrong feature drift,” and “local variable data flow outside SolidKG scope.”

**Falsifiers and negative controls:**

- Context returns no source but says complete.
- Context returns truncated code but JSON status says complete.
- Minimal mode reports complete despite intentionally omitting code blocks.
- An unreadable indexed file disappears without a visible count.

**TDD test plan:**

- Unit tests for all four formatters.
- Fixture where `maxCodeBlocks=1` with three priority nodes.
- Fixture where a code block exceeds `maxCodeBlockSize`.
- Fixture with a stale/unreadable path.
- Snapshot tests confirming exact compact wording.

**Acceptance criteria:**

- Every context output that may cause source trust includes a visible completeness signal.
- Non-complete context output causes the eval agent to use another focused SolidKG call, not blind Read/Grep, unless the missing detail is explicitly outside SolidKG’s modeled boundary.
- No material increase in broad context payload: one status line plus bounded counts is enough.

**Why this preserves sufficient minimal evidence:**

This adds provenance and boundary evidence, not more code. It tells the agent whether the current evidence is sufficient.

**Existing tool or new primitive:** Existing tool improvement: `solidkg_context`.

**Risks:** Output bloat if per-block details are verbose. Mitigate by defaulting to one compact line plus counts; only detailed JSON needs per-block metadata.

---

### P0.2 — Make synthesized-edge evidence mechanism-complete in trace and explore

**Failure class:** Dynamic-dispatch edges can be structurally present but agent-facing evidence is incomplete or generic. The graph may connect a path, but the output does not always explain the bridge that makes the path faithful.

**Affected implementation surfaces:**

- `src/mcp/tools.ts`
- `src/resolution/callback-synthesizer.ts`
- `src/hypergraph/synthesizer.ts`

**Current evidence:**

- Hyperedge synthesis recognizes `callback`, `event-emitter`, `rn-event-channel`, `react-render`, `flutter-build`, `jsx-render`, `vue-handler`, `cpp-override`, `interface-impl`, and `fabric-native-impl` (`src/hypergraph/synthesizer.ts:22-33`).
- `synthEdgeNote` only labels `callback`, `event-emitter`, `react-render`, `jsx-render`, `vue-handler`, and `interface-impl` (`src/mcp/tools.ts:1676-1728`). It does not label `rn-event-channel`, `flutter-build`, `cpp-override`, or `fabric-native-impl`.
- `synthesizeCallbackEdges` deduplicates by `source>target` only (`src/resolution/callback-synthesizer.ts:784-817`), so multiple mechanisms between the same nodes can collapse and lose evidence metadata.

**Task class:** Endpoint-known flow, with secondary impact on endpoint-unknown discovery when explore surfaces flow.

**Required structural truth checks:**

- Every `metadata.synthesizedBy` value that can produce a `calls` edge has a trace/explore label.
- Labels are mechanism-specific, not generic “dynamic dispatch.”
- Metadata includes compact bridge evidence: event name, JSX child name, Vue event, field, registration site, interface/override source, Fabric suffix, RN event channel, or Flutter `setState` boundary.
- Deduplication preserves multiple reasons or chooses a deterministic highest-specificity reason without dropping provenance silently.

**Required answer evidence atoms:**

For each synthesized hop, the output should expose:

- The mechanism type.
- The source-side trigger or dispatch site.
- The target-side handler/implementation/render boundary.
- The registration/binding/provenance site when available.
- Confidence category or heuristic marker when the edge is not compiler-grade.

**Behavioral measurement plan:**

A/B trace tasks over canonical flows:

- React `setState` → render.
- JSX parent → child render.
- Vue template event → handler.
- Event emitter → listener.
- RN native event → JS listener.
- Flutter `setState` → `build`.
- C++ virtual/override.
- JVM interface → implementation.
- Fabric JS surface → native implementation.

Measure whether the agent answers with the required bridge atom without Read/Grep.

**Falsifiers and negative controls:**

- A path contains a heuristic edge but output prints it as an ordinary `calls` edge.
- Two mechanisms connect the same nodes and only one arbitrary reason survives.
- An RN/Fabric/Flutter/C++ synthesized path lacks event/suffix/override evidence.
- Agent answers the flow but cannot name the registration or binding site.

**TDD test plan:**

- Table-driven test keyed by every `HEURISTIC_MAPPINGS` key.
- Snapshot trace output for one canonical fixture per mechanism.
- Direct unit test for dedupe preserving metadata or emitting multiple reasons.
- Explore-flow snapshot showing `synthEdgeNote(...).compact` for every mechanism.

**Acceptance criteria:**

- No synthesized edge used in trace/explore is displayed as bare `calls` unless it is intentionally a normal static call.
- For every dynamic mechanism fixture, the expected bridge atom appears in output.
- Agent A/B shows reduced fallback because evidence is sufficient, not because prompts say “do not read.”

**Why this preserves sufficient minimal evidence:**

It adds only the bridge proof for a hop already on the answer-critical path.

**Existing tool or new primitive:** Existing tool improvement: `solidkg_trace`, `solidkg_explore`, and synthesized edge metadata.

**Risks:** False confidence if labels overstate heuristic certainty. Mitigate by labeling provenance and mechanism explicitly.

---

### P0.3 — Add precision gates and negative controls for dynamic-dispatch synthesis

**Failure class:** Dynamic edge coverage is broad, but several mechanisms can over-connect when names collide. Production SolidKG must prefer abstention or boundary output over plausible false paths.

**Affected implementation surfaces:**

- `src/resolution/callback-synthesizer.ts`
- `src/hypergraph/synthesizer.ts`
- `src/mcp/tools.ts`
- `src/db/queries.ts`

**Current evidence:**

- Event emitter synthesis keys handlers and dispatchers by literal event name and caps fanout at 6 (`src/resolution/callback-synthesizer.ts:145-199`, `31`). This is useful but can join unrelated emitters sharing an event name.
- JSX child synthesis resolves the first component/function/class matching a tag name across the graph (`src/resolution/callback-synthesizer.ts:398-432`), with no visible import/file scope tie-break in this snippet.
- Interface override synthesis deliberately links every base overload to every implementation overload of the same name (`src/resolution/callback-synthesizer.ts:341-378`). This improves recall but can produce false overload edges without signature checks.
- RN event synthesis keys by event name and can attribute wrapper subscriptions to enclosing functions or variables (`src/resolution/callback-synthesizer.ts:561-704`). That may be reachability-correct but must be distinguished from “ultimate user handler.”
- Fabric native implementation links by component name plus suffix (`src/resolution/callback-synthesizer.ts:731-776`), which needs collision controls.

**Task class:** Both endpoint-known flow and endpoint-unknown discovery.

**Required structural truth checks:**

- Event channels include receiver/module identity when available, not event string alone.
- JSX child resolution prefers local imports, same file, or explicit export/import edges before global first-match.
- Interface override edges compare arity/signature where extractors provide it; otherwise mark as lower-confidence boundary.
- RN wrapper edges distinguish wrapper API surface from final callback.
- Fabric links qualify by package/module/component declaration when available.
- Edge and hyperedge counts are bounded per mechanism and compared against pre-change baselines.

**Required answer evidence atoms:**

- Why the edge exists.
- What key was used: event name, receiver identity, import binding, suffix, interface signature, etc.
- What uncertainty remains.
- Whether the edge is a final handler or an intermediate wrapper boundary.

**Behavioral measurement plan:**

Use the dynamic-dispatch coverage playbook style:

- Deterministic positive probes for each mechanism.
- Matched negative probes with same names/events but disconnected objects.
- Control repos to measure edge explosion and false path rate.
- Agent A/B runs only after structural snapshots pass.

**Falsifiers and negative controls:**

- Two independent emitters both use `'change'`; trace must not stitch emitter A to listener B.
- Two components named `Button`; JSX parent must not link to the unrelated package’s `Button`.
- Interface has overloads with same method name but incompatible arity; flow must not imply the wrong overload.
- RN native event and JS listener share event name but belong to different module surfaces.
- Two Fabric components share a suffix-derived class name in different packages.

**TDD test plan:**

- Fixture pairs for every false-positive shape above.
- Snapshot counts before/after synthesis.
- Regression tests that assert no path for disconnected controls.
- Tests for “useful boundary” output when the graph abstains.

**Acceptance criteria:**

- Zero false paths in negative-control fixtures.
- Known connected canonical flows still connect end-to-end or report the exact residual boundary.
- Edge/hyperedge growth stays within a fixed per-mechanism budget and is monitored in CI.

**Why this preserves sufficient minimal evidence:**

It rejects broad dynamic guesses. The goal is fewer but more faithful bridges.

**Existing tool or new primitive:** Existing synthesis and output improvements. No new tool justified.

**Risks:** Stricter precision can reduce recall and reveal more boundaries. That is acceptable if the output names the boundary and next SolidKG action.

---

### P1.1 — Improve trace no-path output from generic dynamic-dispatch advice to path-local boundary evidence

**Failure class:** When no path is found, trace gives a generic explanation and the start node’s outgoing calls. This still pushes the agent into investigation because it does not identify the nearest trustworthy boundary.

**Affected implementation surfaces:**

- `src/mcp/tools.ts`
- `src/graph/traversal` path search APIs, if boundary search needs graph support
- `src/hypergraph/synthesizer.ts`

**Current evidence:**

- No-path output says the chain likely breaks at dynamic dispatch and lists up to 10 static callees of the start symbol (`src/mcp/tools.ts:1589-1609`).
- Over-cap paths are rejected as likely BFS wander (`src/mcp/tools.ts:1567-1576`, `1598-1600`).

**Task class:** Endpoint-known flow.

**Required structural truth checks:**

- No-path output must not invent a path.
- Output should identify the searched source and destination nodes, ambiguity notes, and whether the shortest candidate was over cap.
- If possible, expose a bounded frontier: nearest callees from source, nearest callers of destination, and any semantic hyperedges touching either endpoint.
- Boundary output should distinguish “not modeled” from “not connected.”

**Required answer evidence atoms:**

- Source endpoint selected.
- Destination endpoint selected.
- Exact reason no path was returned: no edge, over cap, ambiguous endpoint, stale/unreadable source, or unsupported dynamic mechanism.
- Minimal next probe: `solidkg_node` on boundary node, `solidkg_precise_refs` for compiler refs, or qualified retry.

**Behavioral measurement plan:**

Run no-path and over-cap tasks. Measure whether agents stop with a correct boundary answer instead of doing blind grep/read.

**Falsifiers and negative controls:**

- Unconnected dynamic-dispatch fixture should produce no path plus a boundary, not a fabricated edge.
- False path fixture must not become “connected” due to frontier hints.

**TDD test plan:**

- Snapshot no-path output for static missing edge, over-cap path, ambiguous duplicate, and dynamic boundary.
- Ensure output remains bounded.

**Acceptance criteria:**

- In no-path tasks, agents can correctly answer “SolidKG does not model this hop; boundary is X→?” with no separate rediscovery for facts already in trace output.

**Why this preserves sufficient minimal evidence:**

It returns only boundary evidence around the attempted path, not a broad context dump.

**Existing tool or new primitive:** Existing tool improvement: `solidkg_trace`.

**Risks:** Frontier output can become mini-explore. Keep it capped and path-local.

---

### P1.2 — Tighten explore source-completeness accounting and per-file status

**Failure class:** Explore exposes source completeness, but some accounting conflates omitted clusters, skipped unreadable files, and actual truncation. Agents need exact enough status to trust “complete.”

**Affected implementation surfaces:**

- `src/mcp/tools.ts`
- `src/context/budget.ts`

**Current evidence:**

- `anyFileTrimmed` is set when chosen clusters are fewer than all clusters or a file section is tail-trimmed (`src/mcp/tools.ts:2371-2373`). This marks some omitted clusters as `truncated`, which is conservative but imprecise.
- `remainingRelevant = sortedFiles.slice(filesIncluded)` assumes `filesIncluded` maps to position in `sortedFiles` (`src/mcp/tools.ts:2426-2431`). If files are skipped due to unreadable/unresolvable source, `filesIncluded` can misclassify remaining/omitted files.
- Top-level completeness becomes `truncated`, `omitted`, or `complete` based on `anyFileTrimmed` and `hasOmittedFiles` (`src/mcp/tools.ts:2469-2478`).

**Task class:** Endpoint-unknown discovery/survey and explore-assisted endpoint-known flow.

**Required structural truth checks:**

- Track included, skipped, omitted, cluster-truncated, and file-tail-truncated files separately.
- Do not call output complete if any relevant file could not be resolved or read.
- Per-file headers should compactly show `complete`, `partial`, or `unreadable` when relevant.
- The “Not shown above” list must reflect actual omitted relevant files, not an index derived from successful read count.

**Required answer evidence atoms:**

- Top-level source completeness.
- Per-file status for included files when partial.
- Omitted file/symbol list for non-complete output.

**Behavioral measurement plan:**

A/B explore on large files, unreadable source roots, multi-root source paths, and small-file cases. Track fallback reasons and wrong completeness trust.

**Falsifiers and negative controls:**

- One unreadable relevant file should never yield `complete`.
- Dropping non-selected clusters should not be indistinguishable from tail-truncating a function body if the next action differs.
- Multi-root unlabeled paths should be omitted/unreadable, not silently skipped.

**TDD test plan:**

- Fixture with one skipped file before one included file.
- Fixture with a large file where non-entry clusters are omitted.
- Fixture with a monolithic function tail-trimmed.
- Fixture with whole-small-file inclusion proving complete.

**Acceptance criteria:**

- Explore completeness labels are structurally true in all test fixtures.
- Agent fallback decreases only when the output is actually complete or explicitly directs a focused follow-up.

**Why this preserves sufficient minimal evidence:**

It improves boundary/provenance evidence without widening source.

**Existing tool or new primitive:** Existing tool improvement: `solidkg_explore`.

**Risks:** More status text. Mitigate through one-line top-level status and terse per-file tags.

---

### P1.3 — Add implementation-level abstention for vague context queries

**Failure class:** Vague natural-language context can drift to the wrong feature. Current guidance encourages concrete symbols and framework keywords, but production behavior should not depend mainly on instruction salience.

**Affected implementation surfaces:**

- `src/context/index.ts`
- `src/context/formatter.ts`
- `src/db/queries.ts`
- `src/search/*` if query anchoring is implemented there

**Current evidence:**

- Guidance explicitly asks agents to include concrete symbols, classes, annotations, framework keywords, and file/package hints (`src/mcp/server-instructions.ts:63-65`; `src/installer/instructions-template.ts:52-55`).
- The research prompt specifically treats vague natural-language drift as a falsifier and says prompt steering is only an audit surface.

**Task class:** Endpoint-unknown discovery/survey.

**Required structural truth checks:**

- Query analyzer identifies low-anchor queries: no symbol-like token, no file/path, no framework keyword, no package hint, low exact-match confidence.
- Context output can abstain or qualify with candidate clusters instead of returning a confident wrong-feature context.
- Field filters/exact-name supplement should outrank fuzzy/LIKE fallback when concrete anchors are present.

**Required answer evidence atoms:**

- Query confidence/anchor summary.
- Candidate endpoints or files with reasons.
- Clear message when the query is too vague for faithful source evidence.

**Behavioral measurement plan:**

Compare context on vague prompts vs anchored prompts. Success is not “fewer reads”; success is fewer wrong-feature answers and fewer hallucinated endpoints.

**Falsifiers and negative controls:**

- Vague query “async queue flow” in a repo with several queues must not confidently choose an unrelated flow.
- Adding one concrete symbol should narrow output to the correct feature.

**TDD test plan:**

- Multi-feature fixture with overlapping terminology.
- Tests for vague abstention and anchored success.
- Search ranking tests for exact-name supplement and duplicate symbols.

**Acceptance criteria:**

- Vague-query negative controls abstain or return candidates with uncertainty.
- Anchored queries still return decisive minimal evidence.

**Why this preserves sufficient minimal evidence:**

Abstention prevents broad context and false certainty. It asks for or surfaces anchors instead of widening the search.

**Existing tool or new primitive:** Existing tool improvement: `solidkg_context`.

**Risks:** Too much abstention can reduce usefulness. Gate abstention on measurable ambiguity, not vague wording alone.

---

### P1.4 — Make SCIP-to-flow semantics explicit and conservative

**Failure class:** SCIP relationships are valuable compiler-grade facts, but they are not runtime flow unless SolidKG explicitly creates and labels graph/hypergraph edges that trace/context use.

**Affected implementation surfaces:**

- `src/scip/index.ts`
- `src/hypergraph/synthesizer.ts`
- `src/mcp/tools.ts`
- `src/context/formatter.ts`

**Current evidence:**

- SCIP implementation relationships become `dynamic_dispatch` semantic hyperedges with `provenance: 'scip'` and `confidence: 1` (`src/hypergraph/synthesizer.ts:55-88`).
- Heuristic `calls` edges become hyperedges (`src/hypergraph/synthesizer.ts:221-260`).
- Trace searches `calls` edges only (`src/mcp/tools.ts:1564-1574`), so SCIP-only implementation hyperedges do not necessarily create a traversable call path.

**Task class:** Endpoint-known flow and endpoint-unknown discovery.

**Required structural truth checks:**

- A SCIP implementation relationship is surfaced as a type/contract relation unless there is a structurally valid runtime call edge or explicitly supported dynamic dispatch edge.
- Trace should not silently treat type contract as runtime flow.
- Context/node should distinguish “implementation relationship” from “call path.”

**Required answer evidence atoms:**

- Contract symbol.
- Implementation symbol.
- SCIP provenance and occurrence site.
- Whether this is a runtime edge, a type contract, or a boundary fact.

**Behavioral measurement plan:**

Run interface/implementation questions and flow questions separately. Correct answers should not conflate “implements” with “is called at runtime.”

**Falsifiers and negative controls:**

- Interface has an implementation but no call site; trace must not claim runtime flow.
- Known interface dispatch with structurally valid call must show both call and contract evidence.

**TDD test plan:**

- SCIP relationship fixture with no call.
- Fixture with call through interface and implementation edge.
- Formatter snapshots distinguishing relation categories.

**Acceptance criteria:**

- No agent answer claims runtime reachability solely from SCIP implementation unless graph edges support that path.

**Why this preserves sufficient minimal evidence:**

It protects structural truth by naming exactly what SCIP proves and what it does not.

**Existing tool or new primitive:** Existing tool improvements. No new primitive justified.

**Risks:** Users may expect SCIP to “solve dispatch.” The output should show it as additive evidence, not hidden magic.

---

### P2.1 — Replace generic hyperedge prompts with repo-specific production eval cases

**Failure class:** The eval prompt families are semantically useful but too generic for headline claims. “Representative route/event/render/interface/bridge” prompts enable cherry-picking and do not encode exact evidence atoms.

**Affected implementation surfaces:**

- `scripts/agent-eval/hyperedge-prompts.json`
- `__tests__/agent-eval-hyperedges.test.ts`
- CI/release harness

**Current evidence:**

- The prompt file contains six generic semantic families: route handling, event emission, UI render, interface implementation, native bridge, and handler impact (`scripts/agent-eval/hyperedge-prompts.json:1-50`).
- The supplied archive did not include the referenced test file, so automated coverage could not be verified.

**Task class:** Both.

**Required structural truth checks:**

- Each eval case pins a repo, commit/sample version, source anchor, destination anchor, and expected graph facts.
- Expected nodes, edges, hyperedges, metadata, and source ranges are asserted before agent behavior is measured.
- Negative-control repos/cases assert no path.

**Required answer evidence atoms:**

Every agent task should have a machine-checkable checklist:

- Route/event/render/interface/bridge identifier.
- Registration/binding site.
- Handler/implementation site.
- Required path nodes.
- Forbidden hallucinations.

**Behavioral measurement plan:**

- Triage: n=2 runs per case.
- Headline: median-of-4 or stronger, with ranges.
- Always name host, model, harness, tool exposure, repo, and commit/sample.
- Compare against targeted `rg_read`/`diff_read`, not whole-repo reads.

**Falsifiers and negative controls:**

- Generic “representative” prompts cannot support production claims.
- Win disappears when instruction salience is removed.
- Agent uses zero Read/Grep but gives wrong answer.
- Hyperedge prompts pass only on tiny/easy repos.

**TDD test plan:**

- Add JSON schema for eval cases.
- Add structural preflight assertions.
- Add answer-checker rubric for evidence atoms.
- Add fallback reason tagging.

**Acceptance criteria:**

- No release claim can pass unless structural truth and answer correctness pass first.
- Behavioral metrics are reported only after correctness gates pass.

**Why this preserves sufficient minimal evidence:**

Eval cases enforce evidence atoms rather than rewarding broad output or low token count.

**Existing tool or new primitive:** Existing eval harness. No new product primitive.

**Risks:** More maintenance. Mitigate by keeping a small high-quality suite of canonical positives and negatives.

---

### P2.2 — Soften absolute trust guidance and align it with completeness/staleness/heuristic signals

**Failure class:** Some installer guidance tells agents to trust SolidKG and not re-verify with grep too absolutely. That conflicts with heuristic edges, stale indexes, omitted/truncated source, and local data-flow boundaries.

**Affected implementation surfaces:**

- `src/installer/instructions-template.ts`
- `src/mcp/server-instructions.ts`
- `AGENTS.md`
- `.cursor/rules/solidkg.mdc` if present in the full repo

**Current evidence:**

- Installer guidance says: “Trust solidkg results. They come from a full AST parse. Do NOT re-verify them with grep” (`src/installer/instructions-template.ts:56`).
- Server instructions are more nuanced: Read/Grep only to confirm a specific detail SolidKG did not cover; staleness banner identifies pending files (`src/mcp/server-instructions.ts:34-39`, `80-87`).

**Task class:** Cross-cutting.

**Required structural truth checks:**

- Guidance references source completeness, staleness, ambiguity, and heuristic provenance.
- Guidance does not imply heuristic dynamic-dispatch edges are compiler-grade.
- Guidance does not make Read/Grep=0 a primary success criterion.

**Required answer evidence atoms:**

N/A for a code answer, but guidance should teach agents to rely on evidence atoms, not trust slogans.

**Behavioral measurement plan:**

Run a small steering-contamination check: with and without installed guidance. Product wins should persist because tool output is sufficient.

**Falsifiers and negative controls:**

- Agents avoid Read on stale/omitted source and answer wrong.
- Zero-read wrong answers increase after guidance changes.

**TDD test plan:**

- Snapshot generated instructions.
- Contract tests that all target instruction files share the same trust wording.

**Acceptance criteria:**

Suggested replacement:

> Trust SolidKG for fresh, complete structural evidence it explicitly returns. Do not re-verify returned source or graph facts with grep. If output says stale, omitted, truncated, ambiguous, heuristic, or outside modeled data flow, follow that boundary signal with a focused SolidKG call or targeted Read of the named file/line.

**Why this preserves sufficient minimal evidence:**

It prevents guidance from masking missing evidence.

**Existing tool or new primitive:** Guidance-only audit fix. Do not count as headline product evidence.

**Risks:** Weaker wording may increase fallback until completeness signals improve. That is healthier than wrong zero-read answers.

---

### P2.3 — Harden multi-root source resolution through release tests

**Failure class:** Multi-root support is necessary for production monorepos, but resolver behaviors can fail closed in multi-root indexes without clear tests.

**Affected implementation surfaces:**

- `src/index.ts`
- `src/resolution/index.ts`
- `src/context/index.ts`
- `src/mcp/tools.ts`
- extraction source-root metadata

**Current evidence:**

- Source options are persisted and merged (`src/index.ts:369-407`, `520-522`).
- `getSourceRoots()` rebuilds roots from project root and extra roots (`src/index.ts:689-690`).
- `ReferenceResolver.listDirectories('')` resolves only through `resolveIndexedPath('')`; in multi-root/labeled cases this returns null and lists no directories (`src/resolution/index.ts:339-343`, `241-259`). This may be correct fail-closed behavior, but import/path resolver tests should prove no supported resolution path regresses.

**Task class:** Cross-cutting operational correctness.

**Required structural truth checks:**

- Labeled paths resolve to the correct physical root.
- Unlabeled paths in multi-root indexes abstain with visible status when source cannot be read.
- Old indexes without source metadata still work for single-root repos.
- Changing extra roots rebuilds resolver/context/orchestrator and persists metadata.
- `listDirectories('')` behavior is defined and tested for multi-root projects.

**Required answer evidence atoms:**

- Source path label.
- Physical source-read success/failure status.
- Staleness/completeness marker.

**Behavioral measurement plan:**

Monorepo fixture with two roots containing duplicate relative paths and symbols. Run trace/explore/context. Success is correct labeled source, not broad fallback.

**Falsifiers and negative controls:**

- Duplicate `src/App.tsx` across two roots returns the wrong source body.
- Unlabeled path silently reads from the wrong root.
- Context omits source without reporting unreadable/omitted status.

**TDD test plan:**

- Multi-root fixture with duplicate filenames and duplicate symbols.
- Resolver tests for `fileExists`, `readFile`, `listDirectories`, imports, path aliases.
- Trace/explore source inlining snapshots for `@rootA/...` and `@rootB/...`.

**Acceptance criteria:**

- No unlabeled ambiguous multi-root source read.
- Every source inlining path is either correct or visibly omitted/unreadable.

**Why this preserves sufficient minimal evidence:**

It prevents wrong source inlining, which is worse than no source.

**Existing tool or new primitive:** Existing source resolution hardening.

**Risks:** Fail-closed behavior may reduce source coverage until labels are propagated everywhere. That is preferable to false source evidence.

---

## 4. Release gates for serious production readiness

### Gate 0 — Build and package integrity

Required before any behavioral claim:

- `pnpm exec tsc` passes.
- `pnpm test` passes.
- Asset-copy/package tests pass for schema, native parser metadata, and target parser libraries.
- CLI/server entrypoints start under supported Node versions.
- Installer idempotency and uninstall tests pass for all supported agent targets.

Verification limitation from this review: the supplied archive did not include enough project/build/test material to run this gate.

### Gate 1 — Structural truth

No agent A/B metrics count until these pass:

- Expected nodes, edges, hyperedges, SCIP facts present.
- Path faithful and bounded.
- Wiring/provenance correct.
- Ambiguity handled by qualification or abstention.
- No false path on negative controls.
- No edge/hyperedge explosion.
- Stale-index and unreadable-source behavior visible.

### Gate 2 — Answer correctness

Every eval task needs machine-checkable answer atoms:

- Path nodes.
- Bridge/registration/binding site.
- Handler/implementation/render boundary.
- Source file/line where required.
- Forbidden hallucinations.

Read/Grep=0 only counts after this gate passes.

### Gate 3 — Investigation closure

Measure whether SolidKG made the agent stop for the right reason:

- Agent-side Read/Grep/Glob/Bash fallback count by reason.
- Total SolidKG calls.
- Total turns and wall-clock.
- Trace/context/explore adoption.
- Irrelevant files read.
- Cases where targeted Read is correct because SolidKG intentionally does not model local variable data flow.

### Gate 4 — Operational guardrails

- Payload size and cumulative tokens as secondary diagnostics.
- P95 tool latency and indexing/sync latency.
- Edge/hyperedge count deltas by mechanism.
- Staleness banner accuracy.
- Source completeness accuracy.
- Multi-root correctness.

---

## 5. Suggested TDD backlog

### Immediate P0 tests

1. `context-source-completeness.formatter.test.ts`
   - standard Markdown
   - minimal Markdown
   - standard JSON
   - minimal JSON
   - includeCode false
   - truncated code block
   - unreadable source

2. `trace-synth-edge-labels.test.ts`
   - table-driven for every `synthesizedBy` value.
   - asserts mechanism label plus required metadata atom.

3. `dynamic-dispatch-negative-controls.test.ts`
   - unrelated same-name events
   - duplicate JSX components
   - interface overload mismatch
   - RN same event/different module
   - Fabric suffix collision

4. `explore-source-completeness.test.ts`
   - whole small file is complete
   - large file partial cluster is partial/truncated with omitted areas
   - skipped unreadable file is omitted/unreadable
   - “Not shown above” list maps to actual omitted files

5. `multi-root-source-resolution.test.ts`
   - duplicate paths across roots
   - root-qualified source reads
   - unlabeled path abstention
   - legacy single-root index compatibility

### P1/P2 tests

6. `trace-no-path-boundary.test.ts`
   - static no path
   - dynamic unmodeled boundary
   - over-cap path
   - ambiguous endpoint

7. `context-vague-query-abstention.test.ts`
   - vague natural-language drift fixture
   - anchored version succeeds
   - field/exact-name filters beat fuzzy fallback

8. `scip-runtime-boundary.test.ts`
   - implementation relation without runtime call
   - interface dispatch with valid call path
   - formatter distinguishes contract relation from runtime flow

9. `agent-eval-case-schema.test.ts`
   - repo-specific anchors required
   - evidence atoms required
   - negative-control flags required
   - host/model/harness metadata required for result ingestion

---

## 6. Minimum acceptance criteria for a production-ready release

A production-ready SolidKG release should meet these criteria:

1. **No false path in negative controls.** A plausible but wrong path is a release blocker.
2. **Ambiguous duplicate endpoints never stitch confidently.** Trace/explore must qualify or abstain.
3. **Every source-bearing output has source completeness.** Context, explore, trace, and node should expose enough status to know whether returned source is complete for the claim being made.
4. **Every synthesized edge shown to the agent carries mechanism evidence.** Event/channel/render/interface/native bridge edges must name their binding evidence.
5. **SCIP facts are not presented as runtime flow unless graph semantics support that interpretation.**
6. **Agent closure is measured by reason, after correctness.** Zero Read/Grep is only success if the answer is structurally faithful.
7. **Eval cases are repo-specific.** Generic “representative” prompts are acceptable for smoke tests but not production claims.
8. **Multi-root source inlining is either correct or visibly omitted.** Never read the wrong file silently.
9. **Guidance does not override evidence.** Instructions should tell agents how to interpret completeness, staleness, ambiguity, and heuristic provenance; they should not say “trust” without conditions.
10. **Operational budgets are guardrails, not product goals.** Payload, token, and cost reductions are secondary diagnostics.

---

## 7. Recommended production-readiness roadmap

### Phase 1 — Trust calibration sprint

Ship before expanding more heuristics:

- Typed and formatted `sourceCompleteness` in context.
- Mechanism-complete `synthEdgeNote` coverage.
- Deduplication that preserves multiple synthesized-edge reasons.
- Explore completeness accounting fix.
- Absolute trust wording replaced with conditional evidence wording.

### Phase 2 — Dynamic-dispatch precision sprint

- Add positive/negative fixture matrix for all current mechanisms.
- Add import/receiver/signature/package tie-breakers where possible.
- Add explicit “boundary not modeled” output where precision would otherwise be low.
- Add edge/hyperedge explosion dashboards in CI.

### Phase 3 — Production eval sprint

- Convert semantic prompt families into repo-specific cases.
- Add structural preflight assertions.
- Add answer atom checker.
- Run n=2 triage and median-of-4 headline runs.
- Publish host/model/harness/tool exposure and fallback reasons.

### Phase 4 — Monorepo/source-root hardening

- Multi-root duplicate source fixtures.
- Source-option migration tests.
- Staleness/completeness tests across roots.
- Resolver `listDirectories` behavior contract.

---

## 8. Bottom line

The updated codebase shows the right product instinct: **make existing tools answer with sufficient, minimal, path-salient evidence**. Trace and explore are notably closer to production-grade behavior than a generic graph browser would be.

The remaining gap is production trustworthiness. Serious users will not judge SolidKG by whether it can produce a plausible graph story on a demo repo. They will judge it by whether it refuses wrong paths, exposes incomplete evidence, names dynamic bridge provenance, and lets an agent stop investigating only when the returned evidence is actually sufficient.

The next release should therefore be framed as a truth-and-closure release, not a token-efficiency release.
