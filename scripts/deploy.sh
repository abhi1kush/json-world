#!/usr/bin/env bash
# Build and force-push dist/ to the gh-pages branch (branch-based GitHub Pages).
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE_URL="$(git remote get-url origin)"
# Rebuild the Rust/WASM converter when the toolchain is available; otherwise use the committed converter/pkg.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if command -v wasm-pack >/dev/null 2>&1; then npm run build:wasm; else echo "wasm-pack not found: using committed converter/pkg"; fi
npm run build
touch dist/.nojekyll
TMP="$(mktemp -d)"
cp -r dist/. "$TMP"
cd "$TMP"
git init -q -b gh-pages
git config user.name "$(git -C "$OLDPWD" config user.name || echo deploy)"
git config user.email "$(git -C "$OLDPWD" config user.email || echo deploy@localhost)"
git add -A
git commit -qm "Deploy $(git -C "$OLDPWD" rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -f "$REMOTE_URL" gh-pages:gh-pages
cd - >/dev/null
rm -rf "$TMP"
echo "Deployed to gh-pages."
