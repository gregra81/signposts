// Whether this repo has already consented (R3) — the one read shared by the
// command that asks (`init`) and the gate that refuses without it
// (src/cli/consent.ts).
//
// It deliberately does not open a database that isn't there. `openDb` creates
// and migrates the file, so probing consent with it would leave state behind
// in a repo that has never consented — which is exactly what a decline must
// not do, and what `doctor` reports on. An absent file is an absent consent.

import { existsSync } from "node:fs";
import { openDb } from "../db/migrate.ts";
import { hasConsented } from "../db/repo-state.ts";
import { isConsented } from "../../core/init/policy.ts";

/** Throws when the database exists but cannot be opened or read — the caller decides what to say. */
export function readConsent(dbPath: string, repo: string): boolean {
  const dbFileExists = existsSync(dbPath);
  if (!dbFileExists) {
    return isConsented(false, false);
  }

  const db = openDb(dbPath);
  try {
    return isConsented(true, hasConsented(db, repo));
  } finally {
    db.close();
  }
}
