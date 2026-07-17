#!/usr/bin/env bash
# Build the Rust WASM kernels and copy the artifact into src/wasm/.
# Requires: rustup + `rustup target add wasm32-unknown-unknown`.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
crate="$here/crates/camera_coverage_wasm"
cargo build --release --target wasm32-unknown-unknown --manifest-path "$crate/Cargo.toml"
cp "$crate/target/wasm32-unknown-unknown/release/camera_coverage_wasm.wasm" "$here/src/wasm/camera_coverage_wasm.wasm"
echo "wasm → src/wasm/camera_coverage_wasm.wasm ($(wc -c < "$here/src/wasm/camera_coverage_wasm.wasm") bytes)"
