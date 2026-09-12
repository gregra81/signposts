#!/usr/bin/env bash
#
# signposts installer.
#
#   curl -fsSL https://gregra81.github.io/signposts/install.sh | bash
#
# Downloads the tarball from the GitHub release, checks it against the
# SHA256SUMS published beside it, and installs it globally with npm.
#
# It installs and stops there. `signpost init` asks for consent on stdin, and
# stdin here is the script itself coming down the pipe — a consent prompt that
# cannot be answered is worse than one the user types deliberately, so the
# install ends by telling them to run it.
#
# Environment:
#   SIGNPOSTS_VERSION   a release to pin, e.g. 0.1.0 or v0.1.0 (default: latest)

set -euo pipefail

REPO="gregra81/signposts"
NODE_MIN_MAJOR=24
REQUESTED="${SIGNPOSTS_VERSION:-latest}"

say() { printf 'signposts: %s\n' "$1"; }
die() { printf 'signposts: %s\n' "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Node is a hard floor rather than a warning: the package ships type-stripped
# TypeScript that older runtimes cannot parse, so a too-old node fails at the
# first import with a syntax error naming a file the user did not write.
require_node() {
  have node || die "node $NODE_MIN_MAJOR or newer is required and was not found. Install it from https://nodejs.org, or with nvm (nvm install $NODE_MIN_MAJOR) or Homebrew (brew install node)."
  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
    die "node $NODE_MIN_MAJOR or newer is required, found $(node --version). Upgrade with nvm (nvm install $NODE_MIN_MAJOR) or Homebrew (brew upgrade node)."
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "no sha256 tool found (sha256sum or shasum), so the download cannot be verified."
  fi
}

# The release tag, resolved from the GitHub API unless one was pinned. Parsed
# with sed rather than jq, which most machines do not have.
resolve_tag() {
  if [ "$REQUESTED" != "latest" ]; then
    case "$REQUESTED" in
      v*) printf '%s' "$REQUESTED" ;;
      *) printf 'v%s' "$REQUESTED" ;;
    esac
    return
  fi

  local tag
  # No -S: a 404 here is an ordinary answer (no release yet, or rate-limited),
  # and curl's own error line on top of ours explains nothing a user can act on.
  tag="$(curl -fsL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$tag" ] || die "could not find the latest release of $REPO. Either there is none yet, or GitHub rate-limited this call (60 an hour per address). Pin a version to skip the lookup: SIGNPOSTS_VERSION=0.1.0"
  printf '%s' "$tag"
}

main() {
  have curl || die "curl is required and was not found."
  have npm || die "npm is required and was not found — it ships with node."
  require_node

  local tag version tmp tarball base expected actual
  tag="$(resolve_tag)"
  version="${tag#v}"
  tarball="signposts-$version.tgz"
  base="https://github.com/$REPO/releases/download/$tag"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "downloading signposts $version"
  curl -fsSL -o "$tmp/$tarball" "$base/$tarball" ||
    die "could not download $base/$tarball — is $tag a released version?"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    die "could not download the checksums for $tag, so the tarball cannot be verified."

  expected="$(awk -v file="$tarball" '$2 == file || $2 == "*" file { print $1 }' "$tmp/SHA256SUMS" | head -1)"
  [ -n "$expected" ] || die "$tarball is not listed in the release's SHA256SUMS."
  actual="$(sha256_of "$tmp/$tarball")"
  [ "$expected" = "$actual" ] ||
    die "checksum mismatch for $tarball (expected $expected, got $actual). Nothing was installed."

  say "installing globally with npm"
  # `better-sqlite3` and `onnxruntime-node` are native: npm fetches a prebuilt
  # binary for this platform here, which is why this step is not instant.
  if ! npm install -g --loglevel=error "$tmp/$tarball"; then
    die "npm could not install the package. If that was a permissions error, either point npm's global prefix somewhere you own (npm config set prefix ~/.npm-global) or re-run this with sudo."
  fi

  if ! have signpost; then
    say "installed, but 'signpost' is not on your PATH — add \"\$(npm prefix -g)/bin\" to it."
    exit 0
  fi

  cat <<'NEXT'

signposts is installed. Next, in a repo you work in:

  signpost init      asks once, then writes .signposts/, the CLAUDE.md pointer and the skill
  signpost doctor    checks this machine if anything looks wrong

Then ask Claude to run signposts. The full picture: https://github.com/gregra81/signposts
NEXT
}

main "$@"
