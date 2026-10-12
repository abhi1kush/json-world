#!/usr/bin/env bash
# Build and force-push dist/ to the gh-pages branch (branch-based GitHub Pages).
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE_URL="$(git remote get-url origin)"
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
