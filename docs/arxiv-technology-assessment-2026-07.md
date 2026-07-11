# ArXiv technology assessment for SolidKG

Date: 2026-07-10

## Bottom line

The supplied papers do not justify a large new production subsystem. The useful pieces are narrower:

1. **InductWave** suggests valuable graph-growth and graph-damage evaluation, plus a lower-priority experiment with cheap structural retrieval features. Its neural wavelet query-answering model is not a good production fit.
2. **The Isolation Lemma paper** does not fit SolidKG retrieval. At most, it motivates deterministic tie/stability instrumentation; randomized tie-breaking would weaken replay and ambiguity handling.
3. **Induced packing treewidth** does not fit current SolidKG workloads. Its undirected decomposition parameters and quasipolynomial MWIS/coloring/OCT algorithms do not address code retrieval, directed flow, or incremental indexing.
4. **Maximum Acyclic Subgraph above MaxST** has one plausible offline use: explainable package/layer dependency-cycle remediation on small strongly connected components. Its exact FPT/XP algorithms are not suitable for online traversal or retrieval.

The stronger opportunities came from the wider arXiv scan:

- metamorphic graph-correctness testing without ground truth;
- contamination-resistant, graded repository-retrieval evaluation;
- adaptive deterministic fusion and cross-channel disagreement mining;
- compact evidence packets and intention-aware source selection;
- explicit query-concept coverage in answer packets;
- explicit AST/SCIP reconciliation, ambiguity, and abstention metrics.

These target the most important current pressure. In the 2026-07-10 OpenCode diagnostic, CodeGraph used about **59% fewer tool calls and 59% fewer tokens** than SolidKG across all seven repository medians, while the sampled answer quality was similar. SolidKG also used 12.4% more tokens than the no-graph arm on average. The report lacks raw runs and the exact benchmark binary, and run variance was material, so it does not establish the cause of the gap. The leading hypothesis is that call sequencing and first-packet allocation matter, but candidate recall, payload size, sufficiency signals, tool instructions, and agent planning must be measured separately before selecting an intervention. See [the head-to-head report](benchmarks/opencode-head-to-head-2026-07-10.md).

## Supplied papers

### 1. InductWave: useful evaluation ideas, not a production model

