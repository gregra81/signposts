#!/usr/bin/env bash
#
# docs/install.sh, run against a local release (19-value-to-a-user.md, Phase 6).
#
#   bash test/install/install.test.sh [dir-holding-the-tgz]
#
# With no argument it runs `pnpm pack` itself. The release workflow passes the
# directory its pack step filled, so what is tested is what gets published.
#
# Shell, and outside vitest, because packing runs `prepack`: that writes dist/
# and hooks/session-start.js into the checkout, and bin/signpost.js switches to
# dist/ the moment it appears — under a suite of tests spawning it in parallel.
#
# Three seams, each narrower than the thing it replaces:
#
# - The download base. The installer is copied and its one GitHub URL is
#   rewritten to file://, which curl reads like any other. The substitution is
#   checked to have matched, so moving that line fails here, loudly.
# - npm. A real `npm install -g` fetches better-sqlite3 and onnxruntime-node
#   over the network. The stub unpacks the real tarball into a prefix and links
#   the `bin` entries its package.json declares — which is the part that can be
#   wrong in this repo, and was, in v0.1.0.
# - PATH. Built from scratch: /usr/bin, /bin, and node linked in on its own.
#   Node's own bin directory is not on it, because on a developer's machine that
#   is where an existing `signpost` lives, and `claude` must be absent.
#
# The network is not denied, it is made unreachable: every proxy variable
# points at a closed port, so any https call the script makes fails.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="$ROOT/docs/install.sh"
URL_LINE='base="https://github.com/$REPO/releases/download/$tag"'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
pass() { printf 'ok   %s\n' "$1"; }

# --- the release ------------------------------------------------------------

release="$work/release"
mkdir -p "$release"
if [ $# -gt 0 ]; then
  cp "$1"/signposts-*.tgz "$release/"
  [ ! -f "$1/SHA256SUMS" ] || cp "$1/SHA256SUMS" "$release/"
else
  (cd "$ROOT" && pnpm pack --pack-destination "$release" >/dev/null)
fi
tarball="$(cd "$release" && ls signposts-*.tgz)"
version="${tarball#signposts-}"
version="${version%.tgz}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# --- the sandbox, rebuilt per case -------------------------------------------

setup_case() {
  case_dir="$work/$1"
  mkdir -p "$case_dir/home" "$case_dir/stub" "$case_dir/prefix/bin" "$case_dir/release"
  cp "$release/$tarball" "$case_dir/release/"
  # The release's own SHA256SUMS when there is one: its format is what broke
  # the installer on the first release, so a generated one would test less.
  if [ -f "$release/SHA256SUMS" ]; then
    cp "$release/SHA256SUMS" "$case_dir/release/"
  else
    printf '%s  %s\n' "$(sha256_of "$case_dir/release/$tarball")" "$tarball" >"$case_dir/release/SHA256SUMS"
  fi

  [ "$(grep -cF "$URL_LINE" "$INSTALLER")" = 1 ] || {
    printf 'the download URL line moved in docs/install.sh; update URL_LINE here\n' >&2
    exit 1
  }
  # A literal replacement, not sed: the line is full of `$` and `/`.
  local rewritten="base=\"file://$case_dir/release\""
  awk -v from="$URL_LINE" -v to="$rewritten" '{ if (index($0, from)) { i = index($0, from); $0 = substr($0, 1, i - 1) to substr($0, i + length(from)) } print }' \
    "$INSTALLER" >"$case_dir/install.sh"

  ln -s "$(command -v node)" "$case_dir/stub/node"
  cat >"$case_dir/stub/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$NPM_LOG"
[ "$1" = install ] || exit 0
tgz="${*: -1}"
dest="$NPM_PREFIX/lib/node_modules/signposts"
mkdir -p "$dest"
tar -xzf "$tgz" -C "$dest" --strip-components=1
node -e '
  const fs = require("fs"), path = require("path");
  const [dest, bin] = process.argv.slice(1);
  for (const [name, file] of Object.entries(require(path.join(dest, "package.json")).bin)) {
    const target = path.join(dest, file);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(bin, name));
  }
' "$dest" "$NPM_PREFIX/bin"
STUB
  chmod +x "$case_dir/stub/npm"
}

run_installer() {
  local dead="http://127.0.0.1:9"
  env -i \
    HOME="$case_dir/home" \
    PATH="$case_dir/prefix/bin:$case_dir/stub:/usr/bin:/bin" \
    NPM_LOG="$case_dir/npm.log" NPM_PREFIX="$case_dir/prefix" \
    SIGNPOSTS_VERSION="$version" \
    http_proxy="$dead" https_proxy="$dead" HTTP_PROXY="$dead" HTTPS_PROXY="$dead" ALL_PROXY="$dead" \
    bash "$case_dir/install.sh" >"$case_dir/out" 2>&1
}

in_sandbox() {
  env -i HOME="$case_dir/home" PATH="$case_dir/prefix/bin:$case_dir/stub:/usr/bin:/bin" bash -c "$1"
}

# --- a clean install, with no claude on PATH ---------------------------------

setup_case clean
in_sandbox 'command -v claude' >/dev/null && fail "precondition: claude is on the sandbox PATH"
in_sandbox 'command -v signpost' >/dev/null && fail "precondition: signpost is on the sandbox PATH before install"

status=0
run_installer || status=$?
[ "$status" = 0 ] && pass "installs and exits 0" || { fail "installer exited $status"; cat "$case_dir/out" >&2; }

for bin in signpost signpost-session-start; do
  resolved="$(in_sandbox "command -v $bin" || true)"
  [ "$resolved" = "$case_dir/prefix/bin/$bin" ] && pass "$bin is on PATH" || fail "$bin is not on PATH (got '$resolved')"
done

# The hook bundle has no dependencies, so it is the one binary that can run
# without node_modules. Outside a git repo it must exit 0 and print nothing.
mkdir -p "$case_dir/not-a-repo"
hook_out="$(cd "$case_dir/not-a-repo" && in_sandbox 'signpost-session-start' 2>&1)" && [ -z "$hook_out" ] &&
  pass "the shipped hook runs" || fail "the shipped hook failed: $hook_out"

grep -qF "/plugin marketplace add gregra81/signposts" "$case_dir/out" &&
  grep -qF "/plugin install signposts@signposts" "$case_dir/out" &&
  pass "prints both /plugin commands when claude is missing" ||
  fail "the missing-claude fallback did not print both /plugin commands"

# --- a corrupted SHA256SUMS ----------------------------------------------------

setup_case corrupt
printf '%064d  %s\n' 0 "$tarball" >"$case_dir/release/SHA256SUMS"

status=0
run_installer || status=$?
[ "$status" != 0 ] && pass "a bad checksum exits non-zero" || fail "a bad checksum exited 0"
grep -qF "checksum mismatch" "$case_dir/out" && pass "and says why" || { fail "no checksum message"; cat "$case_dir/out" >&2; }
[ ! -e "$case_dir/npm.log" ] && pass "and npm never ran" || fail "npm ran after a checksum mismatch: $(cat "$case_dir/npm.log")"

# ------------------------------------------------------------------------------

[ "$failures" = 0 ] || { printf '%d failed\n' "$failures" >&2; exit 1; }
