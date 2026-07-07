---
title: Troubleshooting
description: Fixes for the most common SolidKG issues.
---

## "SolidKG not initialized"

Run `solidkg init -i` in your project directory first. If you use an external data directory, pass the same `--data-dir <dir>` to `status`, `index`, `sync`, `serve --mcp`, and query commands.

For scripts, `solidkg status --json` exits successfully with `initialized: false` when an index is missing, so callers can distinguish a missing graph from a command failure.

## Indexing is slow

Check what is being scanned:

```bash
solidkg index --exclude "dist/**" --exclude "generated/**" --max-file-size 2mb
```

SolidKG already skips dependencies, build outputs, committed `vendor/` and `vendored/`, nested Git repositories, submodules, and files larger than 5 MB by default. Use `--include`, `--exclude`, `--include-vendored`, `--recurse-submodules`, and `--max-file-size` when a repository needs a different scope. Index output and `IndexResult.skippedFiles` report skipped files by reason.

## MCP hits `database is locked` or `disk I/O error`

Current builds use Node's built-in `node:sqlite` in WAL mode where the filesystem supports it. Network filesystems, mapped Windows drives, and WSL mounted paths can still make SQLite locking unreliable.

Prefer a local external data directory while indexing a network-mounted source tree:

```bash
solidkg init --data-dir ~/.cache/solidkg/my-repo -i /path/to/project
solidkg serve --mcp --path /path/to/project --data-dir ~/.cache/solidkg/my-repo
```

If a chosen data directory is corrupt or missing, stop MCP sessions, restore or delete only that SolidKG data directory, then re-run `solidkg init --data-dir <local-dir> -i <project>`.

## MCP server not connecting

Ensure the project is initialized and indexed, verify the path in your MCP config, and check that `solidkg serve --mcp` works from the command line. If a host shows a tool name with an extra client prefix, keep the raw server name as `solidkg_*`; host prefixes are display or permission wrappers, not names to copy into SolidKG config.

MCP tool calls have a server-side timeout. If a very large context request times out, narrow the query with concrete symbols, classes, methods, annotations, framework keywords, or file/package hints before raising `SOLIDKG_MCP_TOOL_TIMEOUT_MS`.

## Missing symbols

The MCP server auto-syncs on save after a short debounce. Run `solidkg sync` manually if needed. Check that the file's language is [supported](/solidkg/reference/languages/), that it isn't excluded by `.gitignore` or scope flags, and that it isn't over the max file size.

For behavior questions, use precise context queries. For example, ask for `AuthService login middleware` rather than only `auth flow`. Context output masks secret-like literals and email addresses in snippets, but keeps file paths, symbol names, line numbers, and graph IDs usable for navigation.
