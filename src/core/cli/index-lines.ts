// What `signpost index` says while it works, and when it is done.
//
// Here rather than in the command for the reason ./verbose.ts and
// ./index-exit-code.ts are: the command does the IO — probe the cache, open
// the database, sync the corpus — and the wording is a decision over what that
// found. PURE.
//
// The command said nothing at all until this existed. On a machine that has
// never embedded anything, the first `signpost index` downloads the model
// before it can index a line, and a user watching an empty terminal for that
// has no way to tell a download from a hang. `doctor` already warns about the
// same download; this is the same fact, said at the moment it is being paid
// for, to whoever did not run `doctor` first.

import type { ModelCacheStatus } from "../doctor/report.ts";

/**
 * Printed once the work is known to be necessary — never before.
 *
 * The index is rebuilt only when the corpus moved, so most invocations do
 * nothing and must say nothing: a line promising a download on every run would
 * be wrong far more often than right. src/io/db/vector-index.ts is what knows,
 * and calls back to this at the point it commits to the work.
 */
export function indexStartedLine(cache: ModelCacheStatus): string {
  const rebuilding = "rebuilding the index";
  // Only `cold` means a download is about to happen. `vendored` reads the
  // model from a local path, `warm` has it cached already, and `unavailable`
  // is about to fail rather than fetch — promising a download in any of those
  // three is the misdiagnosis src/core/doctor/report.ts spells out.
  return cache === "cold"
    ? `${rebuilding} — downloading the embedding model first (~23MB, once per machine)`
    : rebuilding;
}

/**
 * The closing line, including for the run that found nothing to do.
 *
 * `rebuilt` is the honest half: claiming to have indexed on an invocation that
 * skipped the rebuild describes work that did not happen, and the count alone
 * cannot tell the two apart — an unchanged corpus has exactly the same number
 * of signposts in it as the rebuild that last read it.
 */
export function indexFinishedLine(indexed: number, rebuilt: boolean): string {
  const corpus = `${String(indexed)} signpost${indexed === 1 ? "" : "s"}`;
  return rebuilt ? `indexed ${corpus}` : `index already up to date (${corpus})`;
}

/**
 * What `runWorker` records as `lastError` when the rebuild skipped one or
 * more corpus files — the fix for a real repo's `signpost index` reporting
 * only "index rebuild exited 1" while the file and the reason went to the
 * worker's `/dev/null` stderr (CLAUDE.md, "The SessionStart hook and its
 * worker"; 19-value-to-a-user.md open items).
 *
 * Named the first failure and counted the rest, rather than concatenating
 * every line `syncCorpus` produced: the statusLine renders this verbatim in
 * one row on every assistant message, so it has to stay short regardless of
 * how many files the corpus has wrong.
 *
 * Callers only ever pass a non-empty list — `runWorker` checks that before
 * calling — but the type is `readonly string[]`, so an empty one still
 * answers honestly rather than throwing.
 */
export function corpusFailureSummary(failures: readonly string[]): string {
  const first = failures[0];
  if (first === undefined) {
    return "";
  }
  const rest = failures.length - 1;
  return rest === 0 ? first : `${first} (+${rest} more)`;
}
