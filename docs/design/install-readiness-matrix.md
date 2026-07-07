# Install Readiness Matrix

This matrix is a conservative execution plan for install and platform readiness. It is not release documentation. Do not run publish, tag, GitHub Release, deploy, or npm publish commands from this plan.

## Runtime Assumptions

- Source checkout requires Node 24, matching the repository engine range `>=24.0.0 <25.0.0` and the current `node:sqlite` runtime dependency.
- Released bundles use a vendored Node runtime. A standalone bundle or per-platform npm optional package must not require system Node to run SolidKG itself.
- The npm shim may need a user Node only as a thin launcher. The real SolidKG process runs from the bundled Node inside the optional dependency or local bundle cache.
- Supported bundle targets are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, and `win32-arm64`.
- Windows readiness must pass on a Windows local host or Windows VM. Linux readiness should use a clean copied source in Docker or WSL, not host `node_modules`. Docker Linux is not macOS validation.
- macOS readiness needs a real macOS host or macOS CI runner. If macOS cannot run later, it must be explicitly blocked or waived with owner approval.
- Installer smoke commands that write config must use temp `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and npm user config paths. They must not mutate real user config.
- Evaluation corpus package exclusion is a later gate owned by Task 3. Before any release candidate, package and bundle file lists should confirm corpus, tests, caches, and other non-allowlisted payloads are excluded.

## Matrix

| Mode | Platform | Prerequisites | Install Command | Smoke Command | Expected Result | Evidence Path |
|---|---|---|---|---|---|---|
| source checkout | Windows local, Linux clean-copy Docker or WSL, macOS real host or CI | Node 24, pnpm via Corepack, Git, clean dependency install inside the target OS | `pnpm install && pnpm run build` | `node dist/bin/solidkg.js --help && node dist/bin/solidkg.js status .` | CLI starts from built source on Node 24 and can read repository status without using a release bundle. | `.omo/evidence/task-4-source-checkout-smoke.txt` |
| standalone shell installer, `scripts/install.sh` | Linux x64, Linux arm64, macOS x64, macOS arm64 | `sh`, `curl`, `tar`, writable temp `HOME`, local bundle mirror or pinned released artifact, no system Node required for installed bundle | `HOME="$TMPDIR/cg-home" SOLIDKG_VERSION="$VERSION" SOLIDKG_INSTALL_DIR="$TMPDIR/cg-home/.solidkg" SOLIDKG_BIN_DIR="$TMPDIR/cg-home/bin" SOLIDKG_DOWNLOAD_BASE="$DOWNLOAD_BASE" sh ./scripts/install.sh` | `HOME="$TMPDIR/cg-home" PATH="$TMPDIR/cg-home/bin:$PATH" solidkg --help && solidkg --version` | Installer detects `darwin` or `linux`, selects x64 or arm64 tarball, installs under the temp home, creates the temp bin symlink, and the vendored Node launcher runs. | `.omo/evidence/task-4-install-sh-smoke.txt` |
| standalone PowerShell installer, `scripts/install.ps1` | Windows x64, Windows arm64 | PowerShell, network or local release mirror, temp `LOCALAPPDATA`, temp `TEMP`, no system Node required for installed bundle | `$env:LOCALAPPDATA="$Temp\LocalAppData"; $env:TEMP="$Temp\Temp"; $env:SOLIDKG_VERSION=$Version; $env:SOLIDKG_INSTALL_DIR="$Temp\LocalAppData\solidkg"; $env:SOLIDKG_DOWNLOAD_BASE=$DownloadBase; powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1` | `& "$Temp\LocalAppData\solidkg\current\bin\solidkg.cmd" --help; & "$Temp\LocalAppData\solidkg\current\bin\solidkg.cmd" --version` | Installer detects `win32-x64` or `win32-arm64`, extracts the zip under temp `LOCALAPPDATA`, and the bundled `node.exe` launcher runs. PATH mutation must be isolated to the temp Windows profile during smoke. | `.omo/evidence/task-4-install-ps1-smoke.txt` |
| npm shim and per-platform optional dependency | Windows local, Linux clean-copy Docker or WSL, macOS real host or CI | Node available for the shim process, npm, packed npm shim plus matching per-platform package, temp npm prefix and user config | `npm pack ./release/npm/main --pack-destination "$TMPDIR" --dry-run` then install the generated package into a temp prefix for a real smoke after bundles exist | `HOME="$TMPDIR/home" npm_config_userconfig="$TMPDIR/npmrc" npm install --prefix "$TMPDIR/prefix" --ignore-scripts --no-audit --no-fund "$TMPDIR/solidkg-$VERSION.tgz" && "$TMPDIR/prefix/bin/solidkg" --help` | Main package exposes `bin.solidkg`, lists per-platform `optionalDependencies`, and runs the matching bundled launcher when the optional dependency is present. `--omit=optional` is a metadata smoke only and cannot prove executable bundle coverage. | `.omo/evidence/task-4-npm-shim-smoke.txt` |
| agent integration installer | Windows local, Linux clean-copy Docker or WSL, macOS real host or CI | Built source or installed bundle, temp `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and target-specific config directories | `HOME="$TMPDIR/home" USERPROFILE="$TMPDIR/profile" APPDATA="$TMPDIR/appdata" LOCALAPPDATA="$TMPDIR/localappdata" node dist/bin/solidkg.js install --target opencode --path "$PWD"` | `HOME="$TMPDIR/home" USERPROFILE="$TMPDIR/profile" APPDATA="$TMPDIR/appdata" LOCALAPPDATA="$TMPDIR/localappdata" node dist/bin/solidkg.js install --target opencode --path "$PWD" --print-config` | Installer writes only temp profile config, preserves existing siblings on rerun, reports the SolidKG MCP config, and leaves real user config untouched. Repeat for each supported target before release readiness. | `.omo/evidence/task-4-agent-installer-smoke.txt` |
| local offline bundle cache | Windows local, Linux clean-copy Docker or WSL, macOS real host or CI | Built release archive for the matching target, temp cache under `SOLIDKG_INSTALL_DIR`, `SOLIDKG_NO_DOWNLOAD=1`, extraction tool, no network | Unix: `mkdir -p "$TMPDIR/home/.solidkg/bundles/$TARGET-$VERSION" && tar -xzf "release/solidkg-$TARGET.tar.gz" -C "$TMPDIR/home/.solidkg/bundles/$TARGET-$VERSION" --strip-components=1`; Windows: `tar -xf "release/solidkg-$TARGET.zip" -C "$Temp\home\.solidkg\bundles\$TARGET-$Version" --strip-components=1` | `SOLIDKG_INSTALL_DIR="$TMPDIR/home/.solidkg" SOLIDKG_NO_DOWNLOAD=1 node release/npm/main/npm-shim.js --help` | Shim finds the cached bundle and runs without network fallback. If cache is missing with `SOLIDKG_NO_DOWNLOAD=1`, it prints actionable no-bundle guidance and exits nonzero. | `.omo/evidence/task-4-offline-bundle-cache-smoke.txt` |

## Platform Readiness Rules

- Windows local readiness must include `win32-x64` and, when hardware or VM access exists, `win32-arm64`. PowerShell installer smoke must isolate `%LOCALAPPDATA%` and `%TEMP%`.
- Linux readiness must run from a clean copied source in Docker or WSL with dependencies installed inside that environment. Do not mount the repo and reuse host `node_modules`.
- macOS readiness must run on macOS. Docker Linux on a Mac host proves Linux behavior only.
- Bundle readiness is per target. A Linux x64 bundle smoke does not prove Linux arm64, macOS, or Windows bundles.
- npm readiness needs two checks: package metadata with `npm pack --dry-run`, and executable smoke with the matching optional dependency or preloaded offline cache.
- Agent installer readiness needs temp home and config paths for each supported target. Any smoke that writes to a real user profile is invalid.

## Release Boundary

Allowed readiness commands include local build, local bundle construction, package dry-run inspection, temp-prefix npm install smoke, isolated installer smoke, and checksum or artifact file-list checks.

Forbidden commands for this matrix include `npm publish`, `git tag`, `git push`, `gh release create`, `gh release upload`, and manual triggering of `.github/workflows/release.yml`.
