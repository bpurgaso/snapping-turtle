#!/usr/bin/env bash
# Build the release binary and package it as an RPM (desktop file, hicolor
# icons, binary, docs) into client-linux/dist/. Mirrors the extension's
# build:release discipline: the two baked identities come from the
# environment, else from deploy/.env, else (app id only) the development
# default. Usage:  client-linux/scripts/package-rpm.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/.." && pwd)
cd "$here"

if [ -f "$repo/deploy/.env" ]; then
  # Only the two keys we need; never source a whole .env (it holds secrets).
  env_val() { grep -E "^$1=" "$repo/deploy/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
  : "${CLIENT_APP_ID:=$(env_val CLIENT_APP_ID || true)}"
  if [ -z "${PUBLIC_ORIGIN:-}" ]; then
    host=$(env_val PUBLIC_HOST || true); port=$(env_val PUBLIC_PORT || true)
    if [ -n "$host" ] && [ -n "$port" ] && [ "$host" != "shots.example.com" ]; then PUBLIC_ORIGIN="https://$host:$port"; fi
  fi
fi
export CLIENT_APP_ID="${CLIENT_APP_ID:-}" PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-}"
[ -n "$CLIENT_APP_ID" ] || { echo "package-rpm: CLIENT_APP_ID unset — using the development app id"; }

version=$(grep -E '^version = ' Cargo.toml | head -1 | cut -d'"' -f2)
cargo build --release --locked
bin=target/release/snapping-turtle
app_id=$("$bin" --print-app-id)
if [ -n "$CLIENT_APP_ID" ] && [ "$app_id" != "$CLIENT_APP_ID" ]; then
  echo "package-rpm: binary reports app id $app_id but CLIENT_APP_ID=$CLIENT_APP_ID" >&2; exit 1
fi

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
staging="$work/staging"
install -Dm755 "$bin" "$staging/usr/bin/snapping-turtle"
# The file NAME is the app id (see packaging/snapping-turtle.desktop and src/app_id.rs).
install -Dm644 packaging/snapping-turtle.desktop "$staging/usr/share/applications/$app_id.desktop"
for dir in packaging/icons/hicolor/*/apps; do
  size=$(basename "$(dirname "$dir")")
  install -Dm644 "$dir"/snapping-turtle.* -t "$staging/usr/share/icons/hicolor/$size/apps/"
done
install -Dm644 README.md TESTING.md -t "$staging/usr/share/doc/snapping-turtle/"

mkdir -p dist "$work/rpm"
rpmbuild -bb packaging/snapping-turtle.spec \
  --define "_topdir $work/rpm" --define "version $version" \
  --define "app_id $app_id" --define "staging $staging" \
  --define "_rpmfilename %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" \
  --undefine _disable_source_fetch >/dev/null
cp "$work"/rpm/RPMS/*.rpm dist/
cp "$bin" dist/snapping-turtle
(cd dist && sha256sum ./*.rpm snapping-turtle > SHA256SUMS)
echo "package-rpm: app id $app_id, version $version"
ls -1 dist
