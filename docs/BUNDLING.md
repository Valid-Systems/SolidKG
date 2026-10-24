# Distribution: self-contained bundles

SolidKG ships a **vendored Node 24 runtime** alongside the app. Because Node
24 includes real built-in SQLite (`node:sqlite`, with WAL + FTS5), bundling Node
means:

- **No SQLite native build** — `better-sqlite3` is gone; the only target-specific
  native code is the prebuilt tree-sitter language-pack addon and parser libraries.
- **No wasm fallback** — and therefore no more `database is locked` (issue #238).
- **No Node-version dependence** — the app always runs on the bundled Node,
  whatever the user has (or doesn't have) installed.

## What's in a bundle

Built by [`scripts/build-bundle.sh`](scripts/build-bundle.sh) — one archive per
platform, identical recipe (only the Node download differs):

```
solidkg-<target>/
  node | node.exe          # official Node runtime for <target>
  lib/
    dist/                  # compiled app (+ schema, parser metadata, native grammar libraries)
    node_modules/          # production deps, including the target N-API parser addon
  bin/
    solidkg | solidkg.cmd   # launcher → runs the bundled Node with the app
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`,
`win32-arm64`. Unix targets produce `.tar.gz` (shell launcher); Windows produces
`.zip` (`node.exe` + a `.cmd` launcher).

```bash
scripts/build-bundle.sh linux-x64            # -> release/solidkg-linux-x64.tar.gz
scripts/build-bundle.sh win32-x64            # -> release/solidkg-win32-x64.zip
```

Native parser artifacts are platform- and architecture-specific. Each bundle is
built and smoke-tested on its matching target, where `prepare:native-runtime`
stages the pinned grammar libraries and the build repairs the Windows addon's
Node import when required. Cross-building a native bundle on another target is
rejected by `build-bundle.sh`.

## Install channels (all deliver the same bundle)

1. **`curl | sh`** ([`scripts/install.sh`](../scripts/install.sh)) — no Node required; ideal for a
   fresh Linux VPS over SSH. Detects os/arch, pulls the archive from GitHub
   Releases, symlinks `solidkg` onto PATH. Re-run to upgrade; `--uninstall` to
   remove.
2. **npm** ([`scripts/npm-shim.js`](scripts/npm-shim.js)) — preserves
   `npm i -g solidkg`. The main package is a tiny shim; the
   bundles ship as per-platform `optionalDependencies`
   (`@solidkg/<target>` with `os`/`cpu`), so npm installs only the
   matching one. The shim — run by the user's Node — execs the bundle, so the
   real work runs on the bundled Node 24.16.0. Works even on old Node. On Windows it
   invokes the bundled `node.exe` against the app entry directly (not the `.cmd`
   launcher) — modern Node throws `EINVAL` when asked to spawn a `.cmd`/`.bat`.
   If a registry mirror skips the optional package and downloads are disabled,
   manually unpack the matching release archive into the shim cache, e.g.
   `solidkg-linux-x64.tar.gz` -> `~/.solidkg/bundles/linux-x64-<version>`.
3. **Windows** ([`scripts/install.ps1`](../scripts/install.ps1)) — `irm … | iex`; same flow as
   install.sh (detect arch, pull the `.zip` from Releases, add to PATH).
4. **Homebrew / Scoop** — TODO (tap + cask pointing at the Release archives).

## Release pipeline

[`.github/workflows/release.yml`](.github/workflows/release.yml) — manually
triggered. Reads the version from `package.json`, builds each platform bundle on
its matching matrix runner, creates the GitHub Release, and publishes
the npm shim + per-platform packages. Publishes through npm trusted publishing (GitHub OIDC); no `NPM_TOKEN` secret is used. Each package (`solidkg` and `@solidkg/<platform>-<arch>`) must trust `Valid-Systems/SolidKG` workflow `release.yml`.

Still TODO:
- **Code signing** — the main gap for "download & run": macOS Gatekeeper needs a
  Developer ID + notarization; Windows needs Authenticode. Homebrew softens the
  macOS case (handles quarantine).
- Re-wire `npm uninstall` cleanup (the agent-config `preuninstall`) through the
  shim — the generated main package doesn't carry it.
