# Large Reference Repo Smoke Checks

**Date:** 2026-06-04  
**Branch:** local working tree  
**Purpose:** bounded SolidKG-only scale smoke checks, not peer-performance benchmarks.

These checks verify that the built CLI can initialize or open a local index, report status, and return a bounded `context` response on selected large public-reference repositories under `D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos`. They do not compare SolidKG against Tilth, Cartog, Sverklo, grep/read loops, or agent workflows.

## Results

| Repo | Command window | Status after run | Context smoke | Notes |
|---|---:|---|---|---|
| `cpython` | completed in 1m 56s | initialized; 3,619 files; 151,399 nodes; 553,736 edges; `node-sqlite`; WAL | `PyObject type object method lookup` returned 8 symbols across 3 files with bounded minimal-detail output | Default indexing skipped 27 files by rules and 2 files over max size; `scip-python` was not installed, so Python SCIP generation was unavailable. |
| `dotnet__runtime` | exceeded 10m shell timeout | subsequent status reported initialized; 23,203 files; 650,509 nodes; 627,970 edges; `node-sqlite`; WAL | `RuntimeType MethodTable type loading` returned 6 symbols across 2 files with bounded minimal-detail output | Treat as a timeout-limited smoke, not a clean timing benchmark. The index was usable after the timeout, but the timed command did not produce a normal completion line. |

## Interpretation

Supported claim: SolidKG has current smoke evidence for indexing/opening and querying selected very large reference repositories with external data directories.

Unsupported claims: these checks do not show universal large-repo success, peer superiority, agent workflow improvement, or wall-clock performance wins on large repositories.

## Commands Used

```powershell
node "dist/bin/solidkg.js" init -i --data-dir "D:\tmp\opencode\cg-large-smoke\cpython" "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\cpython"
node "dist/bin/solidkg.js" status --json --data-dir "D:\tmp\opencode\cg-large-smoke\cpython" "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\cpython"
node "dist/bin/solidkg.js" context "PyObject type object method lookup" --path "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\cpython" --data-dir "D:\tmp\opencode\cg-large-smoke\cpython" --detail minimal --max-nodes 8 --no-code

node "dist/bin/solidkg.js" init -i --data-dir "D:\tmp\opencode\cg-large-smoke\dotnet-runtime" "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\dotnet__runtime"
node "dist/bin/solidkg.js" status --json --data-dir "D:\tmp\opencode\cg-large-smoke\dotnet-runtime" "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\dotnet__runtime"
node "dist/bin/solidkg.js" context "RuntimeType MethodTable type loading" --path "D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos\dotnet__runtime" --data-dir "D:\tmp\opencode\cg-large-smoke\dotnet-runtime" --detail minimal --max-nodes 8 --no-code
```
