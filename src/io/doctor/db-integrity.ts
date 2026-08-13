// DB integrity check (R5): `PRAGMA integrity_check` against the real
// per-repo SQLite file, or "no database yet" if it doesn't exist.
// src/core/doctor/report.ts's classifyDbIntegrity turns the raw pragma
// text into a status; this module only gathers it.

import { existsSync } from "node:fs";
import { openDb } from "../db/migrate.ts";
import { classifyDbIntegrity, type DbIntegrityStatus } from "../../core/doctor/report.ts";

export function checkDbIntegrity(dbPath: string): DbIntegrityStatus {
  if (!existsSync(dbPath)) {
    return classifyDbIntegrity(false, undefined);
  }

  let db;
  try {
    db = openDb(dbPath);
  } catch {
    // openDb() migrates on open, so a file that exists but isn't a valid
    // SQLite db (truncated, corrupted) throws before we ever run our own
    // pragma — that's the same "corrupt" story a failed integrity_check
    // would tell, not a crash doctor should surface as one.
    return classifyDbIntegrity(true, undefined);
  }

  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return classifyDbIntegrity(true, row.integrity_check);
  } finally {
    db.close();
  }
}
