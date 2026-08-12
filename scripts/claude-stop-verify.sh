#!/usr/bin/env bash
# Stop hook: gate turn-end on typecheck/lint/unit-test when src/ changed.
# Exit 0 = allow stop. Exit 2 = block stop, stderr fed back to Claude.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v pnpm >/dev/null 2>&1; then
  node_version="$(cat .nvmrc 2>/dev/null | tr -d '[:space:]')"
  nvm_bin="$(ls -d "$HOME/.nvm/versions/node/v${node_version}"* 2>/dev/null | head -n1)/bin"
  [ -d "$nvm_bin" ] && export PATH="$nvm_bin:$PATH"
fi

if [ -z "$(git status --porcelain -- src/ 2>/dev/null)" ]; then
  exit 0
fi

output=$(pnpm run typecheck && pnpm run lint && pnpm run test:unit 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  echo "src/ changed but verification failed — fix before stopping:" >&2
  echo "$output" >&2
  exit 2
fi

exit 0
