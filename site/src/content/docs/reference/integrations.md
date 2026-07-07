---
title: Integrations
description: Supported agents, installer scope, and manual MCP setup.
---

The interactive installer configures supported agents by wiring up the MCP server and writing the agent instructions file that host reads.

## Supported installer targets

Current automated targets:

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Antigravity**
- **OMP / Pi coding agent**
- **Kimi Code**

Run `npx solidkg` and pick your agent(s); see [Installation](/solidkg/getting-started/installation/) for non-interactive flags.

## Scope and backups

Installer scope is provider-neutral:

- `--location=global` means the agent's personal or user-owned config for projects opened by this account.
- `--location=local` means project-owned files in the current directory for agents that expose a team or project config surface.

Some agents expose only one scope. In that case SolidKG skips unsupported scopes with a target-specific note.

Before changing an existing config or instruction file, SolidKG writes a timestamped sibling backup such as `config.jsonc.solidkg-backup.<timestamp>.<pid>.<n>`. Idempotent reruns that report `unchanged` keep files byte-identical and don't create new backups. `solidkg uninstall` uses the same target contract in reverse and leaves project indexes alone.

## Manual setup

Manual setup is for MCP-capable hosts that don't yet have enough public contract detail for a safe automated target: a deterministic config path, deterministic MCP schema, reversible sibling-preserving writes, and an instruction file the host reads.

Paste the same stdio server command into the host's documented MCP UI or config:

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

Known fallback flows from public docs:

- gptme documents `~/.config/gptme/config.toml` with `[[mcp.servers]]` entries.
- Trae exposes MCP settings and a manual JSON flow.
- Devin uses Settings > MCP Marketplace > Add Your Own.
- CodeBuddy exposes `codebuddy mcp add` plus `~/.codebuddy.json` and project `.mcp.json`.

These are not `solidkg install --target` values until a safe target is added and covered by the shared installer tests.

:::tip
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::

## Tool names

The raw MCP server tool names are the documented `solidkg_*` names. Some clients display their own prefix in UI, logs, or permission strings. That prefix is client-specific display text, not part of the server tool name.