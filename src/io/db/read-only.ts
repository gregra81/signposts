// Opening the per-repo database for a reader (05-retrieval.md, "The MCP
// server on a cold clone").
//
// `openDb` (./migrate.ts) creates the file and migrates it. Neither is a
// reader's to do: the MCP server answers a question inside a Claude turn, in a
// checkout that may never have consented (R3), and a search that creates a
// database is a search that writes state on behalf of someone who only asked
// what the repo knows. So this opens read-only, refuses to create, and reports
// rather than throws.
//
// **It reports which failure it was.** An absent file and a database this
// build cannot read are different things to say — "no index has been built
// here yet, which is expected on a fresh clone" is true of the first and
// misleading about the second, where the honest answer names the schema. A
// single `null` for both collapsed them into the friendlier wrong one.
//
// The sqlite-vec extension still has to be loaded into this connection before
// `signpost_vec` can be queried, exactly as ./migrate.ts documents: the vec0
// module is per-connection, not a property of the file.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_VERSION, readUserVersion } from "./migrate.ts";

export type OpenedReadOnlyDb =
  | { status: "open"; db: Database.Database }
  /** No file. Nothing has run in this checkout — the cold clone. */
  | { status: "missing" }
  /** A file this build cannot read: corrupt, not SQLite, or another schema version. */
  | { status: "unreadable" };

/** Never creates, never migrates, never throws. */
export function openReadOnlyDb(dbPath: string): OpenedReadOnlyDb {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return { status: "missing" };
  }

  try {
    sqliteVec.load(db);
    // A schema older than this build, or written by a newer install: either
    // way the queries below it were written against a different shape.
    if (readUserVersion(db) !== SCHEMA_VERSION) {
      db.close();
      return { status: "unreadable" };
    }
    return { status: "open", db };
  } catch {
    // Corrupt, not SQLite at all, or an extension that will not load here.
    db.close();
    return { status: "unreadable" };
  }
}
