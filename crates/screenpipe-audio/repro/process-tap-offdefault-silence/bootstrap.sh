#!/bin/bash
# #4638 box bootstrap: rust + homebrew(no-sudo) + deps + clone + build. No sudo here.
set -uo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 NONINTERACTIVE=1
ROOT="$HOME/screenpipe-4638"; REPO="$ROOT/screenpipe"; mkdir -p "$ROOT"

echo "=== [1/6] RUST ==="
[ -x "$HOME/.cargo/bin/cargo" ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
. "$HOME/.cargo/env"; cargo --version || { echo "FATAL rust"; exit 11; }

echo "=== [2/6] HOMEBREW (no-sudo into owned /opt/homebrew) ==="
[ -x /opt/homebrew/bin/brew ] || git clone --depth=1 https://github.com/Homebrew/brew /opt/homebrew
eval "$(/opt/homebrew/bin/brew shellenv)"; brew --version || { echo "FATAL brew"; exit 12; }

echo "=== [3/6] BREW DEPS ==="
brew install cmake pkg-config protobuf || { echo "FATAL brew deps"; exit 13; }

echo "=== [4/6] FETCH BLACKHOLE PKGS ==="
brew fetch --cask blackhole-2ch blackhole-16ch || echo "WARN blackhole fetch"
echo "BH2_PKG=$(brew --cache --cask blackhole-2ch 2>/dev/null)"
echo "BH16_PKG=$(brew --cache --cask blackhole-16ch 2>/dev/null)"

echo "=== [5/6] CLONE REPO ==="
[ -d "$REPO/.git" ] || git clone --depth 1 --branch main https://github.com/screenpipe/screenpipe.git "$REPO" || { echo "FATAL clone"; exit 15; }
cp "$HOME"/sp_examples/*.rs "$REPO/crates/screenpipe-audio/examples/" || { echo "FATAL cp examples"; exit 16; }

echo "=== [6/6] BUILD (slow) ==="
cd "$REPO"
cargo build -p screenpipe-audio --example process_tap_anchor_repro --example play_tone_coreaudio --example set_default_output
echo "BOOTSTRAP_DONE_RC=$?"
