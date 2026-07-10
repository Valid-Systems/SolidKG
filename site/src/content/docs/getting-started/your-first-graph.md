---
title: Your First Graph
description: Build an index and run your first queries against it.
---

Once SolidKG is installed, building and exploring a graph takes three commands.

## Index a project

```bash
cd your-project
solidkg init -i      # initialize + index in one step
```

`init` creates the `.solidkg/` directory; `-i` (or `--index`) immediately builds the full index. For an existing project you can re-index any time:

```bash
solidkg index          # full index
solidkg sync           # incremental update of changed files
```

## Check it worked

```bash
solidkg status
```

This reports the node/edge/file counts, the active SQLite backend, and the journal mode — a quick health check that the index is ready.

## Run a query

```bash
solidkg query UserService          # find symbols by name
solidkg callers handleRequest      # what calls a function
solidkg callees handleRequest      # what a function calls
solidkg impact AuthMiddleware      # what a change would affect
solidkg context "fix the login flow"   # build task-focused context
```

Each accepts `--json` for machine-readable output. See the full [CLI reference](/solidkg/reference/cli/).

## Hand it to your agent

With a `.solidkg/` directory present and an agent configured (see [Installation](/solidkg/getting-started/installation/)), your agent automatically receives the compact/default [MCP profile](/solidkg/reference/mcp-server/) with one answer-producing tool, `solidkg_explore`. Set `SOLIDKG_MCP_TOOLS=all` on the server process only when you need the advanced surface.
