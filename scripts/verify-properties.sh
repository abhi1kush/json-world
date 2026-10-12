#!/usr/bin/env bash
# Checks the WASM .properties writer/reader against the real java.util.Properties (needs JDK + node).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-/tmp/json-world-props}"
rm -rf "$OUT" && mkdir -p "$OUT/classes"
javac -d "$OUT/classes" scripts/properties-verify/LoadProps.java
node scripts/properties-verify/verify.mjs "$OUT" "$OUT/classes"
