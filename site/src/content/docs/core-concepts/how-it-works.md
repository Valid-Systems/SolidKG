---
title: How It Works
description: The extraction, storage, resolution, and auto-sync pipeline.
---

SolidKG turns source code into a queryable graph in four stages.

```
files → Extraction (tree-sitter) → DB (nodes/edges/semantic relations/files)
            ↓
      Resolution (imports, name-matching, framework patterns)
            ↓
      Graph queries (callers, callees, impact)
            ↓
      Context building (markdown / JSON for AI consumption)
```

## 1. Extraction

[tree-sitter](https://tree-sitter.github.io/) parses source into ASTs. Language-specific queries extract **nodes** (functions, classes, methods, types…) and **edges** (calls, imports, extends, implements). Heavy parsing runs off the main thread.

## 2. Storage

Everything goes into a local SQLite database (`.solidkg/solidkg.db`) with FTS5 full-text search. Pairwise edges remain the compatibility layer, while semantic relations preserve ordered multi-symbol shapes like route chains and event channels. Current builds use Node's built-in `node:sqlite` through the local adapter, with SQLite WAL mode where available; `solidkg status` shows the active backend and journal mode.

## 3. Resolution

After extraction, references are resolved: function calls → definitions, imports → source files, class inheritance, and framework-specific patterns. Some dynamic-dispatch boundaries (callbacks, observers, React re-render, JSX children) are bridged by synthesizers so flows connect end-to-end. Semantic relations add the higher-level shape that pairwise edges flatten, such as Express route → middleware → validator → handler. See [Resolution & Frameworks](/solidkg/core-concepts/resolution/).

## 4. Auto-sync

The MCP server watches your project using native OS file events (FSEvents / inotify / ReadDirectoryChangesW). Changes are debounced, filtered to source files, and incrementally synced — the graph stays fresh as you code, with no configuration.
