# Research integration: graph invariance and counterfactual retrieval

Date: 2026-07-10

## Decision

The arXiv review did not justify a neural retriever, vector database, randomized ranking, or new MCP tool. It did justify three smaller changes to the existing `solidkg_explore` surface and evaluation harness:

1. canonical graph fingerprints for fresh-index versus incremental-sync invariance;
2. graded required/useful/misleading source judgments over long, terse, and counterfactual probes; and
3. deterministic exclusion and concept coverage so omitted counterfactual constraints produce a partial packet rather than false sufficiency.

## What changed

- Explicit exclusions such as “not tests” and “excluding serialized command metadata” no longer become positive retrieval terms.
- Matching production source is selected ahead of test/example/generated candidates unless the query explicitly asks for non-production code.
- Counterfactual queries compare their positive concepts with the returned source. Uncovered concepts add `missing_query_concept`, a `failure_boundary` ranking reason, and partial sufficiency.
- Probe grading counts only actual returned source headings, not peripheral “not shown” mentions.
- Canonical fingerprints compare files, nodes, edges, hyperedges, hyperedge members, unresolved references, and source chunks while excluding timestamps and SQLite row IDs.

## Finished-build results

Corpus: 52 stored indexes, 51 measured and one empty. Direct probes used the current built `solidkg_explore`, five measured repeats per prompt, two repositories, and three query variants per repository.

| Result | Before | Finished build |
|---|---:|---:|
| Ordinary prompts returning required production source | 4 / 4 | 4 / 4 |
| Counterfactual misses claiming sufficiency | 2 / 2 | 0 / 2 |
| Counterfactual misses truthfully abstaining | 0 / 2 | 2 / 2 |
| Useful supporting source recall where labeled | not measured | 100% |
| Misleading source intrusions | not reliably measured | 0 / 6 |
| Median payload across six paired probes | 32,750 bytes | 31,148 bytes |

The 4.9% median payload reduction is secondary. The material result is calibration: both counterfactual prompts still miss their required file, but neither now tells an agent that unrelated returned source is sufficient.

Static stored-index metrics were unchanged, as expected: fair cross-file dependent coverage remained 33.2% micro / 42.2% repository median and fair semantic coverage remained 30.2% / 39.5%. The integration changes retrieval interpretation and evaluation, not historical graph facts.

## Probe outcomes

| Probe family | Long | Terse | Counterfactual |
|---|---|---|---|
| Airflow DagBag parsing | required and useful supporting source, no misleading source | required source, no misleading source | required source absent; calibrated abstention |
| Azure REST cmdlet | required source | required source | required source absent; calibrated abstention |

## Graph invariance evidence

The automated fixture reaches the same final TypeScript source through two paths: initial index plus `sync()`, and a fresh full index. Their canonical relation fingerprints are equal. A negative-control fixture changes a declaration and the comparator attributes the mismatch to `nodes` instead of returning only an opaque whole-database hash.

This is a metamorphic consistency check, not proof that the common graph is complete or sound. Ground-truthed extraction and negative-path tests remain necessary.

## Remaining gap

The two fuzzy counterfactual prompts still do not retrieve the required source on the stored Airflow and Azure indexes. That gap should remain visible. The next justified experiment is better deterministic concept-to-symbol/path alignment on a larger labeled corpus, not weakening abstention or adding an unmeasured learned retrieval subsystem.
