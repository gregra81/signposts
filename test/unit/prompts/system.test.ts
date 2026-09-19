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
// nothing else in the suite would notice. Update these only alongside
// re-recording the replies under test/eval/ and reading what the model now
// says (09-evaluation.md).
const DIGESTS: Record<NodeName, { sha256: string; bytes: number }> = {
  extract: {
    sha256: "f9db9c0ea14cc34a2f7945d5672332e30d3bc542f697ac7f57c0e0768a8e5e4e",
    bytes: 3108,
  },
  // Updated when the critic gained two reject rules — session history that
  // constrains nothing, and instructions for how an AI assistant should behave
  // — and started being shown the repo's own CLAUDE.md beside the candidates
  // (14-prompts.md, "critic"; 19-value-to-a-user.md, "Follow-up: critic
  // precision"). Measured over the golden set before the re-record and scored
  // again after it: sessions that should produce nothing went from 2 of 10
  // rejecting everything to 6 of 10, and the candidates they kept from 17 of 24
  // to 5 of 24, while 8 of 12 expected claims survived instead of 10.
  //
  // The golden set and the scenarios were both re-recorded against this text,
  // and what the model now says was read rather than assumed: scenario 007 is
  // unstable across recordings and its expectations are unresolved.
  critic: {
    sha256: "ce494fa004aa345959c1db3800a946fc720537d4b7975224801242ed36dbacf3",
    bytes: 2273,
  },
  // Updated when OBSOLETE became the fifth classification kind, which is what
  // finally gives `retire` a trigger (03-memory-model.md "Lifecycle"). The
  // prompt gained the kind, the CONTRADICTION/OBSOLETE distinction and the
  // worked pair, because the two are the ones a classifier will confuse and
  // the cost of confusing them is asymmetric: a wrong OBSOLETE retires a
  // claim that was still true. Extraction quality needs measuring again
  // against the new prompt (09-evaluation.md), and every classify reply
  // recorded against the old system turn is now a miss.
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
  // replacement wording. Extraction quality needs measuring again against the
  // new prompt (09-evaluation.md) — resolve replies recorded before this
  // answered the old one.
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
