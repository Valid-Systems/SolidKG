# Expanded matched SolidKG / CodeGraph benchmark

Date: 2026-07-11

This report records a local matched OpenCode comparison after the large-index reliability fix. It covers Cartog, Tilth, Azure PowerShell, and Apache Airflow. Each repository and product cell ran four times with `openai/gpt-5.6-sol`. Lower values favor the named measure, not a product overall. The checked-in [compact evidence record](evidence/opencode-expanded-2026-07-11.json) preserves the versioned provenance, medians, ranges, validity counts, and audit result.

## Results

| Equal-repository reduction for SolidKG | Result |
|---|---:|
| Tool calls | 34.6% |
| Read calls | 24.0% |
| Grep calls | 77.8% |
| Glob calls | 100.0% |
| Graph calls | 12.5% |
| Tokens | 34.7% |
| Wall-clock time | 3.3% |

Each percentage is the average of repository medians, so every repository has equal weight. Wall-clock time is concurrent, subscription-host descriptive evidence, not a controlled speed benchmark. It should not be read as an independent performance claim.

| Repository | SolidKG tools | CodeGraph tools | SolidKG tokens | CodeGraph tokens |
|---|---:|---:|---:|---:|
| Cartog | 2.0 | 13.0 | 49,637 | 150,188 |
| Tilth | 8.0 | 7.0 | 92,540 | 105,283 |
| Azure PowerShell | 3.0 | 7.0 | 75,369 | 139,655 |
| Apache Airflow | 4.0 | 4.5 | 80,775 | 93,550 |

## Completion and answer checks

- 32/32 planned runs completed, with four repeats in each repository and product cell.
- The runs recorded 0 tool errors and all 32/32 answers cited source files.
- The regex mechanism screen completed 31 of 32 checks. It is triage evidence, not a correctness proof.
- All 8 deterministic median-representative answers received PASS in the separate source review against the recorded snapshots.
- One non-representative Cartog/SolidKG run was partial. It omitted the normal Git-diff stage while correctly describing the remaining index flow.

The representative audit supports claims about those eight reviewed answers in these frozen snapshots. It does not establish universal answer correctness, runtime behavior, or product-wide superiority.

## Repository provenance and scope

Cartog was pinned at `61fd98379e8240455856f167c1ce333f17297bb8`; Tilth was pinned at `e7ef4647e0f8778491e3327e05c98260ff1b2d05`. Azure PowerShell and Apache Airflow used unversioned local snapshots, so this report makes no independent-reproduction or claim-grade assertion for those two rows.

The run used OpenCode `1.17.18`, Node `v24.12.0`, SolidKG SHA-256 `33ffed1b03a6bd8aa0689d515a2abe6314864007775599755f9bb1e4b8f3b9c8`, and CodeGraph SHA-256 `09f9bf91d735282531c8356cba8098f041093271af4062824774460db69d549a`. The plan SHA-256 was `594831c7d80750e64785c97f74cfe78b698ed9470099a25d7cbfb12f43a71826`.

The harness, analyzer, plan, and raw run artifacts lived under `D:\tmp\opencode\solidkg-expanded-benchmark-2026-07-11`. They were local analysis inputs, not repository-contained versioned raw JSONL. The checked-in [evidence JSON](evidence/opencode-expanded-2026-07-11.json) is the compact, versioned summary of those inputs.

The recorded harness commands were:

```powershell
Set-Location D:\tmp\opencode\solidkg-expanded-benchmark-2026-07-11
node .\run-benchmark.mjs
node .\run-benchmark.mjs --execute
node .\analyze-results.mjs
```

The first command validates and writes the immutable plan, the second performs the live 32-run schedule, and the third produces the analysis. These are recorded historical commands for the external local harness, not a reproduction promise for its unversioned Azure PowerShell and Apache Airflow snapshots.

## Large-index reliability evidence

The related reliability fix keeps the original failure visible when automatic SQLite rollback also fails, rather than masking it with the rollback error. Source projection reports a visible phase and flushes at 128 files or 32 MiB, whichever comes first. It creates source chunks up to 8 KiB and caps each file at 1,024 chunks. `index` and the initial index run by `init -i` write `<data-dir>/index-lifecycle.json` through a random exclusive temporary file followed by atomic replacement. Phase, detail, completion, and terminal success or failure are persisted immediately. Running counts are periodically checkpointed with an intended lag of at most about two seconds, so they reflect the latest checkpoint rather than the instant you inspect the file. Where POSIX modes apply, the lifecycle file is owner-only.

The fixed local runs completed 34,746 Azure PowerShell files and 8,772 Apache Airflow files, with zero file errors in their lifecycle records. Source projection was observed at 419s -> 251s for Azure PowerShell and 128s -> 62s for Airflow across those runs. These are cross-run observations, not a controlled benchmark.

For a current index, inspect the diagnostic file directly:

```text
<data-dir>/index-lifecycle.json
```

It records operation status, phase, detail, completion, timestamps, counts, and terminal failure when indexing fails. Running counts may reflect the latest periodic checkpoint rather than the instant you inspect the file. It can contain absolute paths and stack traces, so treat it as sensitive diagnostic output and do not publish it without review.
