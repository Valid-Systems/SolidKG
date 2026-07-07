---
title: Configuration
description: SolidKG defaults, indexing controls, and data directory options.
---

SolidKG works with no project config file. Language support is automatic from file extensions, and the default scan skips dependencies, build outputs, caches, and large generated files. When a repository needs tighter control, use CLI flags or the matching TypeScript API options instead of a persistent config file.

## What it skips out of the box

- **Dependency, build, and cache directories**, including `node_modules`, `vendor`, `vendored`, `dist`, `build`, `target`, `.venv`, `Pods`, `.next`, and similar generated paths.
- **Committed `vendor/` and `vendored/` source**, even when Git tracks it. Pass `--include-vendored` or API `includeVendored: true` when vendored source is first-party context for your task.
- **Anything in your `.gitignore`**, honored through Git in repos and by reading `.gitignore` directly in non-git projects.
- **Files larger than 5 MB**, unless `--max-file-size` or API `maxFileSizeBytes` changes the limit.
- **Nested Git repositories and submodules**, unless you pass `--recurse-submodules` or API `includeSubmodules: true`.

File-level formats such as YAML, Twig, and Lazarus `.lpi` are still counted as indexed file records even when they intentionally have no symbol nodes.

## Indexing scope controls

Use source-selection flags with `init -i`, `index`, and `sync`:

```bash
solidkg index --extra-root ../shared-lib --include "src/**" --exclude "src/generated/**" --max-file-size 2mb
solidkg index --include-vendored --recurse-submodules /path/to/project
```

`--extra-root <path>` adds a peer source root. When more than one source root is indexed, paths are displayed with root labels such as `@app/src/index.ts` so matching relative paths stay distinct.

`--include <glob>` narrows the candidate set inside each selected source root. `--exclude <glob>` removes more files after built-in safeguards and `.gitignore` rules. `--data-dir` is storage-only and never selects source files.

## Where data lives

By default, per-project data lives in `<project>/.solidkg/`, with the SQLite database at `.solidkg/solidkg.db`. You can decouple storage from source with `--data-dir`:

```bash
solidkg init --data-dir ~/.cache/solidkg/my-repo -i /path/to/project
solidkg status --data-dir ~/.cache/solidkg/my-repo /path/to/project
solidkg serve --mcp --path /path/to/project --data-dir ~/.cache/solidkg/my-repo
```

The external data directory stores the database, lock file, daemon pid/log files, error log, and generated SCIP output. SolidKG doesn't auto-discover or migrate external directories, so pass the same `--data-dir` to later `index`, `sync`, `status`, query, `scip`, `unlock`, and MCP server commands.

For feature-branch work, use one data directory per branch or worktree so graph answers match the checked-out files. Team-shared data directories are safe only when the team intentionally queries the same branch and coordinates `index` and `sync` writes. On Windows mapped drives or SMB shares, prefer a local external data directory for SQLite WAL reliability.
