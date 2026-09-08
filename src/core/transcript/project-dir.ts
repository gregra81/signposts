// Claude Code stores one directory of transcripts per project, named after
// the project's absolute path with every character that is not a letter or a
// digit replaced by a dash:
// `/Users/greg/Projects/signposts` -> `-Users-greg-Projects-signposts`.
//
// It is every non-alphanumeric character, not only the separators. Verified
// against a real install: `/Users/greg/.buzz` is stored as
// `-Users-greg--buzz`, so the leading dot of a dotfile repo becomes a dash
// like a slash does. Matching only separators sent `discoverSessions` to a
// directory that does not exist for any repo holding a `.`, a `_` or a space
// in its path, and the ENOENT branch there reports that as an empty session
// list — the tool looked healthy and found nothing, with no way to tell.
//
// Pure, and deliberately one-way. The encoding is lossy — a path that already
// contains a dash encodes to the same name as one with a separator there — so
// signposts encodes the repo root it was given and looks for that directory,
// rather than decoding directory names and guessing which repo each belongs
// to.

/** Anything that is not part of the encoded name. */
const NON_NAME = /[^a-zA-Z0-9]/g;

export function projectDirName(repoRoot: string): string {
  return repoRoot.replace(/\/+$/, "").replace(NON_NAME, "-");
}
