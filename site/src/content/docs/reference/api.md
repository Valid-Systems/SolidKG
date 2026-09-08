---
title: API
description: Use SolidKG as a TypeScript library.
---

SolidKG ships a TypeScript API. Import it from the package root; deep imports from `dist/`, `src/`, or internal folders are not part of the supported API contract.

The API is the supported way to build custom non-GUI graph workflows on top of SolidKG. It exposes indexing, sync, symbol search, callers/callees, impact analysis, context building, snapshots, architecture reports, and SCIP operations. The package does not include a Studio app, browser visualization, interactive graph canvas, or graph UI, and it does not open a browser by default.

```typescript
import SolidKG, { SolidKG as NamedSolidKG } from 'solidkg';
import type { IndexResult, Node, SearchResult } from 'solidkg';

const cg: NamedSolidKG = await SolidKG.init('/path/to/project');
// Or open an existing index:
// const cg = await SolidKG.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`),
});

const results: SearchResult[] = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
  format: 'markdown',
});
const impact = cg.getImpactRadius(results[0].node.id, 2);
const firstKind: Node['kind'] | undefined = results[0]?.node.kind;
const indexed: Pick<IndexResult, 'success'> = { success: true };

console.log(firstKind, indexed.success);
cg.watch();   // auto-sync on file changes
cg.unwatch(); // stop watching
cg.close();
```

## Key methods

| Method | Purpose |
|---|---|
| `SolidKG.init(path)` / `SolidKG.open(path)` | Create or open a project index |
| `indexAll(opts)` | Full index, with progress callback |
| `sync()` | Incremental update |
| `searchNodes(query)` | Full-text symbol search |
| `getCallers(id)` / `getCallees(id)` | Walk the call graph |
| `getImpactRadius(id, depth)` | Transitive impact of a change |
| `buildContext(task, opts)` | Markdown / JSON context for AI |
| `getArchitectureHealth(opts)` | Read-only structural findings, metrics, evidence anchors, and per-signal coverage |
| `createSnapshot(label, opts)` | Save graph facts and architecture-health analysis |
| `getSnapshotHealthDrift(label)` | Compare a saved baseline with the current indexed graph |
| `watch()` / `unwatch()` | Start / stop the file watcher |
| `close()` | Close the database connection |

## Index and storage options

The API mirrors the public CLI controls. `SolidKG.init(project, { dataDir })` and `SolidKG.open(project, { dataDir })` open an external data directory while keeping `project` as the source root. `indexAll()` accepts source-selection options such as `extraRoots`, `includePatterns`, `excludePatterns`, `includeVendored`, `includeSubmodules`, `maxFileSizeBytes`, and SCIP mode options. `IndexResult.skippedFiles` reports files skipped by scope or size rules.

Routine API indexing defaults to AST extraction without starting external SCIP generators. Use the SCIP options when a caller wants best-effort or required precision generation.

## Architecture health and snapshot drift

Health and drift require an existing schema 11 index. If an index needs an upgrade, run `solidkg sync <project>` once with write access. Then reopen it with `SolidKG.open(project, { readOnly: true })` for read-only access.

Before a change, use a writable handle to save `createSnapshot('before-refactor', { architecture: { layers: [{ name: 'api', paths: ['src/api/**'] }] } })`. After the change, sync the index before the comparison. `getSnapshotHealthDrift('before-refactor')` reuses the saved layer options. A missing snapshot label raises an error.

`getArchitectureHealth({ layers })` returns deterministic findings, metrics, evidence anchors, and per-signal coverage. It does not assign a score, grade, severity, or runtime verdict. Static unreferenced findings are candidates, not proof that code is dead.

Drift always includes graph-diff counts. Its comparison status is `comparable`, `partially_compatible`, `incompatible_analysis`, or `baseline_analysis_unavailable`. Incompatible or unavailable analysis does not produce a guessed finding comparison. API results remain complete, unlike the bounded human/MCP categories.

## Public exports

The package root exports:

- `SolidKG` as both the default export and a named export.
- Core graph data types and constants from `src/types.ts`, including `Node`, `Edge`, `FileRecord`, `SearchResult`, `Context`, `TaskContext`, `NODE_KINDS`, `HYPEREDGE_KINDS`, and `LANGUAGES`.
- `TaskContext.solidkgVersion` plus source coverage metadata via `sourceCompleteness` (`status`, candidate/returned/complete/truncated/omitted/unreadable counts, and max-block metadata) when context output is built.
- Public option/result types exported by `src/index.ts`, including init/open/index options, snapshot/diff records, architecture reports, and SCIP import/generation types.
- Root-level helpers already re-exported by `src/index.ts` for language detection, initialization checks, errors, watcher state, SCIP operations, and MCP server construction.

## Migration notes from 0.8/0.9-era imports

- Use `import SolidKG, { type Node } from 'solidkg'` instead of deep paths such as `solidkg/dist/index.js`, `solidkg/dist/types`, or repository-local `src/*` imports.
- The package root declares explicit built JavaScript and declaration exports so TypeScript consumers can resolve public types without relying on internal file layout.
- The CLI and MCP server remain available through `solidkg` and `solidkg serve --mcp`; the SDK does not add a GUI or browser visualization surface.

`sourceCompleteness` is returned-source coverage only. It does not claim answer correctness, path truth, runtime reachability, graph confidence, query anchoring quality, or global false-path guarantees.
