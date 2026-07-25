# Agent-led setup

This is the authoritative runbook for an AI coding agent installing SolidKG, configuring one supported coding client, indexing a real project, and proving the MCP integration works end to end.

## Give this to your agent

Copy this instruction into your coding agent:

> Read `docs/setup.md` completely. Inspect this machine and the target project without changing anything. Recommend an install path, coding-agent target, and configuration scope, explain exactly what files or global locations would change, and wait for my confirmation. Then install SolidKG, configure only the approved target, initialize the approved project, restart or ask me to restart the client, and run the real MCP acceptance check. Do not claim success until `solidkg_explore` returns source and an answer packet.

## Non-negotiable rules for the installing agent

- Inspect first. Do not install packages, write configuration, or initialize a project during preflight.
- Get confirmation before a global install, user-level configuration change, source link, or removal of another MCP server.
- Configure only the client and scope the user approved.
- Preserve unrelated sibling settings, comments, instruction files, and MCP servers.
- Do not replace the pinned grammar manifest or vendored SCIP sources with upstream HEAD or an arbitrary binary.
- A successful command is not acceptance. The configured client must expose `solidkg_explore`, and a real call must return line-numbered source plus an answer packet.

## 1. Read-only preflight

Report the operating system, CPU architecture, project path, coding client, requested scope, and whether SolidKG is already installed:

```bash
solidkg --version
git --version
node --version
npm --version
pnpm --version
```

Missing commands are facts, not failures. Node.js and pnpm are required only for a source checkout; the standalone release bundles include their own runtime. The npm installation path needs npm for installation, then runs SolidKG with the bundled runtime.

If `solidkg` already exists, run the read-only installer diagnostic before recommending any change:

```bash
solidkg install --check --target all --location global
```

Also inspect the selected project for `.solidkg/`, existing MCP configuration, and competing knowledge-graph servers. Show the exact files and entries involved. Do not remove or disable anything yet.

## 2. Confirm four decisions

Ask the user to confirm:

1. **Install path:** released npm package, standalone release bundle, or source checkout.
2. **Coding client:** `claude`, `cursor`, `codex`, `opencode`, `hermes`, `antigravity`, `omp`, or `kimi`.
3. **Configuration scope:** `global` or `local`, where supported by that client.
4. **Project path:** the source tree SolidKG should initialize and index.

Recommend the released npm package when npm is already available. Recommend a standalone bundle when the user wants no Node.js/npm dependency. Use a source checkout for contributors or when the user explicitly wants to validate this repository's current source.

## 3. Install the approved distribution

### Released npm package

```bash
npm install -g solidkg
solidkg --version
```

### Standalone release bundle

Select the matching OS/architecture asset from [GitHub Releases](https://github.com/Valid-Systems/SolidKG/releases). Review the downloaded installer or archive before running it, install it into the user-approved location, then run:

```bash
solidkg --version
```

Do not download a mutable branch or substitute a third-party binary.

### Source checkout

Require Node.js 24 and the pnpm version pinned in `package.json`, then prove the checkout before configuring a client:

```bash
pnpm install --frozen-lockfile
pnpm run verify:source:full
```

`verify:source:full` builds the TypeScript source, validates copied assets and vendored integrations, exercises real SQLite/tree-sitter indexing and SCIP linking, calls the stdio MCP server, runs the public tests, and checks release-package contents.

If the user wants this checkout on `PATH`, explain that `pnpm run install:source` writes to pnpm's global package/bin location and obtain confirmation before running it.

## 4. Configure one coding client

Run the diagnostic again with the approved target and scope. Explain every file it reports before writing:

```bash
solidkg install --check --target <target> --location <global-or-local>
```

Then configure only that target:

```bash
solidkg install --target <target> --location <global-or-local>
```

If automatic editing is unsupported or the config is malformed, print the provider-neutral snippet instead of guessing:

```bash
solidkg install --print-config <target>
```

If another graph MCP server is present, leave it active until SolidKG passes acceptance. Remove a recognized predecessor only with explicit approval, after recording its exact entry and backup path.

## 5. Initialize and inspect a real project

```bash
solidkg init -i "<project-path>"
solidkg status "<project-path>"
```

The status check must identify the project, SQLite backend and journal mode, indexed file count, and graph counts. Investigate an empty or partial index instead of treating process exit as success.

For a source checkout, missing `src/db/schema.sql`, `src/extraction/native-grammars.json`, or maintained `vendored/scip-*` sources means the checkout is incomplete. Re-download the same commit; do not fabricate placeholders.

## 6. Real MCP acceptance

Restart the configured coding client so it reloads MCP configuration. Then verify all of the following through that client:

1. The tool list contains `solidkg_explore`.
2. Call `solidkg_explore` with a normal structural question about the initialized project, such as: `Where is the main entry point and what does it call?`
3. Confirm the response contains relevant line-numbered source and structural or flow evidence.
4. Confirm the response includes an answer packet with evidence anchors and returned-context sufficiency.
5. Confirm no separate installer, test server, terminal, or detached background process was left running.

Configuration presence, a green unit test, or `solidkg status` alone does not pass this gate.

## 7. Recovery

| Symptom | Required response |
|---|---|
| Wrong Node major or pnpm version for source | Switch to Node 24 and the pinned pnpm version; reinstall only this checkout's dependencies with `--frozen-lockfile`. |
| Lockfile mismatch | Stop and inspect the manifest/lock diff. Do not regenerate dependency resolutions merely to obtain a pass. |
| Missing source assets or vendored indexers | Re-clone or re-download the same commit. Never substitute floating upstream sources. |
| Missing or stale `dist/` assets | Run `pnpm run build`, then rerun the failed source-verification gate. |
| Installer reports malformed config | Use `--print-config`; do not overwrite the user's file with a newly generated replacement. |
| Tool missing after installation | Rerun `install --check`, confirm the selected target/scope, restart the client, and inspect the client's MCP logs. |
| Tool exists but the real query fails | Keep any predecessor active, preserve logs and backups, repair the specific failure, and repeat the MCP acceptance call. |

## 8. Required completion report

Report:

- OS and architecture.
- Distribution and exact SolidKG version.
- Coding client, target name, and configuration scope.
- Every configuration or instruction file changed and its backup path.
- Initialized project and data-directory path.
- `solidkg status` summary.
- Source-verification result, if the source path was used.
- MCP tool visibility and the structural question asked.
- Whether source, graph evidence, and the answer packet were observed.
- Any unverified platform, optional SCIP language, warning, or retained predecessor.

## Cleanup or rollback

Removing client integration does not remove project indexes:

```bash
solidkg uninstall --target <target> --location <global-or-local>
```

Removing a project index is separate and destructive; obtain confirmation first:

```bash
solidkg uninit "<project-path>"
```

Uninstall the global npm package or standalone bundle only when the user explicitly requests it. Preserve unrelated client settings and backups.
