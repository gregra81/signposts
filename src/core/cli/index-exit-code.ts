// Decision logic for `signpost index`'s exit code: a per-file parse
// failure must not abort the command (successfully parsed files still get
// mirrored/indexed/written), but the run as a whole must report failure.

/** Any file failed to parse -> 1; all files parsed -> 0. */
export function indexExitCode(anyFileFailed: boolean): 0 | 1 {
  return anyFileFailed ? 1 : 0;
}
