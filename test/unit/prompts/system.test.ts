import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLASSIFY_SYSTEM,
  CRITIC_SYSTEM,
  EXTRACT_SYSTEM,
  RESOLVE_SYSTEM,
  SYSTEM_PROMPTS,
  systemPromptFor,
} from "../../../src/core/prompts/system.js";
import type { NodeName } from "../../../src/core/model/types.js";

// Digests of the fenced blocks in 14-prompts.md, taken from the document
// itself. They are the mechanical form of "verbatim": a reworded line, a
// stripped trailing space, or a CRLF sneaking in changes the digest, and
// nothing else in the suite would notice. Update these only alongside a
// re-run of the golden set (09-evaluation.md).
const DIGESTS: Record<NodeName, { sha256: string; bytes: number }> = {
  extract: {
    sha256: "f9db9c0ea14cc34a2f7945d5672332e30d3bc542f697ac7f57c0e0768a8e5e4e",
    bytes: 3108,
  },
  critic: {
    sha256: "0f1accd724348b7d9c09f43757025fd959786a112e1f82a951678102eff6dfe1",
    bytes: 1635,
  },
  // Updated when the within-run reindex gave classify a `pending` flag on its
  // neighbours: 14-prompts.md gained the paragraph telling the model what the
  // flag means, and this is that paragraph's digest. The golden set needs a
  // re-run against the new prompt (09-evaluation.md).
  classify: {
    sha256: "d7b36d3eb5635dc05f77fc6251ed5b81bcb4aca2b6940498dd3d8df57b15f018",
    bytes: 1605,
  },
  resolve: {
    sha256: "962026769fc12d997cab97aaac51b621310d3cd577f5cf21f1911de79e24ded9",
    bytes: 1091,
  },
};

const NODES = Object.keys(DIGESTS) as NodeName[];

describe("system prompts", () => {
  it.each(NODES)("%s matches the transcribed text byte for byte", (node) => {
    const prompt = SYSTEM_PROMPTS[node];
    expect(Buffer.byteLength(prompt, "utf8")).toBe(DIGESTS[node].bytes);
    expect(createHash("sha256").update(prompt, "utf8").digest("hex")).toBe(
      DIGESTS[node].sha256,
    );
  });

  it("maps each node to its own constant", () => {
    expect(systemPromptFor("extract")).toBe(EXTRACT_SYSTEM);
    expect(systemPromptFor("critic")).toBe(CRITIC_SYSTEM);
    expect(systemPromptFor("classify")).toBe(CLASSIFY_SYSTEM);
    expect(systemPromptFor("resolve")).toBe(RESOLVE_SYSTEM);
  });

  it("gives every node a distinct prompt", () => {
    expect(new Set(NODES.map(systemPromptFor)).size).toBe(NODES.length);
  });
});