Paper: [InductWave: Inductive Multi-Hop Logical Query Answering on Knowledge Graphs](https://arxiv.org/html/2607.07422v1), `cs.AI`, `cs.IR`.

InductWave builds direction- and relation-aware wavelet features over a knowledge graph, mixes them with learned filters, and executes fuzzy existential first-order queries. Its main practical result is that two- and three-layer variants can remain competitive as the test graph grows beyond the training graph. At a 175% graph ratio, the three-layer model reported HITS@10 of 45.5 versus 44.8 for GNN-QE; the two-layer model reached 38.2 versus 36.4 at 300%. It also reduced reported per-epoch memory from 20.16 GB to 7.57 GB or 5.63 GB, with a one-time wavelet preprocessing cost.

What is useful:

- Add **real-history growth evaluation**: index successive commits, compare incremental sync with a fresh index at each final state, and measure retrieval behavior as the repository grows. This is independently motivated; SolidKG has no trained default model to test for neural induction.
- Add **mechanism-specific damage evaluation**: disable or remove one evidence family at a time, such as callbacks, framework routes, SCIP links, or a language feature, and measure whether outputs correctly become partial or abstain instead of fabricating a path. Random edge removal is only a secondary sensitivity test.
- Test cheap structural features before wavelets: incoming/outgoing edge-kind histograms, multiscale degree features, and query-personalized structural scores.

What is not useful:

- CUDA/A100 training, fuzzy truth values, GE-SpMM, and global spectral preprocessing conflict with the local Node/SQLite runtime.
- The paper solves missing-link logical query answering, not source-grounded code retrieval.
- Structural role similarity is not semantic code relevance; unrelated functions often have similar graph shapes.
- Pairwise Laplacians discard the ordering and roles in SolidKG semantic hyperedges.

Verdict: **adopt the evaluation methodology; run a bounded structural-feature ablation only after simpler retrieval work.**

### 2. Singleton hypergraph Isolation Lemma: no production adoption

Paper: [The singleton hypergraph is extremal for the Isolation Lemma](https://arxiv.org/html/2607.06171v1), `math.CO`, `cs.DS`.

The paper proves a tight lower bound for obtaining a unique minimum edge in an inclusion-free hypergraph after assigning independent random weights. The exact guaranteed count is `n * sum(j^(n-1), j=0..d-1)` out of `d^n` assignments. For fixed `n` and large `d`, its leading approximation is `1 - n/(2d)`, versus the classical leading bound `1 - n/d`.

SolidKG does not optimize over a fixed family of additive, unordered subsets. It ranks symbols, files, ordered paths, and role-bearing hyperedges. Random uniqueness would not imply relevance or correctness, and it could hide genuine ambiguity while making runs harder to reproduce.

The only useful transfer is measurement:

- record score ties and top-k boundary ties;
- measure ranking stability under harmless insertion-order or worker-count changes;
- keep deterministic IDs as the final tie-breaker;
- never reinterpret a forced unique winner as evidence that ambiguity disappeared.

Verdict: **do not add randomized isolation; optionally add no-output-change tie/stability tests.**

### 3. Induced packing treewidth: theoretically adjacent, operationally irrelevant

Paper: [Induced packing treewidth](https://arxiv.org/html/2607.07595v1), `math.CO`, `cs.DM`, `cs.DS`.

The paper defines a structured tree-decomposition parameter and derives quasipolynomial algorithms or approximation schemes for MWIS, List 3-Coloring, Odd Cycle Transversal, and related CMSO2 problems. Computing the decomposition is itself expensive: the paper gives a `2^O(k^2) n^O(k)` approximation and proves strong hardness results.

Possible analogy - recursively compressing a graph around balanced separators - is too weak to justify work. SolidKG's graph is directed, typed, source-addressable, and queried for exact evidence. There is no evidence that induced packing treewidth is small on code graphs, that its separators preserve query evidence, or that computing it beats the current bounded personalized file-graph ranking.

Verdict: **no action.**

### 4. MAS above MaxST: a narrow architecture-analysis experiment

Paper: [Exploiting Spanning Trees for Directed Acyclicity](https://arxiv.org/abs/2607.07705), `cs.DS`.

The paper studies weighted Maximum Acyclic Subgraph relative to the weight of a maximum spanning tree. It provides an FPT algorithm for positive integer weights and an XP algorithm for rational weights at least one. Useful concepts include:

- classifying non-tree edges as allowed or blocked relative to a directed MaxST;
- associating each tree edge with inverse edges that become admissible if it is removed;
- an explainable profit `weight(unblocked edges) - weight(removed tree edge)`;
- decomposing the tree into directed paths;
- a perfect overlap graph for certain inverse-edge choices.

The plausible SolidKG use is offline package/layer analysis. Build a directed package dependency graph, weight an edge by distinct importing files or resolved cross-package references, and ask which low-value dependencies should be removed to retain a high-weight DAG. The MaxST skeleton and inverse-edge profits could produce an explanation rather than only a cycle list.

This is an experiment, not a roadmap commitment:

- real dependency remediation usually wants feedback-arc/feedback-vertex solutions over SCCs, not an above-MaxST decision problem;
- the FPT bound is very large and uses a weighted directed feedback-arc-set subroutine;
- the paper has no implementation or engineering benchmark;
- removing an edge from an analysis graph does not explain the source refactor needed to remove the dependency.

Verdict: **prototype only on recorded package SCCs if dependency-cycle remediation becomes a product goal. Do not use it in online trace, impact, or retrieval.**

## Strongest ideas from the wider arXiv scan

The local arXiv MCP server was used to screen 130 recent results across `cs.SE`, `cs.PL`, `cs.LO`, `cs.IR`, `cs.DB`, `cs.IT`, `cs.DS`, `cs.DC`, `cs.PF`, `cs.AI`, `cs.LG`, `cs.CL`, and `cs.SI`, with additional primary-paper checks in `cs.DM` and `cs.FL`. The supplied papers and the main code-intelligence/retrieval candidates received full-text review; several benchmark and watchlist items were assessed from abstracts plus focused primary sections. None of the paper results were independently reproduced here, so reported numbers motivate experiments rather than implementation priority by themselves.

### P0: determinism/invariance checks plus ground-truthed graph quality

Paper: [Detecting Call Graph Unsoundness without Ground Truth](https://arxiv.org/html/2604.00885v1).

Across four Java analyzers and more than 125 programs, supposedly comparable or more precise configurations produced large semantic inconsistencies. WALA object sensitivity produced 516 violations and only 39.1% similarity to baseline; nominally equivalent Soot/SootUp graphs were only 31.7%-33.2% similar.

This transfers directly to SolidKG:

- a fresh index and incremental sync over the same final source should produce the same deterministic AST facts;
- repeated indexing should be idempotent;
- parse-worker count/order should not change graph facts;
- enabling a heuristic synthesizer should only add correctly tagged facts from that mechanism;
- adding SCIP should not silently turn type/implementation facts into runtime calls;
- snapshots should expose every unexpected edge/node/hyperedge delta.

These are determinism and invariance checks, not proof that the stable graph is correct. Pair them with ground-truthed extraction fixtures, expected-edge recall, sampled edge precision, negative paths, framework-specific probes, and explicit coverage metrics. This combined acceptance gate is more valuable than adding another retrieval algorithm because it strengthens the evidence beneath every benchmark.

### P0: harder, graded retrieval evaluation

Papers:

- [Beyond Retrieval: A Multitask Benchmark and Model for Code Search (CoREB)](https://arxiv.org/abs/2605.04615)
- [ReCUBE](https://arxiv.org/html/2603.25770v1)
- [StackRepoQA](https://arxiv.org/abs/2603.26567)
- [Diagnosing Evidence Utilization / ONCU](https://arxiv.org/abs/2606.06758)

CoREB contains 5,087 queries derived from 342 seed problems, with multiple execution-verified positives and plausible hard negatives. Every tested model collapsed on short, developer-style queries: nDCG@10 was 0.000-0.015, and hard-negative intrusion exceeded 55%.

ReCUBE masks files in real repositories and tests reconstruction with cross-file integration tests. GPT-5 achieved only 37.57% strict pass in full-context mode; a caller-centric graph toolkit improved strict pass by up to 7.56%.

StackRepoQA contributes 1,318 real developer questions across 134 Java projects and explicitly audits memorization of Stack Overflow answers. ONCU contributes a four-arm protocol - no evidence, full context, retrieved evidence, oracle evidence - that separates retrieval availability from whether the model actually uses the evidence.

Recommended benchmark changes:

- long, terse, and counterfactually rewritten versions of each prompt;
- multiple required source anchors, graded useful context, and explicit misleading hard negatives;
- same-name/wrong-file and generated/test-file distractors;
- no-evidence/full-context/retrieved/oracle conditions;
- correctness and evidence-atom checks before token or tool-call wins count;
- caller-centric weighting as an ablation, not an assumed universal rule;
- held-out repositories and time-split tasks to reduce contamination.

Ownership must remain explicit. SolidKG owns evidence availability, required-anchor coverage, provenance, packet size, and truthful sufficiency. Whether the model actually uses supplied evidence is an interaction-level outcome measured by ONCU-style arms; planning, transcript memory, and final reasoning remain host-agent responsibilities.

### P1, conditional: adaptive deterministic fusion and disagreement mining

Paper: [vstash: Local-First Hybrid Retrieval with Adaptive Fusion for LLM Agents](https://arxiv.org/html/2604.15484v1).

vstash is the closest systems analogue to SolidKG, but its evidence is document retrieval rather than repository flow. Its combined adaptive system reported NDCG@10 gains on five BEIR datasets. The largest, 21.4% on ArguAna, was attributed mainly to a much wider long-query distance cutoff rather than IDF weighting alone. Sparse/dense disagreement occurred on 541 of 753 queries and produced 75,981 pseudo-negative training triples; these are useful disagreement candidates, not verified hard negatives. Cross-encoder rerankers added 560-2100 ms while slightly reducing quality in the reported setup.

SolidKG has two different boundaries that should not be conflated:

- `RetrievalCandidateChannel.searchCandidates` and `HybridRetrievalConfig` in `src/types.ts:634-652` are a disabled future **external** `dense | reranker` seam; current status remains hard-coded `disabled` in `src/types.ts:666-671`.
- Local exact/FTS, source-body, and graph-ranked fusion lives in the existing retrieval pipeline around `src/context/index.ts:895` and `src/mcp/explore-graph-rank.ts:16`.
- deterministic retrieval metrics in `scripts/retrieval-quality/report.mts:41`.

The first experiment should not add vectors or use the external-provider seam. If baseline attribution shows required-anchor misses, compare current local fusion with an IDF-gated, lower-salience source-body boost while exact symbol/path/trace evidence retains precedence. More importantly, use disagreement between exact/FTS, source-body, and graph channels to mine candidate hard prompts, then label them before treating them as hard negatives.

Success requires better required-anchor recall and fewer tool calls/Read/Grep on held-out repositories, with no exact-intent, negative-control, latency, or payload regression.

### P1: compact, intention-aware evidence packets

Paper: [ContextSniper](https://arxiv.org/html/2607.01916v3).

ContextSniper indexes code and action memory at three abstraction levels, uses hybrid retrieval, filters long tool output through an intention-aware gate, and returns compact evidence while keeping full source recoverable. In its self-reported 50-task-per-condition SWE-bench Lite comparison, it reported token reductions of 51.5% for OpenClaw and 38.9% for Claude Code with essentially unchanged submitted-resolution rates. This is a strong design analogue, not independent proof that the same gains transfer to SolidKG.

The product boundary matters:

- SolidKG should own the **first source-grounded packet**: selected source spans, graph/path evidence, completeness, provenance, and an on-demand route to more source.
- The host agent should own shell-output filtering, action memory, iterative planning, execution feedback, and cross-task experience.

SolidKG already approximates this design through `solidkg_explore`, answer packets, source completeness, and full-source recoverability. The experiment is to compare current output allocation with explicit three-level packets - symbol/file synopsis, decisive span/path, and on-demand full source - against CodeGraph and no-graph controls. Do not add persistent action memory to the graph engine.

### P1: query-concept coverage in answer packets

Paper: [XSearch](https://arxiv.org/html/2605.16046v2).

XSearch decomposes a query into functional concepts and aligns each concept to implementing spans. It reported OOD MRR of 0.332 versus 0.240 for a 7B Qwen retriever, alignment Recall@3 above 0.88, and a user-study accuracy increase from 69.5% to 80.0% with 38% less time.

The neural model is not the transfer. The useful idea is a deterministic coverage check:

- parse a prompt into two to five required concepts or constraints;
- map each to a symbol, path, source-body chunk, semantic relation, or capability assertion;
- penalize a result that matches the topic but omits a required concept;
- show uncovered concepts as bounded uncertainty instead of declaring the packet sufficient.

Test on 50-100 labeled prompts before changing product ranking.

### P0/P1: reconciliation, ambiguity, and abstention as first-class evidence

Paper: [CoCoMUT](https://arxiv.org/html/2606.31971v1).

CoCoMUT reconciles stable compiled identities with source identities only when matching is unique, recording ambiguity, unresolved reasons, confidence, provenance, and schema version. Across 20 Java repositories it reported 56,512 method records, 386,048 call edges, 97.8% reconciliation of recognized project targets, and 198/200 sampled records passing audit.

SolidKG should adopt the reporting pattern whenever SCIP is enabled, not assume the underlying call graph is sound or import the Java-specific 97.8% expectation:

- expose AST-to-SCIP link rate, ambiguity candidates, and abstention reasons;
- separate `linked`, `ambiguous`, `unsupported`, and `not observed`;
- never infer runtime flow solely from a compiler implementation relationship;
- sample correctness independently from coverage.

### P2/watchlist

- **Grammar-constrained CFL reachability** ([2602.23401](https://arxiv.org/abs/2602.23401)) could support a future typed path-query IR, for example `route -> middleware* -> handler -> service`. It is not needed for the current single-path `calls` trace until users require richer constrained paths.
- **GraphAlg** ([2601.06705](https://arxiv.org/abs/2601.06705)) suggests semiring traversal and sparsity-aware execution. Benchmark recursive CTE and temporary-frontier variants before considering any DSL or compiler.
- **Query-centric optimization** ([2607.00254](https://arxiv.org/abs/2607.00254)) may reduce offline judge calls through sequential stopping. It must not approximate live MCP answers.
- **HypRAG** ([2602.07739](https://arxiv.org/abs/2602.07739)) is unjustified unless measured code-hierarchy curvature predicts retrieval errors that deterministic graph traversal cannot solve.
- **Incremental GNN embeddings** ([2603.20622](https://arxiv.org/abs/2603.20622)) reported 64%-99% less computation and 1.7x-145.8x speedups, but it matters only if a learned embedding channel survives earlier evaluation. It does not justify adding GNNs by itself.
- **AgentFlow** ([2607.01640](https://arxiv.org/html/2607.01640v1)) could motivate framework resolvers for agent programs, prompts, tools, memory, and policies. That is a product-scope decision, not a retrieval fix.
- **MemCoder** ([2603.13258](https://arxiv.org/abs/2603.13258)) and local multi-agent review systems belong primarily to the agent/harness layer, not SolidKG's deterministic repository index.

## Recommended experiment order

1. **Baseline attribution and reproducibility:** archive exact binaries and raw logs, then explain the CodeGraph gap by call sequence, graph-call count, payload size, required-anchor coverage, answer-packet state, and follow-up behavior.
2. **Graph acceptance gate:** combine fresh-index/sync equivalence, idempotence, worker-order independence, and provenance invariants with ground-truthed precision/recall fixtures, negative paths, framework probes, and SCIP reconciliation accounting.
3. **Retrieval benchmark gate:** CoREB-style short/counterfactual queries, graded anchors, hard negatives, StackRepoQA/ReCUBE tasks, and ONCU four-arm evidence utilization.
4. **Packet compaction on the default surface:** ContextSniper-style abstraction levels and intention-aware span selection in the existing `solidkg_explore` response, compared directly with CodeGraph and no graph.
5. **Adaptive local fusion, only if attribution shows anchor misses:** IDF-gated source-body contribution plus labeled cross-channel disagreement cases, without vectors.
6. **Concept coverage, only if required constraints remain missing:** deterministic required-concept mapping and uncovered-concept uncertainty.
7. **Conditional offline trials:** package-cycle MAS/MaxST, CFL path grammar, traversal execution variants, and structural diffusion features.

Any retrieval intervention must improve the existing default `solidkg_explore` call with the natural-language inputs agents already provide. A new tool, external channel, or instruction-dependent workflow would not address the measured product surface.

### Decision bars

| Experiment | Ship/continue bar | Reject or rethink when |
|---|---|---|
| Baseline attribution | At least four archived runs per arm, raw call sequences and payload sizes, exact binary hashes, and the directional gap reproduced on most repository medians. | The gap does not reproduce or cannot be localized to a product-controlled surface. |
| Graph acceptance | Exact equality for canonical deterministic facts after fresh versus sync indexing, zero false paths in negative fixtures, and explicit precision/recall/coverage reporting. | Stable outputs still miss expected edges, add confident false edges, or conceal ambiguous SCIP links. |
| Packet compaction | No new answer failures, evidence-atom accuracy non-inferior, median cumulative packet bytes/tokens and graph calls reduced on most repositories, and p95 latency within a pre-registered budget. | Savings come from omitted required anchors, misleading sufficiency, or host-only behavior. |
| Adaptive fusion | Required-anchor recall improves on held-out repositories without exact-intent, hard-negative, latency, or payload regression. | The attribution study shows no anchor-recall problem, or gains disappear outside training repositories. |
| Concept coverage | Missing-required-concept rate falls on labeled prompts without widening packets or increasing false anchors. | Concept parsing is unstable, model-dependent, or duplicates existing exact/path evidence. |
| SCIP reconciliation | Every ambiguous negative control abstains; per-language link, ambiguity, abstention, and sampled precision are reported separately. | A coverage number is presented without sampled correctness or runtime-flow boundaries. |

Every experiment should preserve the existing order of proof:

1. structural truth;
2. answer correctness;
3. evidence utilization and investigation closure;
4. tool calls, Read/Grep, latency, payload, tokens, and cost.

No idea should ship solely because it lowers token count or creates a plausible graph story.

## Implemented outcome

The first bounded integration is recorded in [the research integration benchmark](benchmarks/research-integration-2026-07-10.md). It adds canonical fresh-index/sync graph fingerprints, graded source judgments, explicit exclusion handling, and counterfactual concept coverage on the existing `solidkg_explore` surface. The finished-build sweep returned required source for all four ordinary probes and calibrated both counterfactual misses as partial instead of sufficient. The misses remain an explicit retrieval gap; no neural, vector, randomized, or new-tool subsystem was adopted.
