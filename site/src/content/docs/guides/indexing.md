---
title: Indexing a Project
description: Full index, incremental sync, and the file watcher.
---

## Initialize and index

```bash
cd your-project
solidkg init -i      # initialize + full index
```

`init` creates the SolidKG data directory. By default that directory is `<project>/.solidkg/`. If you pass `--data-dir <dir>`, the project path remains the source tree and the database, lock file, daemon files, error log, and generated SCIP output live in the external directory.

`init` alone does not parse source files. `-i`/`--index` builds the index immediately. This bootstrap path uses best-effort SCIP auto-generation when supported adapters are available: SolidKG builds the normal AST graph first, tries SCIP generators, imports successful output, and keeps the AST graph usable if a generator is missing or fails.

First-time local installer initialization uses the same bootstrap behavior as `solidkg init -i`. To initialize without indexing, drop the flag and run `solidkg index` later.

## Full vs. incremental

```bash
solidkg index           # full AST-only index of the whole project
solidkg index --force   # re-index from scratch
solidkg index --profile-json  # opt-in JSON profiling for benchmark runs
solidkg sync            # incremental — only changed files
```

`sync` is fast because it only reparses what changed. Use it after a branch switch or a batch of edits.

Normal `solidkg index` defaults to `--scip=off`, so it builds the AST graph only unless you opt into SCIP generation:

```bash
solidkg index --scip=off       # default: AST graph only
solidkg index --scip=auto      # opt in: best-effort SCIP generation and import
solidkg index --scip=required  # fail if configured SCIP output cannot be produced and imported
```

`--scip=auto` is useful when you want best-effort compiler-grade precision during a manual full index. `--scip=required` is meant for CI, evaluation, or reproducibility checks where a missing SCIP layer should be treated as a failure.

Use `solidkg index --profile-json` when you need machine-readable indexing telemetry for a benchmark or regression run. On success it writes only JSON to stdout: the normal index result plus `profile.schemaVersion: "solidkg.indexProfile.v1"`, coarse phase timings, file/node/edge counts, memory and database sizes, and grouped database statement counts. Profiling is opt-in; normal `solidkg index` output remains human-readable and does not include the profile payload.

The SDK exposes the same data through `SolidKG.indexAll({ profile: true })`, where `IndexResult.profile` is present only when requested.

## Branches, worktrees, and storage

SolidKG has one active source root and one data directory per initialized project command. It does not provide branch overlays, shared-main plus local-feature overlays, or automatic index merging across worktrees.

For normal feature-branch work, use one data directory per branch or worktree so graph answers match the checked-out files. The default `<project>/.solidkg/` works for a single checkout. For multiple Git worktrees, run `solidkg init -i` inside each worktree or pass a different external `--data-dir` for each one.

A team-shared data directory is safe only when everyone intentionally queries the same branch or worktree and coordinates `index` and `sync` writes. If a shared directory represents main, keep feature branches on their own local data directories until explicit branch overlay support exists.

## Stay fresh automatically

When the MCP server is running, SolidKG watches your project with native OS file events and syncs in the background — debounced, and filtered to source files only. You don't need to run `sync` by hand during an agent session.

## Check status

```bash
solidkg status
```

Reports node/edge/file counts, the active SQLite backend, and the journal mode.

## What gets indexed

Every file whose extension maps to a [supported language](/solidkg/reference/languages/), minus dependency/build directories excluded by default (`node_modules`, `vendor`, `vendored`, `dist`, ...), anything your `.gitignore` excludes, and files over 5 MB. File-level formats such as YAML, Twig, and Lazarus `.lpi` still produce file records even when they have no symbols, so an index containing only those files is reported as indexed rather than skipped. See [Configuration](/solidkg/getting-started/configuration/).
