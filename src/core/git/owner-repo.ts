// Pure parsing: `git remote get-url origin`'s output -> the `"owner/name"`
// string used as the `repo` key across repo_state/signposts (12-wire-
// contracts.md). Handles both the SSH (`git@host:owner/name.git`) and
// HTTPS (`https://host/owner/name.git`) forms git remotes come in; the
// actual subprocess call lives in ../../io/git/remote-origin.ts (this is
// decision logic — string in, string or null out — so no filesystem, no
// subprocess).

import path from "node:path";

const SSH_REMOTE = /^[\w.-]+@[^:]+:(?<path>.+)$/;
const HTTP_REMOTE = /^https?:\/\/[^/]+\/(?<path>.+)$/;

/** `remoteUrl` as returned by `git remote get-url origin`; `null` when it isn't a recognised owner/name form. */
export function deriveOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = SSH_REMOTE.exec(trimmed) ?? HTTP_REMOTE.exec(trimmed);
  const rawPath = match?.groups?.["path"];
  if (rawPath === undefined) {
    return null;
  }

  const segments = rawPath
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  // Reversed so owner/name are the last two path segments regardless of
  // how many precede them (e.g. a self-hosted host under a sub-path).
  const [name, owner] = [...segments].reverse();
  if (owner === undefined) {
    return null;
  }

  // `name` is guaranteed defined here: a reversed array only has index 1
  // (owner) filled when index 0 (name) is too.
  return `${owner}/${name!}`;
}

/** The owner half of the key a repo with no `owner/name` origin is filed under. */
const LOCAL_OWNER = "local";

/**
 * `local/<directory name>`: the key for a repo whose origin yields no
 * `owner/name`, which only personal storage accepts, since nothing it does
 * leaves the machine. It need not be unique: the state directory, and with it
 * the database and the store, is already per checkout (sha256 of repoRoot).
 */
export function localRepoKey(repoRoot: string): string {
  return `${LOCAL_OWNER}/${path.basename(repoRoot)}`;
}
