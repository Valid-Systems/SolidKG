---
title: Get Started
description: Get up and running with SolidKG in seconds.
---

Get up and running with SolidKG in seconds.

## No Node.js required, one command grabs the right build for your OS

```bash
# macOS / Linux
curl -fsSL https://solidkg.local/install/install.sh | sh

# Windows (PowerShell)
irm https://solidkg.local/install/install.ps1 | iex
```

## Already have Node? Use npm instead (works on any version)

```bash
npx solidkg        # zero-install, or:
npm i -g solidkg
```

SolidKG bundles its own runtime. There is nothing to compile, no native build, and it works the same everywhere. The interactive installer auto-configures supported agents such as Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, and Kimi Code.

## Initialize Projects

```bash
cd your-project
solidkg init -i
```

That's it. Your agent will use SolidKG tools automatically when a `.solidkg/` directory exists.

Next: build [Your First Graph](/solidkg/getting-started/your-first-graph/), or see the full [Installation](/solidkg/getting-started/installation/) options.
