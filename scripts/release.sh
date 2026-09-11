#!/usr/bin/env bash
# Build a release tarball and fill in the Homebrew formula from it.
#
# Publishes nothing. It produces the artifact and tells you what is still
# missing, because shipkit has no remote yet and Homebrew installs from a URL.
#
#   scripts/release.sh [repository-url]
#
# The repository url is optional: it is read from `git remote get-url origin`
# when one exists, and left as a named placeholder when it does not.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FORMULA="packaging/homebrew/shipkit.rb"
DIST="dist-release"

fail() { printf '\nrelease: %s\n' "$1" >&2; exit 1; }

# A release built from a dirty tree is a release nobody can reproduce. The
# formula is excluded because this script writes it: `npm pack` embeds
# timestamps, so every run yields a different checksum, and a script blocked by
# its own output is a script you run with --force until the check means nothing.
DIRTY="$(git status --porcelain -- . ":(exclude)$FORMULA")"
[ -z "$DIRTY" ] || {
  printf '%s\n' "$DIRTY" >&2
  fail "working tree is not clean — commit or stash first"
}

VERSION="$(node -p "require('./package.json').version")"
[ -n "$VERSION" ] || fail "could not read version from package.json"

echo "release: shipkit $VERSION"
echo "release: running the suite"
rm -rf dist
# Quiet on success, complete on failure. A release script that buries the one
# output you need is a release script you stop trusting.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
npm test >"$LOG" 2>&1 || { cat "$LOG" >&2; fail "the test suite failed"; }
npm run check >"$LOG" 2>&1 || { cat "$LOG" >&2; fail "tsc reported type errors"; }

echo "release: packing"
rm -rf "$DIST"
mkdir -p "$DIST"
TARBALL="$(cd "$DIST" && npm pack "$ROOT" --silent)"
[ -f "$DIST/$TARBALL" ] || fail "npm pack produced no tarball"

SHA="$(shasum -a 256 "$DIST/$TARBALL" | cut -d' ' -f1)"

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  REPO_URL="$(git remote get-url origin 2>/dev/null || true)"
fi

if [ -n "$REPO_URL" ]; then
  BASE="${REPO_URL%.git}"
  TARBALL_URL="$BASE/releases/download/v$VERSION/$TARBALL"
else
  # Named, not guessed. A formula carrying a plausible-looking wrong URL is
  # worse than one that says out loud it is unfinished.
  BASE="REPLACE_WITH_REPOSITORY_URL"
  TARBALL_URL="REPLACE_WITH_TARBALL_URL"
fi

# Rewrite in place. Each field is matched on its own line so a rerun replaces
# the previous value rather than appending to it.
perl -pi -e "s|^  homepage \".*\"|  homepage \"$BASE\"|" "$FORMULA"
perl -pi -e "s|^  url \".*\"|  url \"$TARBALL_URL\"|" "$FORMULA"
perl -pi -e "s|^  sha256 \".*\"|  sha256 \"$SHA\"|" "$FORMULA"

echo
echo "  tarball  $DIST/$TARBALL"
echo "  sha256   $SHA"
echo "  formula  $FORMULA"
echo

if [ -n "$REPO_URL" ]; then
  cat <<EOF
Next, in order:

  1. git tag v$VERSION && git push origin v$VERSION
  2. Attach $DIST/$TARBALL to the v$VERSION release at
     $BASE/releases
  3. Copy $FORMULA into your tap repository
     (a repository named homebrew-<tap>), commit and push.
  4. brew install <owner>/<tap>/shipkit
EOF
else
  cat <<EOF
The formula's sha256 is filled in; its url is not, because this repository has
no remote. Nothing can install from it yet.

When the repository is published:

  1. git remote add origin <url>
  2. scripts/release.sh          (re-run; it reads the url from the remote)
  3. Follow the steps it prints.

Signing for the menu-bar cask is not wired in yet. When it is, it belongs
between packing and the checksum — see packaging/README.md.
EOF
fi
