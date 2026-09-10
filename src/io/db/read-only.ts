// Opening the per-repo database for a reader (05-retrieval.md, "The MCP
// server on a cold clone").
//
// `openDb` (./migrate.ts) creates the file and migrates it. Neither is a
// reader's to do: the MCP server answers a question inside a Claude turn, in a
// checkout that may never have consented (R3), and a search that creates a
// database is a search that writes state on behalf of someone who only asked
// what the repo knows. So this opens read-only, refuses to create, and reports
// "no" rather than throwing for every reason it might fail — a missing file, a
// corrupt one, a schema that is not the one this build reads (older, or
// written by a newer install).
//
// The sqlite-vec extension still has to be loaded into this connection before
// `signpost_vec` can be queried, exactly as ./migrate.ts documents: the vec0
// module is per-connection, not a property of the file.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_VERSION, readUserVersion } from "./migrate.ts";

/**
 * The database at `dbPath`, or `null` when there is nothing this build can
 * read there. Never creates, never migrates, never throws.
 */
export function openReadOnlyDb(dbPath: string): Database.Database | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null; // No file yet: the cold clone, before the first index build.
  }

  try {
    sqliteVec.load(db);
    if (readUserVersion(db) !== SCHEMA_VERSION) {
      db.close();
      return null;
    }
    return db;
  } catch {
    // Corrupt, not SQLite at all, or an extension that will not load here.
    db.close();
    return null;
  }
}
