# Seven-arm matched OpenCode benchmark - 2026-07-12

For a shorter contextual presentation of the results, costs, and metric definitions, open [`opencode-seven-arm-2026-07-12-presentation.html`](opencode-seven-arm-2026-07-12-presentation.html).

This local diagnostic compared baseline OpenCode with SolidKG core, SolidKG plus SCIP, CodeGraph, Sverklo, Cartog, and Tilth on ten repository-specific architecture questions. Every launchable repository-arm cell used `openai/gpt-5.6-sol` at high effort for four repeats. The study measures answer quality, agent burden, direct MCP latency, and availability separately; it does not rank products universally and is not independently reproducible from this repository alone.

## Design and denominators

- 10 repositories x 7 arms x 4 repeats = 280 scheduled cells.
- 276 cells completed. CodeGraph's four .NET Runtime cells were retained as terminal unavailable after indexing failed; they were not retried or silently excluded.
- Two independent blinded SOL-high reviewers scored all 276 answers. One separate SOL-high session adjudicated the 269 answers with a disagreement in a scored field. Reviewer notes alone did not trigger adjudication.
- Mechanism precision counts supported versus unsupported source-grounded assertions. Mechanism recall scores the frozen expected rubric. F1 is their harmonic mean. Citation precision is separate.
- Session comparisons are paired by repository and repeat. Uncertainty uses a fixed-seed 10,000-resample 95% repository-cluster bootstrap, exact repository sign flips, and Holm correction across the full comparison-endpoint family.
- Direct MCP latency contains four process-level repeats. Preparation/indexing time is excluded because its recorded host load was not quiet enough for fair timing.

## Main results

Answer quality was near ceiling for every arm, so this corpus does not support a broad claim that one product produced better explanations. Mean mechanism F1 ranged from 97.1% to 98.1%; the paired median F1 difference from baseline was zero for every arm.

| Arm | Completed | Mean F1 | Mean tokens | Tools/task | Session wall time | Availability |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 40 | 97.5% | 96,050 | 15.1 | 57.9 s | 100% |
| SolidKG core | 40 | 97.1% | 72,755 | 4.8 | 67.4 s | 100% |
| SolidKG + SCIP | 40 | 97.2% | 84,166 | 4.0 | 59.8 s | 100% |
| CodeGraph | 36 | 98.0% | 89,552 | 13.8 | 65.6 s | 90% |
| Sverklo | 40 | 98.1% | 109,315 | 15.1 | 78.6 s | 100% |
| Cartog | 40 | 97.4% | 124,735 | 15.9 | 74.0 s | 100% |
| Tilth | 40 | 98.1% | 107,748 | 14.2 | 74.7 s | 100% |

The strongest descriptive SolidKG signal was tool economy against baseline. SolidKG core used a paired median 8 fewer tool calls per task (70.0% lower; 95% repository-cluster bootstrap interval -13 to -6). SolidKG + SCIP used 8.5 fewer (71.0% lower; interval -17 to -6). For both comparisons, the raw exact sign-flip p-value was 0.00195, but the predeclared Holm-adjusted p-value across the full endpoint family was 0.140625. These are therefore descriptive effects, not multiplicity-adjusted statistical findings. Both reductions came primarily from replacing direct reads and greps with a small number of graph calls.

Tokens and end-to-end wall time did not show the same general reduction. Relative to baseline, SolidKG core's paired median token difference was +0.2% and session time +9.6%; SolidKG + SCIP was +11.5% tokens and +2.2% session time. Their bootstrap intervals crossed zero. Repository effects were substantial: on VS Code, SolidKG core averaged 70,897 tokens and 3.0 tools versus baseline's 268,642 tokens and 29.3 tools, while smaller or different codebases often showed no token advantage. Session duration is an observed model endpoint, not a developer-productivity measure.

## API-equivalent cost estimate

The raw trajectories preserve non-cached input, cached input, output, and reasoning token categories. Applying OpenAI's GPT-5.6 Sol Standard short-context rates checked July 12, 2026 ($5.00/M non-cached input, $0.50/M cached input, $6.25/M cache writes, and $30.00/M output/reasoning) gives the following mean API-equivalent cost per completed task:

| Arm | Estimated cost | Difference from baseline |
|---|---:|---:|
| Baseline | $0.2316 | baseline |
| SolidKG core | $0.2124 | 8.31% less |
| SolidKG + SCIP | $0.2179 | 5.92% less |
| CodeGraph | $0.2249 | 2.93% less |
| Sverklo | $0.2593 | 11.95% more |
| Cartog | $0.2789 | 20.38% more |
| Tilth | $0.2450 | 5.77% more |

