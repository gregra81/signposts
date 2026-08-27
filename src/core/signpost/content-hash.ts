// Defines what `content_hash` (the `signposts` table column driving
// mirrorSignposts' upsert and corpus-hash.ts's reindex trigger) actually
// is: decision logic, so it lives here rather than in src/cli/commands/
// where it previously sat.

import { createHash } from "node:crypto";
import { serialiseSignpost } from "./codec.ts";
import type { Signpost } from "./schema.ts";

/** Byte-stable per serialiseSignpost — hashes the canonical form, not the raw file bytes. */
export function contentHashFor(signpost: Signpost): string {
  return createHash("sha256").update(serialiseSignpost(signpost)).digest("hex");
}
