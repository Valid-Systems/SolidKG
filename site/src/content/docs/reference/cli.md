---
title: CLI
description: Every SolidKG command and the flags it accepts.
---

```bash
solidkg                         # Run interactive installer
solidkg install                 # Run installer (explicit)
solidkg uninstall               # Remove SolidKG from your agents (inverse of install)
solidkg init [path]             # Initialize data dir (--index/-i also indexes with SCIP auto)
solidkg uninit [path]           # Remove SolidKG from a project (--force to skip prompt)
solidkg index [path]            # Full index (--scip=off|auto|required, --force, --quiet)
solidkg sync [path]             # Incremental update
solidkg status [path]           # Show statistics (--json for schema solidkg.status.v1)
solidkg query <search>          # Search symbols (--kind, --limit, --json)
solidkg files                   # Show file structure (--format, --filter, --max-depth, --json)
solidkg overview [path]         # Show indexed repository summary tree (--expand, --max-depth)
solidkg context <task>          # Build context for AI (--format markdown|json, --max-nodes)
solidkg callers <symbol>        # Find what calls a function/method (--limit, --json)
solidkg callees <symbol>        # Find what a function/method calls (--limit, --json)
solidkg impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
solidkg affected [files...]     # Find test files affected by changes
solidkg scip generate [path]    # Generate .scip files without importing them
solidkg scip import [files...]  # Import existing .scip files as optional precise refs
solidkg serve --mcp             # Start MCP server
```

There is no supported `visualize` command, Studio command, or browser-opening graph UI workflow. The CLI is the supported non-GUI surface for graph queries and exports. Use `query`, `files`, `context`, `status --json`, `context --format json`, `snapshot`, `architecture`, `callers`, `callees`, `impact`, and `scip` commands when scripts or custom agents need graph data.

## Initialization and SCIP modes

`solidkg init` creates the data directory and metadata for a project. It does not parse source files unless you also pass `-i` or `--index`.

`solidkg init -i` initializes the project and immediately runs a full bootstrap index. That bootstrap uses best-effort SCIP auto-generation: SolidKG builds the normal AST graph first, tries supported SCIP generators when available, imports successful output, and keeps AST indexing usable if adapters are missing or fail. First-time local installer initialization uses the same bootstrap behavior.

`solidkg index` is the repeatable full-index command. It defaults to `--scip=off`, so normal manual indexing does not run external SCIP adapter binaries unless you ask for it.

```bash
solidkg index --scip=off       # default: AST graph only
solidkg index --scip=auto      # best-effort SCIP generation and import
solidkg index --scip=required  # fail if configured SCIP output cannot be produced and imported
```

Use `--scip=auto` for local re-indexing when you want compiler-grade facts where adapters are installed. Use `--scip=required` when CI or evaluation should fail if configured SCIP output cannot be produced and imported.

Most project commands also accept `--data-dir <dir>`:

```bash
solidkg init --data-dir ~/.cache/solidkg/my-repo -i /path/to/project
solidkg status --data-dir ~/.cache/solidkg/my-repo /path/to/project
solidkg serve --mcp --path /path/to/project --data-dir ~/.cache/solidkg/my-repo
```

Without `--data-dir`, the default remains `<project>/.solidkg/`. With `--data-dir`, SolidKG stores the database, daemon pid/log, lock file, error log, and generated SCIP output in the requested directory while indexing files from the project path. Pass the same directory to later `index`, `sync`, `status`, query, `scip`, `unlock`, and MCP server commands; SolidKG does not migrate or auto-discover external directories.

Use one data directory per worktree or branch for feature-branch work. SolidKG has one active source root and one data directory per initialized command, and it does not provide branch overlays or shared-main plus local-feature overlays. A team-shared directory is safe only when everyone intentionally queries the same branch, usually a shared main-branch index. On Windows network drives or SMB shares, prefer a local external data directory to avoid SQLite WAL/disk I/O failures; if one occurs, stop MCP sessions and reinitialize with a local `--data-dir`.

## Indexing scope controls

`init -i`, `index`, and `sync` accept the same source-selection controls:

```bash
solidkg index --include "src/**" --exclude "src/generated/**" --max-file-size 2mb /path/to/project
solidkg index --include-vendored /path/to/project
```

