# Architecture Rollups And Graph Snapshots Contract

This document is the v1 implementation contract for graph snapshots, graph diffs, package rollups, layer rollups, and coupling metrics. It defines testable behavior only. It does not infer subjective architecture intent.

## Snapshot Scope

Snapshots are explicit user actions only in v1. API, CLI, or MCP callers may create a snapshot when they ask for one. Indexing and sync must not create automatic snapshots.

A snapshot records the graph payload needed to compare structural state:

- nodes
- pairwise edges
- hyperedges
- hyperedge members

Snapshot payloads are stored from the current indexed graph. They are not documentation indexes, memory records, vector records, dashboard events, or analytics records.

## Stable Identity

Diffs compare stable identities, not display names alone.

- Nodes are identified by `id`.
- Pairwise edges are identified by a stable tuple of `source_id`, `target_id`, and `kind`.
- Hyperedges are identified by `id`.
- Hyperedge members are identified by `hyperedge_id`, `node_id`, `role`, and `ordinal`.

Payload fields outside the identity form the comparable content for changed records. Tests should treat an unchanged identity with different stored content as `changed`, not as removed plus added.

## Diff Categories

Every snapshot diff returns the same categories for every payload type.

For nodes:

- `addedNodes`: node identities present in the current graph and absent from the snapshot.
- `removedNodes`: node identities present in the snapshot and absent from the current graph.
- `changedNodes`: node identities present in both with different comparable content.

For pairwise edges:

- `addedEdges`: edge identities present in the current graph and absent from the snapshot.
- `removedEdges`: edge identities present in the snapshot and absent from the current graph.
- `changedEdges`: edge identities present in both with different comparable content.

For hyperedges:

- `addedHyperedges`: hyperedge identities present in the current graph and absent from the snapshot.
- `removedHyperedges`: hyperedge identities present in the snapshot and absent from the current graph.
- `changedHyperedges`: hyperedge identities present in both with different comparable content.

For hyperedge members:

- `addedHyperedgeMembers`: member identities present in the current graph and absent from the snapshot.
- `removedHyperedgeMembers`: member identities present in the snapshot and absent from the current graph.
- `changedHyperedgeMembers`: member identities present in both with different comparable content.

An unchanged re-index must return empty added, removed, and changed arrays for every payload type.

## Package Roots

Package roots are deterministic. They come from known manifest files found in indexed paths, plus indexed path structure needed to assign files under those roots.

Implementation must choose package ownership by indexed paths, not by guessed product intent. If nested manifests exist, a file belongs to the nearest matching package root that contains it. Package assignment should record its source, such as `manifest` or `root`, so tests can assert why a file belongs to a package.

The v1 contract does not require a broad package-manager model. It only requires deterministic roots from known manifests and indexed paths.

## Layer Rules

Layer assignment is explicit. Callers pass configured path rules through accepted API, CLI, or MCP options. A file is assigned to the matching configured layer rule. If no rule matches, the file is assigned to `unassigned`.

The implementation must not invent layer names from directory names, framework names, package names, or inferred architecture intent. Layer assignment should record provenance as `config_layer` or `unassigned`.

If multiple configured rules could match one file, the public option contract must make the result deterministic before implementation ships. Tests should pin that rule order or reject ambiguity.

## Dependency Edges

Package and layer dependency rollups are computed from existing graph edges only. They do not create new dependency truth.

The dependency edge kinds included in v1 are:

- `imports`
- `references`
- `calls`
- `extends`
- `implements`
- `instantiates`
- `type_of`

The `contains` edge kind is explicitly excluded from dependency metrics. Containment describes structure, not coupling.

Rollups should ignore dependencies within the same package or same layer when computing external coupling. They should count distinct outside packages or layers, not raw edge count.

## Coupling Metrics

For a package or layer target:

- `Ca` is afferent coupling: the number of distinct packages or layers outside the target that depend on the target.
- `Ce` is efferent coupling: the number of distinct packages or layers outside the target that the target depends on.
- `instability = Ce / (Ca + Ce)`.

If `Ca + Ce` is `0`, instability is `0`.

The same math applies to package rollups and layer rollups. Metrics must use the dependency edge filter above and must not include `contains`.

## Public Surface Contract

API, CLI, and MCP options may expose snapshot labels, diff output, package rollups, explicit layer path rules, and coupling output. They should use one shared behavior contract so fixture tests can compare outputs across surfaces.

The public surface must not introduce a separate config-system design for v1. Layer rules are explicit options accepted by the API, CLI, or MCP call being tested.

## Non Goals

These are out of scope for this implementation:

- Kirograph database technology or a Kirograph-specific storage layer
- a second database engine
- vectors, embeddings, or semantic vector search
- documentation indexing
- persistent memory
- tabular data navigation
- shell output compression
- dead-code detection
- circular-dependency detection
- token analytics or token-gain reporting
- dashboards
- broad heuristic architecture analyses
- subjective architecture intent inference
- automatic snapshots after `index`, `sync`, file watching, or other background work
