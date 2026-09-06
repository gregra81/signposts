// What `signpost resume --replies` accepts. The answers themselves are
// checked against their own schemas inside the graph; this is only the
// envelope, and it is strict because a malformed one means the caller has
// misunderstood the protocol rather than answered badly.

import { describe, expect, it } from "vitest";
import { parseReplies } from "../../../src/core/cli/replies.js";

describe("parseReplies", () => {
  it("reads the wrapped form", () => {
    expect(parseReplies('{"replies": {"abc": {"kind": "NOVEL"}}}')).toEqual({
      abc: { kind: "NOVEL" },
    });
  });

  it("reads a bare map of answers", () => {
    expect(parseReplies('{"abc": 1}')).toEqual({ abc: 1 });
  });

  it("names JSON that does not parse", () => {
    expect(() => parseReplies("{not json")).toThrow(/--replies is not valid JSON/);
  });

  it.each([["[]"], ['"text"'], ["42"], ["null"]])("rejects %s", (text) => {
    expect(() => parseReplies(text)).toThrow(/--replies must be a JSON object/);
  });

  it("rejects a replies key that is not a map", () => {
    expect(() => parseReplies('{"replies": []}')).toThrow(/keyed by pending id/);
  });

  it("rejects an empty set of answers, which would resume nothing", () => {
    expect(() => parseReplies('{"replies": {}}')).toThrow(/carries no answers/);
  });
});