`--extra-root <path>` adds another source root. `--include <glob>` and `--exclude <glob>` are repeatable gitignore-style patterns evaluated inside each selected source root. SolidKG still honors `.gitignore` and built-in generated/dependency safeguards by default; `--exclude` removes more files, and `--include` narrows the remaining candidate set. `--data-dir` never selects source files.

Committed `vendor/` and `vendored/` source are skipped by default even when Git tracks them. Use `--include-vendored` when vendored source is intentionally part of the graph. Nested Git repositories and submodules are skipped by default; use `--recurse-submodules` to opt in.

`--max-file-size <size>` skips source files larger than the configured size. Values accept bytes, `kb`, `mb`, or `gb`; the default is `5mb`. Index output reports skipped files grouped by reason, and the library API exposes them through `IndexResult.skippedFiles`.

File-level tracked formats such as `.yml`, `.yaml`, `.twig`, and Lazarus `.lpi` are counted as indexed file records even when they intentionally have no symbol nodes. CUDA `.cu`/`.cuh` files are accepted through the C++ parser; kernel-launch semantics are not reported unless future extraction tests prove them.

## install and uninstall scope

`solidkg install --location=global` writes to each agent's personal/user-owned config, so the MCP server is available to projects opened by this account. `solidkg install --location=local` writes project-owned files in the current directory for agents that support project/team config; agents with no local config are skipped with a note. The uninstall command uses the same scope names. Current installer targets include Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, and Kimi Code.

Before mutating an existing agent config or instruction file, the installer creates a timestamped sibling backup named like `config.jsonc.solidkg-backup.<timestamp>.<pid>.<n>`. Re-running an install that is already current reports `unchanged`, preserves the original bytes, and does not create another backup.

Other MCP-capable hosts are documented as manual setup only until their public docs expose a deterministic config path, MCP schema, reversible sibling-preserving writes, and an instruction file the host reads. Paste this SolidKG server into the host's documented MCP UI or config:

```json
{
  "mcpServers": {
    "solidkg": {
      "type": "stdio",
      "command": "solidkg",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Manual fallback locations or flows from public docs: gptme `~/.config/gptme/config.toml` with `[[mcp.servers]]`; Trae MCP settings; Devin Settings > MCP Marketplace > Add Your Own; CodeBuddy `codebuddy mcp add` plus `~/.codebuddy.json` or project `.mcp.json`.

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
solidkg query UserService --kind class --limit 10
solidkg callers handleRequest --json
solidkg impact AuthMiddleware --depth 3
```

## Standalone CLI contracts for custom agents

Agents that prefer direct CLI integration instead of MCP can use `status --json` as a health probe and `context --format json` as the context export surface:

```bash
solidkg status --json /path/to/project
solidkg context "AuthService login middleware" --format json --path /path/to/project --max-nodes 20 --max-code 5
```

`status --json` emits schema `solidkg.status.v1`. Initialized output includes `initialized`, `projectPath`, `dataDir`, legacy flat counts (`fileCount`, `nodeCount`, `edgeCount`), `counts.files`, `counts.nodes`, `counts.edges`, `counts.semanticRelations`, `semanticRelations.total`, `semanticRelations.byKind`, `solidkgVersion`, `backend`, `journalMode`, `scip`, `dbSizeBytes`, `nodesByKind`, `languages`, `pendingChanges`, and `worktreeMismatch`. Uninitialized projects exit successfully with `initialized: false`, zero counts, and null backend/SCIP fields.

`context --format json` emits schema `solidkg.context.v1` with `solidkgVersion`, `query`, `summary`, `entryPoints`, `nodes`, `edges`, `hyperedges`, `codeBlocks`, `relatedFiles`, and `stats`. When context output is built it also includes top-level `sourceCompleteness` with `status`, `candidateBlocks`, `returnedBlocks`, `completeBlocks`, `truncatedBlocks`, `omittedBlocks`, `unreadableBlocks`, `maxBlocks`, and `maxBlockSize`. Markdown remains the default and is unchanged for existing prompt-injection workflows.

`sourceCompleteness` is returned-source coverage only. It does not claim answer correctness, path/runtime truth, graph confidence, query anchoring quality, or global false-path guarantees.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/solidkg/guides/affected-tests/) for options and a CI example.
