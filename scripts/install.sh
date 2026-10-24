#!/bin/sh
#
# SolidKG standalone installer.
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools, no npm
# required - ideal for a fresh Linux VPS over SSH.
#
#   curl -fsSL https://raw.githubusercontent.com/Valid-Systems/SolidKG/main/scripts/install.sh | sh
#
# Upgrade:   re-run the same command.
# Uninstall: curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Environment:
#   SOLIDKG_VERSION      release tag to install (default: latest)
#   SOLIDKG_INSTALL_DIR  bundle location   (default: ~/.solidkg)
#   SOLIDKG_BIN_DIR      symlink location  (default: ~/.local/bin)
set -eu

INSTALL_DIR="${SOLIDKG_INSTALL_DIR:-$HOME/.solidkg}"
BIN_DIR="${SOLIDKG_BIN_DIR:-$HOME/.local/bin}"
LATEST_URL="${SOLIDKG_LATEST_URL:-https://github.com/Valid-Systems/SolidKG/releases/latest}"
DOWNLOAD_BASE="${SOLIDKG_DOWNLOAD_BASE:-https://github.com/Valid-Systems/SolidKG/releases/download}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/solidkg"
  rm -rf "$INSTALL_DIR"
  echo "SolidKG uninstalled (removed $INSTALL_DIR and $BIN_DIR/solidkg)."
  exit 0
fi

# 1. Detect platform → target triple matching the release archives.
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "solidkg: unsupported OS '$os'." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "solidkg: unsupported architecture '$arch'." >&2; exit 1 ;;
esac
target="${os}-${arch}"

# 2. Resolve the version (latest release unless pinned).
version="${SOLIDKG_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$LATEST_URL" \
    | sed -n 's#.*/releases/tag/##p')"
fi
[ -n "$version" ] || { echo "solidkg: could not resolve latest version; set SOLIDKG_VERSION (e.g. SOLIDKG_VERSION=v0.9.4)." >&2; exit 1; }
# Release tags are vX.Y.Z; accept a bare X.Y.Z in SOLIDKG_VERSION too.
case "$version" in v*) ;; *) version="v$version" ;; esac

# 3. Download + extract the bundle.
asset="solidkg-${target}.tar.gz"
url="$DOWNLOAD_BASE/$version/$asset"
echo "Installing SolidKG $version ($target)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/cg.tar.gz" || { echo "solidkg: download failed: $url" >&2; exit 1; }
sums_url="$DOWNLOAD_BASE/$version/SHA256SUMS"
curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS" || { echo "solidkg: checksum unavailable: $sums_url" >&2; exit 1; }
expected="$(awk -v asset="$asset" '
  {
    name = $2
    sub(/^\*/, "", name)
    count = split(name, parts, /[\\/]/)
    if (parts[count] == asset && length($1) == 64) {
      print tolower($1)
      exit
    }
  }
' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || { echo "solidkg: checksum unavailable for $asset" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/cg.tar.gz" | awk '{ print tolower($1) }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/cg.tar.gz" | awk '{ print tolower($1) }')"
elif command -v openssl >/dev/null 2>&1; then
  actual="$(openssl dgst -sha256 "$tmp/cg.tar.gz" | awk '{ print tolower($NF) }')"
else
  echo "solidkg: checksum unavailable: no SHA-256 tool found" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { echo "solidkg: checksum mismatch for $asset" >&2; exit 1; }
echo "solidkg: checksum verified."

dest="$INSTALL_DIR/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
# Archives contain a top-level solidkg-<target>/ dir; strip it.
tar -xzf "$tmp/cg.tar.gz" -C "$dest" --strip-components=1

# 4. Symlink the launcher onto PATH and mark the current version.
mkdir -p "$BIN_DIR"
ln -sf "$dest/bin/solidkg" "$BIN_DIR/solidkg"
ln -sfn "$dest" "$INSTALL_DIR/current"

for old in "$INSTALL_DIR"/versions/*; do
  [ -e "$old" ] || continue
  [ "$old" = "$dest" ] && continue
  rm -rf "$old"
done

echo "Installed to $dest"
echo "Linked     $BIN_DIR/solidkg"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add it:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo ""
echo "Done. Run: solidkg --help"
