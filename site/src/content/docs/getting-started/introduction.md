---
title: Introduction
description: What SolidKG is, and how it reduces AI coding-agent rediscovery work.
---

SolidKG is a **local-first code-intelligence tool**. It parses your codebase with [tree-sitter](https://tree-sitter.github.io/), stores every symbol, edge, and file in a local SQLite database, and exposes the result as a queryable **knowledge graph** — over the [Model Context Protocol (MCP)](/solidkg/reference/mcp-server/), a CLI, and a TypeScript library.

It exists to make AI coding agents — Claude Code, Cursor, Codex CLI, opencode, and Hermes Agent — **answer structural questions without scanning files**. Instead of fanning out across `grep`, `glob`, and `Read` to reconstruct how code fits together, an agent queries a pre-built index and gets the answer in a handful of calls.

## Why it matters

When an agent explores a codebase, it spends most of its budget on *discovery* — finding the right files before it can read them. SolidKG removes that step: symbol relationships, call graphs, and structure are already indexed.

Benchmark notes across 7 real-world open-source codebases show that a pre-built graph can reduce rediscovery work: fewer tool calls, fewer tokens, and faster structural answers for the measured prompts. Treat those numbers as benchmark-context evidence, not universal savings; results depend on task shape, repository structure, indexed coverage, and agent workflow.

## What's in the graph

- **Symbols** — functions, classes, methods, types, routes, components, and more.
- **Edges and semantic relations** — calls, imports, inheritance, references, route chains, event channels, and framework-specific relationships.
- **Files** — structure plus full-text search (FTS5).

Extraction is **deterministic** — derived from the AST, never LLM-summarized.

## Product boundary

SolidKG is not a Studio app, browser visualization, interactive graph canvas, or graph UI. It is a local graph engine for agents and scripts, exposed through MCP, CLI commands, and the TypeScript API.

Use MCP tools for agent workflows, including `solidkg_context`, `solidkg_trace`, `solidkg_explore`, `solidkg_snapshot`, and `solidkg_architecture`. Use the CLI for non-GUI exports and queries, including `context`, `query`, `files`, `status --json`, `context --format json`, `snapshot`, and `architecture`. Use the SDK/API when you want symbol search, callers/callees, impact analysis, snapshots, architecture reports, context building, indexing, sync, or SCIP operations inside your own program.

SolidKG does not open a browser or start a visualization app by default. If you want charts or a custom visual explorer, query or export the graph and render it in your own tool.

## Local-first by default

The normal graph index lives on your machine as a SQLite database in `.solidkg/`. Optional SCIP generation can run local language indexers when configured, but SolidKG does not require API keys or hosted services for its core AST graph.

## How is this different from Serena?

Serena and SolidKG both help coding agents inspect projects locally, but they are shaped differently. Serena is a coding-agent toolkit with language-server-style symbolic tools and project memory features. SolidKG is a local knowledge graph engine: it parses the repository with tree-sitter, stores symbols, edges, semantic relations, files, snapshots, architecture rollups, and optional SCIP facts in SQLite, then exposes that data through MCP tools, a CLI, and a TypeScript API.

The benchmark numbers on this site compare agent runs with SolidKG against the same prompts without SolidKG. They are not head-to-head Serena benchmarks. Treat them as evidence that a pre-built graph can reduce rediscovery work, not as a claim that SolidKG is faster or better than Serena.

Ready to try it? Head to the [Quickstart](/solidkg/getting-started/quickstart/).
