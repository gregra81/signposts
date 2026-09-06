// Claude Code stores one directory of transcripts per project, named after
// the project's absolute path with every separator replaced by a dash:
// `/Users/greg/Projects/signposts` -> `-Users-greg-Projects-signposts`.
//
// Pure, and deliberately one-way. The encoding is lossy — a path that already
// contains a dash encodes to the same name as one with a separator there — so
// signposts encodes the repo root it was given and looks for that directory,
// rather than decoding directory names and guessing which repo each belongs
// to.

/** Anything that is not part of the encoded name: separators, drive colons. */
const NON_NAME = /[/\\:]/g;

export function projectDirName(repoRoot: string): string {
  return repoRoot.replace(/\/+$/, "").replace(NON_NAME, "-");
}
