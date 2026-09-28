#!/usr/bin/env bash
# Run Rust type-check + clippy lint on the Tauri crate.
# Use after every fix to catch compile-time errors (E0282, E0061, deprecated v1 APIs, etc.)
# before invoking `tauri build`.

set -euo pipefail

# cargo lives under CARGO_HOME (default `~/.cargo`). A Windows bash often has
# no HOME (and no PATH entry pointing at the toolchain), so probe the usual
# roots instead of trusting one of them.
CARGO_BIN="${CARGO_HOME:-${HOME:-$USERPROFILE}/.cargo}/bin"
if [ -d "$CARGO_BIN" ]; then
  export PATH="$CARGO_BIN:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/../src-tauri/Cargo.toml"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found in PATH (looked under $CARGO_BIN)" >&2
  exit 127
fi

# Windows: Git ships a coreutils `link`, which shadows MSVC's linker and makes
# cargo fail with a baffling "link: extra operand ..." instead of building.
# The workaround is a VS Developer Shell (vcvars64.bat); say so before cargo
# fails, because the error names the wrong program.
if link --version 2>&1 | grep -qi "GNU coreutils"; then
  echo "warning: coreutils 'link' shadows MSVC link.exe — run this from a VS Developer Shell" >&2
fi

echo "==> cargo check (all targets)"
cargo check --manifest-path "$MANIFEST" --all-targets

echo "==> cargo clippy (warnings as errors)"
cargo clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings

if cargo fmt --version >/dev/null 2>&1; then
  echo "==> cargo fmt --check (advisory)"
  if ! cargo fmt --manifest-path "$MANIFEST" --check >/dev/null 2>&1; then
    echo "    formatting drift detected; run 'cargo fmt --manifest-path $MANIFEST' to fix"
  fi
fi

echo "==> all rust checks passed"
