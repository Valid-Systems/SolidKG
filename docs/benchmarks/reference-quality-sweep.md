# Reference Quality Sweep

The reference quality sweep is a deterministic, read-only diagnostic over existing SolidKG indexes. It adds two practices that are useful in CodeGraph's engineering workflow but were not previously reproducible in SolidKG:

1. fair, file-level cross-file dependent coverage with explicit denominators; and
2. fast direct tool probes across curated real repositories, measuring payload and latency separately from agent behavior.

This complements the existing agent A/B, answer-quality, benchmark-passport, peer-structural, task-success, and retrieval-plan gates. It does not replace or change them.

## Claim boundary

Committed reference results are a **diagnostic reference-index snapshot**. The local corpus contains indexes built at different schema revisions and times. A snapshot therefore measures those stored graph facts with the current reporting implementation. It does not prove current-build extraction quality, universal language coverage, peer superiority, or production runtime behavior.

A claim-grade extraction report would require rebuilding a pinned corpus with the exact measured build and recording repository revisions, implementation hashes, raw evidence, repeats where latency is involved, and all failures.

## Cross-file coverage policy

The policy is versioned as `solidkg.reference-quality.metric-policy.v1` in `scripts/agent-eval/reference-quality/policy.mjs`.

### Denominators

- **Raw denominator:** every file tracked by the index.
- **Fair denominator:** every tracked file containing at least one declaration node of a frozen kind: class, struct, interface, trait, protocol, function, method, property, field, variable, constant, enum, enum member, type alias, namespace, route, or component.
- `no_declaration` is the only headline exclusion. Tests, examples, entry points, and generated-looking paths may be analyzed as slices later, but are not silently removed from the headline.

Zero denominators are reported as not applicable (`null`), never 100%.

### Numerators

A denominator file is covered when it is the **target** of at least one deduplicated edge whose source node belongs to another file.

- **Any cross-file dependent:** calls, imports, exports, extends, implements, references, type-of, returns, instantiates, overrides, or decorates.
- **Semantic cross-file dependent:** the same set excluding imports and exports.
- **Import-only:** an incoming import/export edge exists and no incoming semantic edge exists.

`contains` never counts. Same-file edges never count. Dangling endpoints never cover a file and are reported as integrity burden. Language attribution follows the target file.

Every rate preserves its numerator and denominator. Aggregates report both a micro rate (summed numerators and denominators) and the unweighted median of repository rates. There is no composite quality score.

## Other measurement lanes

The static scanner also reports these independent lanes where their tables and columns are available:

- route-node handler linkage and route-binding hyperedge integrity;
- source-chunk attachment to distinct declaration nodes and orphan chunks;
- SCIP document and linked-node coverage;
- capability-producer status distribution and complete-run rate;
- unresolved-reference density, indexed file errors, dangling edges, missing edge provenance, heuristic cross-file share, and graph counts;
- schema version, recorded producer version, database size, logical DB/WAL fingerprint, and optional feature availability.

Optional features use explicit states: `absent`, `incompatible_columns`, `available_empty`, `available_nonempty`, `malformed_data`, or `query_error`. Missing legacy tables are unavailable, not zero coverage.

Static scans also run against a disposable copy of each `solidkg.db*` set. Although Node's `DatabaseSync(..., { readOnly: true })` prevents SQL writes, SQLite may still update WAL shared-memory coordination files while reading a live WAL database. Copying first makes the corpus-preservation guarantee filesystem-observable rather than relying on SQLite query semantics.

## Direct probes

Curated probes live in `scripts/agent-eval/reference-quality-probes.json`. Each case pins a repository ID, exact tool arguments, expected source files, and section-qualified response expectations.

The runner:

1. hashes every original `solidkg.db*` artifact;
2. copies the index into a temporary external data directory;
3. checks expected source-file hashes against the copied index;
4. opens only the disposable copy through the current built `ToolHandler`;
5. performs one warm-up and five measured repeats;
6. records output hashes, UTF-8 payload bytes, p50/range latency, answer-packet/source-completeness availability, and expectation results;
7. deletes the copy and proves that every original DB/WAL/SHM artifact is unchanged.

Reports retain hashes, byte counts, parsed evidence, classifications, and timing summaries only. Full tool response payloads are intentionally discarded and are never committed as benchmark artifacts.

Each scan and probe runs in a child process with a hard deadline. Stable sequential execution is the default to avoid turning storage contention into benchmark noise.

Answer-packet sufficiency is returned-context metadata, not answer correctness. Probe latency and payload are neutral diagnostics: comparisons use `changed` or `unchanged`, never improved/regressed.

## Comparison rules

Comparison statuses are `improved`, `regressed`, `changed`, `unchanged`, `added`, `removed`, and `not_comparable`.

- Static coverage requires the same metric policy and source revision. Different index fingerprints are allowed because the rebuilt index is often the independent variable.
- Coverage with a changed denominator is not comparable.
- Probe comparison requires the same probe manifest/parser and index fingerprint. Different ToolHandler implementation hashes are allowed because tool behavior is the independent variable.
- Neutral burden, latency, payload, provenance, and status metrics only report changed/unchanged.
- A full-cohort aggregate verdict requires identical repository cohorts. Changed cohorts require an explicitly recomputed intersection and receive no full-cohort regression verdict.
- Report inputs are schema-validated before comparison. Per-repository rows expose `added`, `removed`, `changed`, `unchanged`, or `not_comparable`, and a changed source revision makes static lanes non-comparable.

JSON serialization is stable for the same in-memory evidence and an injected timestamp. Real repeated sweeps still contain newly measured scan and probe timings, so fixing `--generated-at` does not erase legitimate timing variation.

## Commands

Run contract tests:

```powershell
pnpm run test:reference-quality
```

The focused command builds first so copied-index ToolHandler integration tests cannot silently skip in a clean checkout.

Run the supplied local reference corpus:

```powershell
pnpm run bench:reference-quality -- `
  --root "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos" `
  --out "D:\tmp\opencode\solidkg-reference-quality" `
  --min-repos 52 `
  --probe-manifest "scripts\agent-eval\reference-quality-probes.json" `
  --probe-repeats 5
```

Compare a report with a baseline:

```powershell
pnpm run bench:reference-quality -- `
  --from-results "D:\tmp\opencode\solidkg-reference-quality\reference-quality-baseline.json" `
  --baseline "docs\benchmarks\reference-quality-baseline.json" `
  --out "D:\tmp\opencode\solidkg-reference-quality-comparison"
```

Use `pnpm run bench:reference-quality -- --help` for all options.

## CI policy

The normal Vitest suite covers policy, SQL, probe-summary, reporting, comparison, and CLI contracts. The external 52-repository corpus is intentionally not part of hosted CI because it is large, local, and not shipped in npm or release artifacts.