These are API-equivalent estimates, not observed charges: the OpenCode subscription path recorded $0. CodeGraph's mean covers its 36 completed cells. Elapsed session time is not monetized. Official sources: [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## Direct MCP latency

| Arm | First retrieval p50 | Warm retrieval p50 |
|---|---:|---:|
| SolidKG core | 5,022 ms | 1,212 ms |
| SolidKG + SCIP | 5,402 ms | 1,081 ms |
| CodeGraph | 7,290 ms | 2,349 ms |
| Sverklo | 200 ms | 100 ms |
| Cartog | 1,351 ms | 37 ms |
| Tilth | 14,844 ms | 239 ms |

Sverklo and Cartog had the lowest direct retrieval medians. This did not translate mechanically into shorter model sessions, which also include tool selection, fallback behavior, reasoning, and answer generation.

These latency values are descriptive p50s from four process-level repeats. The full local analysis also retains p95 and p99 values; the small repeat count and single host limit generalization.

## Repository and prompt matrix

| Repository | Frozen architecture question |
|---|---|
| Azure PowerShell | How `InvokeAzRestMethodCommand` validates parameters, initializes its service client, and executes the cmdlet |
| Apache Airflow | How `DagBag.process_file` collects, parses, validates, and bags DAG files |
| VS Code | How the extension host communicates with the main process |
| Kubernetes | How kube-apiserver builds and executes its HTTP handler chain |
| Rust | How rustc runs compilation from `RunCompiler` through its query context |
| Spring Framework | How `DispatcherServlet.doDispatch` selects a handler and renders a result |
| Laravel | How the HTTP kernel bootstraps, applies middleware, routes, and prepares a response |
| Rails | How Journey routes an HTTP request to a controller endpoint |
| .NET Runtime | How `RuntimeType` exposes and uses `MethodTable` information |
| React Native | How a `NativeModules` call reaches an iOS exported implementation |

The frozen specification hash was `87b5ee98cb1be006d7a6c5d4c32033eb3f1276ea968c4bcb3367baca76252d0e`. The captured environment was Windows `10.0.26200`, Node `24.12.0`, OpenCode `1.17.18`, and a 13th Gen Intel Core i9-13950HX. Source snapshots were fingerprinted, but several had no Git revision; the exact raw trajectories and source snapshots are not checked into this repository.

## Interpretation and limits

- The benchmark asks one architecture-explanation question per repository. It does not test generated patches, build success, regressions, security, maintenance work, or human productivity.
- One model, one host, and four repeats per cell limit generalization. Repository-cluster inference has only ten clusters, or nine for CodeGraph comparisons.
- Quality was ceiling-limited. The benchmark is more informative about interaction burden than subtle answer-quality differences.
- Judging used independent blinded AI sessions from the same model family, followed by separate adjudication. Agreement statistics describe AI-review consistency, not human agreement.
- Sverklo supports all benchmark languages, but through different parser tiers: tree-sitter-capable support for TypeScript/TSX, JavaScript, Python, Go, Rust, and C#, with regex fallback for PHP, Java, Ruby, and other registered languages. The benchmark did not prove which parser handled each runtime cell.
- CodeGraph's .NET Runtime result is an availability observation for this frozen setup, not a claim that CodeGraph cannot support C# generally.
- Observed subscription billing was $0; API-equivalent costs above are calculated from raw token categories and official rates rather than observed charges.
- Preparation indexing durations are provenance only and are not compared.

The complete local evidence package preserves the frozen plan, 283 raw attempts, invalidations and corrections, 552 independent review rows, 269 adjudications, four latency repeats, accessible SVG/CSV/JSON figures, and the unwatermarked analysis under `D:\tmp\opencode\five-product-benchmark-2026-07-11`. The study began July 11 and publication validation completed July 12. That machine-local path is provenance, not a public evidence archive. The report was generated only after its completeness validator accepted all 280 terminal cells and every review/adjudication requirement, but the absence of versioned raw trajectories and source snapshots means this remains a bounded local diagnostic.

## Next work

1. Add implementation tasks with build/test outcomes; the current study covers explanation tasks only.
2. Use at least three prompts per repository and expand beyond ten repository clusters before drawing broader quality or timing conclusions.
3. Version or publish redacted raw trajectories, source fingerprints, resolved configs, and analysis inputs so the study can pass a reproducibility passport.
4. Re-run direct latency and indexing measurements on a quiet host with preparation time measured separately from agent-session time.
5. Pre-register a smaller primary endpoint family so multiplicity correction matches the claims the study is intended to test.
6. Test whether fewer tool calls improve patch correctness, regression rate, or task completion; do not infer those outcomes from architecture explanations.
