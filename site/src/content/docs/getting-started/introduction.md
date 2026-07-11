---
title: Introduction
description: What SolidKG is, and how it reduces AI coding-agent rediscovery work.
---

SolidKG is a **local-first code-intelligence tool**. It parses your codebase with [tree-sitter](https://tree-sitter.github.io/), stores every symbol, edge, and file in a local SQLite database, and exposes the result as a queryable **knowledge graph** — over the [Model Context Protocol (MCP)](/solidkg/reference/mcp-server/), a CLI, and a TypeScript library.

It exists to help AI coding agents — Claude Code, Cursor, Codex CLI, opencode, and Hermes Agent — **answer structural questions with less file scanning**. Instead of relying exclusively on `grep`, `glob`, and `Read` to reconstruct how code fits together, an agent can query a pre-built index first and fall back to source when graph evidence is incomplete.

## Why it matters

When an agent explores a codebase, it can spend much of its budget on *discovery* — finding the right files before it can read them. SolidKG reduces that work when indexed graph evidence is sufficient; direct source inspection remains necessary when coverage is partial or runtime-only.

The [Capability Record](/solidkg/core-concepts/capabilities/) presents the OpenAI/OpenCode comparison and retrieval diagnostics in chart form, including repeat counts and claim boundaries.

## What's in the graph

- **Symbols** — functions, classes, methods, types, routes, components, and more.
- **Edges and semantic relations** — calls, imports, inheritance, references, route chains, event channels, and framework-specific relationships.
- **Files** — structure plus full-text search (FTS5).

Extraction is **deterministic** — derived from the AST, never LLM-summarized.

## Product boundary

SolidKG is not a Studio app, browser visualization, interactive graph canvas, or graph UI. It is a local graph engine for agents and scripts, exposed through MCP, CLI commands, and the TypeScript API.

Use the compact/default MCP profile for agent workflows: it exposes only answer-producing `solidkg_explore`, which accepts natural-language structural questions or precise symbol/file terms. Set `SOLIDKG_MCP_TOOLS=all` for explicit trace, impact, SCIP, snapshot, architecture, context, and repository-map workflows. Use the CLI for non-GUI exports and queries, including `context`, `query`, `files`, `status --json`, `context --format json`, `snapshot`, and `architecture`. Use the SDK/API when you want those graph operations inside your own program.

SolidKG does not open a browser or start a visualization app by default. If you want charts or a custom visual explorer, query or export the graph and render it in your own tool.

## Local-first by default

The normal graph index lives on your machine as a SQLite database in `.solidkg/`. Optional SCIP generation can run local language indexers when configured, but SolidKG does not require API keys or hosted services for its core AST graph. When you use SolidKG through an AI coding agent, MCP responses can contain source snippets that the host sends to its configured model provider; use a local model or review that provider's data policy when source must remain on-device.

## How is this different from Serena?

Serena and SolidKG both help coding agents inspect projects locally, but they are shaped differently. Serena is a coding-agent toolkit with language-server-style symbolic tools and project memory features. SolidKG is a local knowledge graph engine: it parses the repository with tree-sitter, stores symbols, edges, semantic relations, files, snapshots, architecture rollups, and optional SCIP facts in SQLite, then exposes that data through MCP tools, a CLI, and a TypeScript API.

The SolidKG-versus-control benchmark numbers on this site are not head-to-head Serena benchmarks. A separate exploratory report compares SolidKG, CodeGraph, and no graph under OpenCode; it is explicitly diagnostic rather than claim-grade. Neither report claims that SolidKG is faster or better than Serena.

Ready to try it? Head to the [Quickstart](/solidkg/getting-started/quickstart/).
