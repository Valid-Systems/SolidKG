# Rust Port Decision Report

## Recommendation

Do not port SolidKG mostly to Rust now.

Do not approve production Rust now. Do not commit to "eventually mostly Rust."

The recommended path is to keep TypeScript/Node as the product membrane and run a migration-readiness discovery package first. A disposable 4-6 week native tree-sitter/parser-fact prototype is only justified if profiling proves parse/index/V8/WASM pressure is material.

## Provenance

This report is based on the adversarial Hyperplan bundle covering three rounds of critique and consensus.

No source files were changed as part of the debate. The report reflects the team findings and plan-agent sequencing output.

## Why A Broad Rust Port Is Rejected

A broad Rust rewrite is not justified because SolidKG's core product value is not primarily the implementation language. The core value is semantic graph sufficiency:

- `trace`, `explore`, and `context` quality
- dynamic-dispatch coverage
- reduced agent Read/Grep/tool-call behavior
- MCP/CLI/SDK stability
- installer reliability
- release compatibility across bundled runtimes and npm packages

The adversarial consensus rejected a mostly Rust rewrite now.

## Where Rust May Have Value

Rust may be worth investigating for native tree-sitter parsing and parser-fact extraction because the project has real Node/V8/WASM pressure:

- Node 25 hard block
- `--liftoff-only`
- parse worker recycling
- parser timeouts
- Emscripten/WASM abort handling
- grammar loading and parse memory pressure

This does not justify a broad rewrite. It only justifies measured discovery.

## Required Boundary For Any Prototype

Any prototype must use a named, non-chatty boundary:

- Input: source manifest from TypeScript/Node
- Output option A: versioned JSONL graph facts
- Output option B: temporary SQLite artifact
- Validation/import: TypeScript validates and imports the artifact

Phase one must not:

- Write persistent `.solidkg` state directly from Rust
- Share a live database connection with Node
- Use chatty FFI
- Replace MCP tool schemas or CLI UX
- Move installer, daemon, SDK, docs, or release ownership into Rust

## No-Port Zones

The following areas should remain TypeScript/Node unless a separate decision record proves otherwise:

- installer targets and config writers
- MCP tool names, schemas, and output UX
- daemon/proxy lifecycle
- public TypeScript SDK imports and declarations
- release workflow semantics
- docs, instructions, and agent templates
- context formatting and agent-facing retrieval UX

## Profiling Required Before Production Rust

Before any production Rust proposal, collect measurements for:

- file scan time
- source read time
- grammar load time
- parse time
- extraction time
- DB write time
- resolver time
- hypergraph synthesis time
- SCIP generation/import/link time
- context/explore/trace formatting time
- MCP startup time
- daemon startup time
- RSS, heap, and memory spikes
- crash frequency and support burden

## Production Rust Admission Gates

Production Rust is only admissible if all gates pass:

1. Material measured improvement
   - Cold index time improves materially.
   - RSS or heap pressure improves materially.
   - Crash/support burden improves materially.
   - Gains are large enough to justify a multi-language maintenance surface.

2. No graph drift
   - Graph fact diffs match expected output.
   - Node IDs remain stable or have documented migration semantics.
   - Path labels, ranges, ordering, provenance, and hyperedge membership are preserved.

3. No tool/output drift
   - MCP output remains compatible.
   - CLI output remains compatible.
   - Status and skipped-file JSON remain compatible.
   - Trace path diffs are accepted only when explicitly explained.

4. No retrieval regression
   - `trace`, `explore`, and `context` remain sufficient.
   - Agent Read/Grep/tool-call counts do not regress.
   - Dynamic-dispatch coverage does not regress.

5. Platform and release proof
   - Windows, macOS, and Linux smoke tests pass.
   - Bundled runtime release semantics remain intact.
   - npm package behavior remains intact.

6. Operability proof
   - Diagnostics are clear.
   - Failures are attributable to either TypeScript or Rust.
   - Rollback path is documented.
   - Reindex metadata is versioned.
   - Ownership is assigned.
   - Stop-loss criteria are explicit.

## Eviction Criteria

Reject Rust for a fixed window if any of these occur:

- profiling does not show material parse/index/V8/WASM pain
- conformance diffs are noisy or unexplained
- trace/explore/context sufficiency regresses
- agent Read/Grep/tool-call behavior regresses
- platform packaging becomes fragile
- support burden increases
- ownership is unclear
- rollback requires unsafe or lossy `.solidkg` migration

If rejected, invest instead in:

- dynamic-dispatch coverage
- retrieval sufficiency
- installer reliability
- Node-side profiling and mitigations
- parser worker stability
- WASM crash containment

## Recommended Next Step

Write and review this report first.

After the report is accepted, run a migration-readiness discovery package. Only if profiling shows material parser/index pressure should the team authorize a disposable 4-6 week prototype.

The prototype must be treated as disposable until it passes all production gates.

## TDD-Oriented Validation Strategy

Use tests as the decision boundary, not as post-hoc confirmation.

Required harnesses before production Rust:

- graph fact conformance diff
- MCP output conformance diff
- CLI output conformance diff
- trace path diff
- context/explore sufficiency checks
- skipped-file/status JSON diff
- ordering/range/provenance/hyperedge membership checks
- platform smoke tests
- rollback/reindex metadata tests

## Decision

A mostly Rust port is not a good idea now.

The only acceptable Rust path is a measured, bounded, disposable parser/index discovery track behind a strict artifact boundary and hard production gates.
