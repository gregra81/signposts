// The durable checkpointer: LangGraph's SQLite saver, opened on the
// checkpoint database at CHECKPOINT_PATH (src/core/config/paths.ts).
//
// Two decisions are encoded here, and both are the point of the module:
//
//   - **The connection is ours.** `SqliteSaver.fromConnString` would open the
//     file with the `better-sqlite3` copy hoisted under the checkpoint
//     package, which is a second native binding in the same process — the
//     thing 13-constants.md's SQLITE_BINDING rule ("one binding") exists to
//     prevent. Passing a Database this module opened keeps every SQLite
//     handle in the process on the binding src/io/db/migrate.ts uses.
//
//   - **Callers see the interface, not the class.** The return type is
//     `BaseCheckpointSaver`, so nothing downstream can reach for a
//     SqliteSaver-only member. Swapping in `-postgres` is then this file and
//     nothing else (04-extraction-graph.md).
//
// The checkpoint database is its own file, separate from the signpost mirror
// at DB_PATH: the saver owns and creates its own tables, and no migration in
// migrate.ts knows about them.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

/**
 * An open checkpointer and the handle that owns its connection.
 *
 * `close` is separate from the checkpointer because `BaseCheckpointSaver`
 * has no close of its own — the caller that opened the file is the one that
 * has to release it, and a Postgres saver's pool would close the same way.
 */
export interface CheckpointerHandle {
  checkpointer: BaseCheckpointSaver;
  close(): void;
}

/**
 * Opens (creating if absent) the checkpoint database at `checkpointPath`.
 *
 * The saver creates its own tables on first use, so there is nothing to
 * migrate here; a file left by an earlier run is reopened as it is, which is
 * exactly what makes a review answered three days later resumable.
 */
export function openCheckpointer(checkpointPath: string): CheckpointerHandle {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const db = new Database(checkpointPath);

  try {
    // `new Database` does not read the file, and `new SqliteSaver` only stores
    // the handle — its DDL is deferred to the first save. Without this read a
    // corrupt or truncated checkpoints.db would open cleanly here and surface
    // as "file is not a database" from inside `startRun`, with the connection
    // still open. Reading a pragma parses the header now, so a bad file fails
    // at the call that opened it, exactly as openDb's version check does.
    db.pragma("user_version");

    return {
      checkpointer: new SqliteSaver(db),
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    // Same reason as openDb: the handle is already open, so it has to be
    // released before the failure propagates.
    db.close();
    throw error;
  }
}
