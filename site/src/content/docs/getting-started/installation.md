---
title: Installation
description: Install SolidKG and configure your AI coding agents.
---

## 1. Run the installer

```bash
npx solidkg
```

The installer will:

- Ask which agent(s) to configure, auto-detecting installed ones from **Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**, **Antigravity**, **OMP / Pi coding agent**, and **Kimi Code**.
- Prompt to install `solidkg` on your `PATH` so agents can launch the MCP server.
- Ask whether configs apply to personal/user scope (`global`) or project/team scope (`local`) when the target supports both.
- Write each chosen agent's MCP server config plus the instructions file that host reads, preserving sibling config entries.
- Set up auto-allow permissions when Claude Code is one of the targets.
- Initialize your current project on first local install using the same best-effort SCIP bootstrap as `solidkg init -i`.

Before mutating an existing config or instruction file, SolidKG writes a timestamped sibling backup such as `config.jsonc.solidkg-backup.<timestamp>.<pid>.<n>`. Reruns that are already current report `unchanged`, keep files byte-identical, and don't create redundant backups.

## Non-interactive scripting and CI

```bash
solidkg install --yes                              # auto-detect agents, install global
solidkg install --target=cursor,claude --yes       # explicit target list
solidkg install --target=auto --location=local     # detected agents, project-local
solidkg install --print-config codex               # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,...`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | boolean | prompt every step |
| `--no-permissions` | boolean, skip Claude auto-allow list | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | none |

Manual setup for gptme, Trae, Devin, CodeBuddy, or another MCP-capable host should use that host's documented MCP UI or config. SolidKG does not guess undocumented config paths or automate a target until reversible writes are covered by installer tests. See [Integrations](/solidkg/reference/integrations/) for the provider-neutral MCP snippet and known fallback flows.

## 2. Restart your agent

Restart your agent for the MCP server to load. Automated targets currently include Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Antigravity, OMP / Pi coding agent, and Kimi Code.

## 3. Initialize projects

```bash
cd your-project
solidkg init -i
```

This builds the per-project knowledge graph index and wires up any project-local agent surfaces, so a single global `solidkg install` works in every project you open.

## Supported platforms

Every release ships a self-contained build with a bundled Node runtime and nothing to compile for all three desktop OSes, on both x64 and arm64:

| Platform | Architectures | Install |
|---|---|---|
| Windows | x64, arm64 | PowerShell installer or npm |
| macOS | x64, arm64 | shell installer or npm |
| Linux | x64, arm64 | shell installer or npm |

## Uninstall

Changed your mind? One command removes SolidKG from every agent it configured:

```bash
solidkg uninstall
```

This reverses the installer by removing SolidKG's MCP server config, instructions, and permissions from each configured agent. Before changing existing files, install and uninstall create timestamped sibling backups. Your project indexes (`.solidkg/` or an external `--data-dir`) are left untouched; remove those per-project with `solidkg uninit`. Use `--target` to remove from specific agents, or `--yes` to run non-interactively.