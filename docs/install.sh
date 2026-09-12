#!/usr/bin/env bash
#
# signposts installer.
#
#   curl -fsSL https://gregra81.github.io/signposts/install.sh | bash
#
# Downloads the tarball from the GitHub release, checks it against the
# SHA256SUMS published beside it, and installs it globally with npm.
#
# Then it installs the Claude Code plugin, which is what carries the
# session-start hook, the /signposts commands and the search server. Doing that
# by hand was two commands typed inside Claude Code that nothing verified, and
# the CLI alone leaves a user with no hook, no commands and no read path.
#
# What it does not do is `signpost init`. That asks for consent on stdin, and
# stdin here is the script itself coming down the pipe — a consent prompt that
# cannot be answered is worse than one the user types deliberately, so the
# install ends by telling them to run it.
#
# Environment:
#   SIGNPOSTS_VERSION       a release to pin, e.g. 0.1.0 or v0.1.0 (default: latest)
#   SIGNPOSTS_SKIP_PLUGIN   set to anything to install the CLI only

set -euo pipefail

REPO="gregra81/signposts"
# `<plugin>@<marketplace>`, both declared in .claude-plugin/marketplace.json.
PLUGIN="signposts@signposts"
NODE_MIN_MAJOR=24
REQUESTED="${SIGNPOSTS_VERSION:-latest}"

# Script-scoped, not local to main(): the EXIT trap below runs after main has
# returned, and a `local` is out of scope by then — which under `set -u` made
# the cleanup itself the last thing a successful install printed, and left the
# directory on disk.
tmp=""

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

  local tag version tarball base expected actual
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

  # The name in a sha256sum line comes in three shapes: bare, `*`-prefixed
  # (binary mode), and `./`-prefixed (whatever glob produced it). Normalise
  # before comparing — matching only the bare form made this script reject the
  # first release it was ever pointed at.
  expected="$(awk -v file="$tarball" '{ name = $2; sub(/^\*/, "", name); sub(/^\.\//, "", name); if (name == file) print $1 }' "$tmp/SHA256SUMS" | head -1)"
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

  install_plugin

  cat <<'NEXT'

signposts is installed. Next, in a repo you work in:

  signpost init      asks once, then writes .signposts/, the CLAUDE.md pointer and the skill
  signpost doctor    checks this machine if anything looks wrong

Then ask Claude to run signposts. Restart any Claude Code session that was already
open, so it picks the plugin up. The full picture: https://github.com/gregra81/signposts
NEXT
}

# The plugin half: the SessionStart hook, the /signposts commands and the
# search_signposts server. Both commands are idempotent and exit 0 when the
# marketplace or the plugin is already there, so re-running the installer is
# safe.
#
# A failure here never fails the install. The CLI is on disk and useful without
# the plugin; what a person needs in that case is the two commands to type, not
# a non-zero exit on an install that mostly worked.
install_plugin() {
  if [ -n "${SIGNPOSTS_SKIP_PLUGIN:-}" ]; then
    say "skipping the Claude Code plugin (SIGNPOSTS_SKIP_PLUGIN is set)."
    return
  fi

  if ! have claude; then
    say "the Claude Code CLI is not on PATH, so the plugin was not installed."
    plugin_by_hand
    return
  fi

  say "installing the Claude Code plugin"
  local output
  if ! output="$(claude plugin marketplace add "$REPO" 2>&1)" ||
    ! output="$(claude plugin install "$PLUGIN" --scope user --yes 2>&1)"; then
    say "the plugin did not install: ${output}"
    plugin_by_hand
  fi
}

plugin_by_hand() {
  cat <<NEXT

Inside Claude Code, run these two to finish:

  /plugin marketplace add $REPO
  /plugin install $PLUGIN
NEXT
}

main "$@"
