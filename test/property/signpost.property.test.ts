// R3/R4 of the signpost build task, and 03-memory-model.md's acceptance
// criterion "Every signpost file round-trips: parse -> serialise -> byte-
// identical."

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSignpost, serialiseSignpost } from "../../src/core/signpost/codec.js";
import { categorySchema, type Signpost } from "../../src/core/signpost/schema.js";
import { CLAIM_MAX_CHARS, CLAIM_REJECT_SUBSTRINGS, ID_PATTERN } from "../../src/core/config/constants.js";

const idArb = fc.stringMatching(ID_PATTERN, { size: "xsmall" });
const categoryArb = fc.constantFrom(...categorySchema.options);
const statusArb = fc.constantFrom("active" as const, "superseded" as const);

// Printable, newline- and semicolon-free so no generated claim can ever
// accidentally contain a reject substring or a newline; the filter below
// is a belt-and-braces backstop, not the primary defence.
const claimArb = fc
  .string({ minLength: 1, maxLength: CLAIM_MAX_CHARS, unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.'-") })
  .filter((claim) => !CLAIM_REJECT_SUBSTRINGS.some((s) => claim.includes(s)));

const freeTextArb = fc.string({ maxLength: 40 });
const evidenceArb = fc.string({ maxLength: 500 });

const scopeArb = fc.record({
  repo: freeTextArb,
  paths: fc.option(fc.array(freeTextArb, { maxLength: 3 }), { nil: undefined }),
  tools: fc.option(fc.array(freeTextArb, { maxLength: 3 }), { nil: undefined }),
});

const provenanceArb = fc.record({
  session_ids: fc.array(freeTextArb, { minLength: 1, maxLength: 3 }),
  authors: fc.array(freeTextArb, { minLength: 1, maxLength: 3 }),
  first_seen: freeTextArb,
  last_reinforced: freeTextArb,
});

const signpostArb: fc.Arbitrary<Signpost> = fc
  .record({
    id: idArb,
    claim: claimArb,
    category: categoryArb,
    scope: scopeArb,
    evidence: evidenceArb,
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    provenance: provenanceArb,
    status: statusArb,
    supersedes: fc.option(fc.array(freeTextArb, { maxLength: 3 }), { nil: undefined }),
  })
  .map(({ scope, supersedes, ...rest }) => {
    const cleanScope: Signpost["scope"] = { repo: scope.repo };
    if (scope.paths !== undefined) cleanScope.paths = scope.paths;
    if (scope.tools !== undefined) cleanScope.tools = scope.tools;
    const signpost: Signpost = { ...rest, scope: cleanScope };
    if (supersedes !== undefined) signpost.supersedes = supersedes;
    return signpost;
  });

describe("signpost round-trip properties", () => {
  it("R3: parse(serialise(s)) deep-equals s", () => {
    fc.assert(
      fc.property(signpostArb, (signpost) => {
        expect(parseSignpost(serialiseSignpost(signpost))).toEqual(signpost);
      }),
    );
  });

  it("R4: serialise(s) is byte-identical across two calls on the same input", () => {
    fc.assert(
      fc.property(signpostArb, (signpost) => {
        expect(serialiseSignpost(signpost)).toBe(serialiseSignpost(signpost));
      }),
    );
  });
});
