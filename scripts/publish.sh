#!/usr/bin/env bash
# publish.sh — publish the @autenai/sdk npm package.
#
# Run from /root/auten. Refuses to publish if:
#   • npm is not logged in (or NPM_TOKEN not set)
#   • the version in package.json is not greater than the latest on npm
#   • typecheck or build fails
#   • a stray .npmrc with a token would be packaged
#
# After publish: tags the git commit with the version, prints install command.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "→ publishing SDK from $ROOT"

# 1. Read local version.
LOCAL_VERSION="$(node -p "require('./package.json').version")"
PKG_NAME="$(node -p "require('./package.json').name")"
echo "  package: $PKG_NAME@$LOCAL_VERSION"

# 2. Resolve auth. Prefer NPM_TOKEN env (CI-friendly); fall back to npm whoami.
if [ -n "${NPM_TOKEN:-}" ]; then
  TMPRC="$(mktemp)"
  trap 'rm -f "$TMPRC"' EXIT
  echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > "$TMPRC"
  chmod 600 "$TMPRC"
  NPM="npm --userconfig=$TMPRC"
else
  NPM="npm"
fi

WHO="$($NPM whoami 2>/dev/null || true)"
if [ -z "$WHO" ]; then
  echo "  ✗ not logged in. Run \`npm login\` or set NPM_TOKEN."
  exit 1
fi
echo "  ✓ npm user: $WHO"

# 3. Compare against published version.
LATEST="$($NPM view "$PKG_NAME" version 2>/dev/null || echo 0.0.0)"
echo "  npm latest: $LATEST"
if ! node -e "
  const semver = (s) => s.split('.').map(Number);
  const [a,b,c] = semver(process.argv[1]);
  const [x,y,z] = semver(process.argv[2]);
  if (a>x || (a===x && b>y) || (a===x && b===y && c>z)) process.exit(0);
  process.exit(1);
" "$LOCAL_VERSION" "$LATEST"; then
  echo "  ✗ local version $LOCAL_VERSION is not greater than published $LATEST."
  echo "    Bump the version in package.json before publishing."
  exit 1
fi
echo "  ✓ version check"

# 4. Typecheck + clean build.
echo "→ typecheck..."
npx tsc --noEmit
echo "  ✓ typecheck"

rm -rf dist
npx tsc
echo "  ✓ build"

# 5. Refuse to package secrets.
if grep -q "_authToken" .npmrc 2>/dev/null; then
  if ! grep -q "^.npmrc$" .gitignore 2>/dev/null && ! grep -q "^\.npmrc$" .npmignore 2>/dev/null; then
    echo "  ✗ .npmrc contains a token but is not in .gitignore/.npmignore."
    echo "    Add it before publishing — refusing to leak credentials."
    exit 1
  fi
fi

# 6. Show what will be published.
echo "→ pack preview..."
$NPM pack --dry-run 2>&1 | tail -8

# 7. Confirm before destructive action.
if [ "${PUBLISH_YES:-0}" != "1" ]; then
  read -r -p "Publish $PKG_NAME@$LOCAL_VERSION as latest? [y/N] " ANS
  if [ "$ANS" != "y" ] && [ "$ANS" != "Y" ]; then
    echo "  aborted."
    exit 1
  fi
fi

# 8. Publish. --access public matters for scoped packages.
$NPM publish --access public
echo "  ✓ published"

# 9. Tag git.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git add -A
  if ! git diff --cached --quiet; then
    git -c user.email=root@auten -c user.name=root commit -qm "release: $PKG_NAME@$LOCAL_VERSION"
  fi
  git tag -a "v$LOCAL_VERSION" -m "release $LOCAL_VERSION" 2>/dev/null || true
fi

# 10. Verify the registry sees it.
sleep 2
NEW_LATEST="$($NPM view "$PKG_NAME" version 2>/dev/null || echo "?")"
echo ""
echo "✓ $PKG_NAME@$LOCAL_VERSION live on npm (registry latest: $NEW_LATEST)"
echo "  install: npm install $PKG_NAME"
