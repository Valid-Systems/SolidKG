#!/usr/bin/env bash
#
# Build a self-contained SolidKG bundle: an official Node runtime + the
# compiled app + its production dependencies and parser libraries. Native
# parser artifacts require this script to run on the target OS and architecture.
#
# Usage:
#   scripts/build-bundle.sh <target> [node-version]
#     target:        darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                  | win32-x64 | win32-arm64
#     node-version:  e.g. v24.16.0 (default below; pin for reproducible builds)
#
# Output:
#   unix:    release/solidkg-<target>.tar.gz   (launcher: bin/solidkg)
#   windows: release/solidkg-<target>.zip      (launcher: bin/solidkg.cmd)
set -euo pipefail

TARGET="${1:?usage: build-bundle.sh <target> [node-version]}"
NODE_VERSION="${2:-v24.16.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SOLIDKG_RELEASE_DIR:-$ROOT/release}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCH="${TARGET##*-}"   # x64 | arm64
OSFAM="${TARGET%-*}"   # darwin | linux | win32
HOST_TARGET="$(node -p "process.platform + '-' + process.arch")"

[ "$TARGET" = "$HOST_TARGET" ] || {
  echo "[bundle] error: native target ${TARGET} cannot be built on ${HOST_TARGET}" >&2
  exit 1
}

echo "[bundle] target=${TARGET} node=${NODE_VERSION}"

# 1. Download + extract the official Node runtime for the target platform.
if [ "$OSFAM" = "win32" ]; then
  NODE_DIST="node-${NODE_VERSION}-win-${ARCH}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.zip"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$WORK/node.zip" -d "$WORK"
  else
    tar -xf "$WORK/node.zip" -C "$WORK"   # bsdtar can read zip
  fi
  NODE_BIN="$WORK/${NODE_DIST}/node.exe"
else
  NODE_DIST="node-${NODE_VERSION}-${TARGET}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.gz"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.tar.gz"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  NODE_BIN="$WORK/${NODE_DIST}/bin/node"
fi
[ -f "$NODE_BIN" ] || { echo "[bundle] error: node binary not found ($NODE_BIN)" >&2; exit 1; }

# 2. Build the app and stage the current platform's parser libraries.
echo "[bundle] building app"
( cd "$ROOT" && pnpm run build >/dev/null )

# 3. Stage the app and current-platform production dependencies.
STAGE="$WORK/solidkg-${TARGET}"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
echo "[bundle] installing production dependencies"
( cd "$STAGE/lib" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
rm -f "$STAGE/lib/package-lock.json"

NATIVE_SOURCE="$ROOT/.native-grammars/$TARGET"
NATIVE_DESTINATION="$STAGE/lib/dist/extraction/native/$TARGET"
node "$ROOT/scripts/copy-native-grammars.mjs" \
  --source "$NATIVE_SOURCE" \
  --destination "$NATIVE_DESTINATION"
node "$ROOT/scripts/prepare-native-runtime.mjs" \
  --package-root "$STAGE/lib" \
  --addon-only
node "$ROOT/scripts/verify-native-runtime.mjs" \
  --package-root "$STAGE/lib" \
  --grammar-dir "$NATIVE_DESTINATION"

# 4. Vendored Node + launcher.
if [ "$OSFAM" = "win32" ]; then
  cp "$NODE_BIN" "$STAGE/node.exe"
  printf '@"%%~dp0..\\node.exe" "%%~dp0..\\lib\\dist\\bin\\solidkg.js" %%*\r\n' \
    > "$STAGE/bin/solidkg.cmd"
  BUNDLED_NODE="$STAGE/node.exe"
else
  cp "$NODE_BIN" "$STAGE/node"
  cat > "$STAGE/bin/solidkg" <<'LAUNCH'
#!/bin/sh
# Resolve symlinks (e.g. the ~/.local/bin/solidkg link install.sh creates) so
# we find the real bundle dir, not the symlink's location.
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$DIR/node" "$DIR/lib/dist/bin/solidkg.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/solidkg"
  BUNDLED_NODE="$STAGE/node"
fi

# 5. Exercise the staged CLI with network grammar resolution disabled.
SMOKE_PROJECT="$WORK/smoke-project"
mkdir -p "$SMOKE_PROJECT"
printf 'export function greet(name: string): string { return `Hello ${name}`; }\n' \
  > "$SMOKE_PROJECT/index.ts"
TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL="file:///definitely-missing/parsers.json" \
SOLIDKG_NO_DAEMON=1 \
  "$BUNDLED_NODE" "$STAGE/lib/dist/bin/solidkg.js" init -i "$SMOKE_PROJECT" >/dev/null
TREE_SITTER_LANGUAGE_PACK_MANIFEST_URL="file:///definitely-missing/parsers.json" \
SOLIDKG_NO_DAEMON=1 \
  "$BUNDLED_NODE" "$STAGE/lib/dist/bin/solidkg.js" query greet --path "$SMOKE_PROJECT" >/dev/null

# 6. Archive (.zip for Windows, .tar.gz otherwise).
mkdir -p "$OUT"
if [ "$OSFAM" = "win32" ]; then
  ARCHIVE="$OUT/solidkg-${TARGET}.zip"
  rm -f "$ARCHIVE"
  ( cd "$WORK" && 7z a -tzip "$ARCHIVE" "solidkg-${TARGET}" >/dev/null )
else
  ARCHIVE="$OUT/solidkg-${TARGET}.tar.gz"
  # --no-xattrs: don't embed macOS xattrs that make GNU tar warn on Linux.
  tar --no-xattrs -czf "$ARCHIVE" -C "$WORK" "solidkg-${TARGET}"
fi
echo "[bundle] wrote ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
