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
  // Updated when OBSOLETE became the fifth classification kind, which is what
  // finally gives `retire` a trigger (03-memory-model.md "Lifecycle"). The
  // prompt gained the kind, the CONTRADICTION/OBSOLETE distinction and the
  // worked pair, because the two are the ones a classifier will confuse and
  // the cost of confusing them is asymmetric: a wrong OBSOLETE retires a
  // claim that was still true. The golden set needs a re-run against the new
  // prompt (09-evaluation.md), and every recorded classify fixture keyed on
  // the old system turn is now a miss.
  //
  // Previously updated when the within-run reindex gave classify a `pending`
  // flag on its neighbours.
  classify: {
    sha256: "2346a89a15c6d4d44493e76d670c8de8f0b5362ecaf13345ad524116ab39b505",
    bytes: 2719,
  },
  // Updated when the resolver stopped being handed tools: the prompt named
  // read_file, git_log and grep_repo, and nothing brokers those now that the
  // answering session reads the repository itself. 14-prompts.md carries the
  // replacement wording. The golden set needs a re-run against the new prompt
  // (09-evaluation.md) — the recorded resolve scenarios answered the old one.
  resolve: {
    sha256: "56c8014e94d98b93cd4d6105baf244a2b99338f8984233dd62679c8bdfd6ad59",
    bytes: 1170,
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
