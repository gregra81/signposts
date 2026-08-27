import { describe, expect, it } from "vitest";
import { contentHashFor } from "../../../src/core/signpost/content-hash.js";
import { serialiseSignpost } from "../../../src/core/signpost/codec.js";
import type { Signpost } from "../../../src/core/signpost/schema.js";

const VALID: Signpost = {
  id: "staging-db-read-only",
  claim: "The staging database is read-only; run migrations against dev instead.",
  category: "environment",
  scope: { repo: "acme/platform", paths: ["prisma/**", "scripts/migrate*"] },
  evidence:
    "A migration run against staging failed with a permissions error that read as a\nconnection problem. Staging is a read-only replica; the writable instance is dev.",
  confidence: 0.91,
  status: "active",
  provenance: {
    session_ids: ["01J8X", "01J9F"],
    authors: ["rashkevitch@gmail.com"],
    first_seen: "2026-07-14",
    last_reinforced: "2026-07-28",
  },
};

describe("contentHashFor", () => {
  it("is sha256 hex of the canonical serialised form", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(serialiseSignpost(VALID)).digest("hex");
    expect(contentHashFor(VALID)).toBe(expected);
  });

  it("is stable across calls on an equal signpost", () => {
    expect(contentHashFor(VALID)).toBe(contentHashFor({ ...VALID }));
  });

  it("diverges when the claim changes", () => {
    expect(contentHashFor(VALID)).not.toBe(contentHashFor({ ...VALID, claim: "A different claim entirely." }));
  });
});
