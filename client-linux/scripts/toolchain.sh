#!/usr/bin/env bash
# Install rustup if it is absent, then the exact toolchain that
# client-linux/rust-toolchain.toml names, and print the versions the build
# will use. The single toolchain path for CI (the fedora:44 job, the
# integration job's Ubuntu runner, the release job) and for a local container
# rehearsal — never `dnf install rust`: that is whatever the distro's updates
# repo holds that day, which is how CI and a developer's machine drifted apart
# (CLAUDE.md gotchas). Nothing here touches the crate; the pin file is the
# authority and this script only makes sure rustup is there to obey it.
# Later GitHub steps see $HOME/.cargo/bin through GITHUB_PATH; anywhere else
# (a fresh container rehearsal) export PATH="$HOME/.cargo/bin:$PATH" yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v rustup >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
# Later steps of a GitHub job get the same PATH; a no-op elsewhere.
if [ -n "${GITHUB_PATH:-}" ]; then echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"; fi

# No toolchain argument: rustup (≥ 1.28) installs the channel, components and
# profile from rust-toolchain.toml in the current directory.
rustup --version
rustup toolchain install
rustup show active-toolchain
cargo --version && rustc --version && cargo clippy --version && cargo fmt --version
