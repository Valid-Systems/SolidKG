# SolidKG vs CodeGraph on OpenCode — 2026-07-10

This diagnostic compares SolidKG, [CodeGraph](https://github.com/colbymchenry/codegraph), and a no-graph control using the same repositories, questions, model, and tools.

## Bottom line

**CodeGraph used 59% fewer tool calls and 59% fewer tokens than SolidKG on average. It won both measures on all seven repositories.**

Each number is the median of four runs. **Lower is better; bold marks the better result.**

| Repository | SolidKG tool calls | CodeGraph tool calls | SolidKG tokens | CodeGraph tokens |
|---|---:|---:|---:|---:|
| VS Code | 25 | **11.5** | 294,564 | **166,485** |
| Excalidraw | 13 | **11** | 213,494 | **99,814** |
| Django | 6.5 | **2** | 105,313 | **45,594** |
| Tokio | 4 | **2** | 106,853 | **46,653** |
| OkHttp | 6.5 | **2** | 104,932 | **45,477** |
| Gin | 6 | **2.5** | 88,574 | **39,196** |
| Alamofire | 17.5 | **1** | 236,807 | **23,899** |

Tool calls are agent actions such as graph queries, reads, and searches. Tokens are the total model input, output, and cache tokens reported across a run.

The 59% figures are calculated in two steps: take the four-run median for each repository, calculate CodeGraph's percentage reduction from SolidKG, then average the seven repository percentages equally.

## Compared with no graph

| Average change vs no graph | Tool calls | Reads | Grep / Glob | Tokens |
|---|---:|---:|---:|---:|
| SolidKG | 47.9% fewer | 83.2% fewer | **93.7% fewer** | 12.4% more |
| CodeGraph | **79.9% fewer** | **86.7% fewer** | 93.2% fewer | **54.6% fewer** |

Both graph tools greatly reduced direct file discovery. SolidKG made slightly fewer Grep/Glob calls, while CodeGraph used fewer total tool calls, reads, and tokens.

## Full results

Each cell is the median of four successful runs. Lower is better within each repository; bold marks the best arm. Elapsed time is omitted because concurrent runs on a busy host do not support a fair speed comparison.

| Repository | Arm | Tools | Reads | Grep / Glob | Tokens |
|---|---|---:|---:|---:|---:|
| VS Code | SolidKG | 25 | 11 | 2.5 | 294,564 |
|  | CodeGraph | **11.5** | **5.5** | **2** | **166,485** |
|  | No graph | 22.5 | 14.5 | 7.5 | 180,659 |
| Excalidraw | SolidKG | 13 | **0** | **0** | 213,494 |
|  | CodeGraph | **11** | 8.5 | 1.5 | **99,814** |
|  | No graph | 32 | 19 | 14 | 273,801 |
| Django | SolidKG | 6.5 | **0** | **0** | 105,313 |
|  | CodeGraph | **2** | **0** | **0** | **45,594** |
|  | No graph | 16.5 | 11.5 | 5 | 103,345 |
| Tokio | SolidKG | 4 | **0** | **0** | 106,853 |
|  | CodeGraph | **2** | **0** | **0** | **46,653** |
|  | No graph | 27.5 | 19.5 | 8 | 267,644 |
| OkHttp | SolidKG | 6.5 | **0** | **0** | 104,932 |
|  | CodeGraph | **2** | **0** | **0** | **45,477** |
|  | No graph | 14.5 | 9.5 | 5.5 | 73,686 |
| Gin | SolidKG | 6 | **0** | **0** | 88,574 |
|  | CodeGraph | **2.5** | 1 | 0.5 | **39,196** |
|  | No graph | 14 | 9.5 | 5 | 75,921 |
| Alamofire | SolidKG | 17.5 | 6.5 | 1 | 236,807 |
|  | CodeGraph | **1** | **0** | **0** | **23,899** |
|  | No graph | 24.5 | 15.5 | 9 | 163,321 |

## How we ran it

- OpenCode 1.17.18 through the OpenAI subscription path.
- Model: `openai/gpt-5.6-sol`, selected only through the CLI model flag.
- 84 successful runs: 7 repositories × 3 arms × 4 repeats.
- Identical built-in tools and permissions; edits, tasks, skills, web access, automatic compaction, LSP, and formatting were disabled.
- SolidKG and CodeGraph were exposed one at a time as local stdio MCP servers. The control exposed neither.
- Product MCP instructions and tool schemas remained enabled because they are part of each product's agent-facing surface.
- 27 of 28 matched three-arm batches ran concurrently; the first Gin batch ran sequentially. Arm order rotated by repeat.
- Tokens are the sum of OpenCode's per-step total-token fields. The task tool was disabled, so no hidden subagent calls contributed.
- A post-run audit found zero built-in tool inputs that accessed either product's hidden index directory.
- Dollar cost is unavailable: OpenCode reports zero under this subscription path.
- 87 matrix attempts were launched. Three interrupted VS Code run-4 attempts were retried under the same run IDs; no completed result was excluded. Pre-matrix harness-debug attempts were not part of the planned matrix.
- All 84 included runs produced a final answer and terminal stop with no top-level error. Nineteen recoverable tool-call errors occurred across 8 runs: timeouts, oversized grep output, and an out-of-range read.

Both products were compiled with the same TypeScript 7 native-preview build, `7.0.0-dev.20260707.2`.

Product and evidence sources:

- SolidKG: `479a4dded3695f0917602ea6b6e67e81a581b058` plus the archived [`solidkg-runtime.patch`](artifacts/opencode-head-to-head-2026-07-10/solidkg-runtime.patch), SHA-256 `45b7d973d82b461c567f81b6f599d50e3e7368ca23e3745b8105a056dacdd633`.
- CodeGraph: `e552dc2d2f5da4507ebe906b68b3ba806e204eb8` (`1.3.1`).
- Diagnostic manifest: [`manifest.json`](artifacts/opencode-head-to-head-2026-07-10/manifest.json).

The exact SolidKG benchmark binary was not archived. The manifest records a post-run reconstruction from the same runtime source patch and compiler, plus hashes for the temporary runner and analyzer. Raw JSONL and the temporary harness are not published; therefore this report documents summarized diagnostic evidence but does not support exact independent reproduction or pass the repository's benchmark-passport gate.

Repository revisions:

| Repository | Commit |
|---|---|
| VS Code | `e7b83d54552fa9cb419c63fb24bde66f70addb60` |
| Excalidraw | `adf963199762e5675811f3fbae779625ca7d0ba3` |
| Django | `b34b834378adc590a771cccd44b9fb0b953cdca2` |
| Tokio | `c4c6265a0746a79d4a2f3852f726aa0101f29fd3` |
| OkHttp | `8ef2d8081a417149fa614fe817bea4af60674718` |
| Gin | `34dac209ffb6ef85cc78c5d217bbb7ad001d68fd` |
| Alamofire | `903c53c710d1cbbac0b4b9c2527aefb791e1fee3` |

Questions match the README benchmark corpus:

1. How does the extension host communicate with the main process?
2. How does Excalidraw render and update canvas elements?
3. How does Django's ORM build and execute a query from a QuerySet?
4. How does tokio schedule and run async tasks on its runtime?
5. How does OkHttp process a request through its interceptor chain?
6. How does gin route requests through its middleware chain?
7. How does Alamofire build, send, and validate a request?

## Correctness and variance

All 84 answers completed successfully and cited source files. A source-audit agent checked one representative per repository and arm. The representative was the run whose token count was closest to that cell's four-run median; ties kept the first run in source order. The reviewer saw arm labels and applied this rubric: PASS for a materially correct source-grounded core flow, PARTIAL for a narrow false statement or omission that did not invalidate the flow, and FAIL for a materially wrong core explanation.

| Arm | Pass | Partial | Fail |
|---|---:|---:|---:|
| SolidKG | 6 | 1 | 0 |
| CodeGraph | 6 | 1 | 0 |
| No graph | 7 | 0 | 0 |

The SolidKG partial omitted Excalidraw's conditional third canvas layer. The CodeGraph partial overstated how narrowly Tokio resets the cooperative budget. Neither error changed the core architecture explanation, and neither arm had a failed representative. This 21-answer spot check did not reveal a material quality imbalance between graph arms; it does not establish correctness for the other 63 answers.

This study did not ask agents to modify code. It provides no evidence about patch correctness, build or test success, regressions, security, maintainability, or whether one graph produces better generated code. Those outcomes require a separate task-level coding benchmark with executable acceptance tests and blinded patch review.

Run-to-run variance remained material. Across repository/arm cells, the median min-to-max range was 35.7% of the median for tool calls and 67.6% for tokens. The maximum ranges were 1,000% and 313%, respectively. Four-run medians reduce but do not eliminate this variance; the strongest direct diagnostic signal is that CodeGraph used fewer tool calls and tokens in all seven repository medians, not the apparent precision of the averaged percentages.

These numbers are measured diagnostic evidence, not a guarantee for every repository, model, or workflow.
