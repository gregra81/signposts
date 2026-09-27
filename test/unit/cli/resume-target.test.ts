// Which halted thread `signpost resume` continues when it is not named in full.

import { describe, expect, it } from "vitest";
import { chooseResumeTarget } from "../../../src/core/cli/resume-target.js";

const A = { sessionId: "sess-a", contentHash: "hash-a1" };
const A_GROWN = { sessionId: "sess-a", contentHash: "hash-a2" };
const B = { sessionId: "sess-b", contentHash: "hash-b1" };

describe("chooseResumeTarget", () => {
  it("takes the only halted thread when nothing is named", () => {
    expect(chooseResumeTarget([A], {})).toEqual({ session: A });
  });

  it("takes the named session's thread among others", () => {
    expect(chooseResumeTarget([A, B], { sessionId: "sess-b" })).toEqual({ session: B });
  });

  it("takes the named hash when one session has two halted threads", () => {
    expect(chooseResumeTarget([A, A_GROWN], { contentHash: "hash-a2" })).toEqual({ session: A_GROWN });
  });

  it("needs both halves to match when both are given", () => {
    expect(chooseResumeTarget([A, B], { sessionId: "sess-a", contentHash: "hash-b1" })).toEqual({
      error: "session sess-a has no halted thread to resume — `signpost run --session sess-a` starts it",
    });
  });

  it("says nothing is halted, and how to start", () => {
    expect(chooseResumeTarget([], {})).toEqual({
      error: "nothing is halted in this repo — `signpost run` starts a session",
    });
  });

  it("refuses to guess between several, and lists each as the flags that name it", () => {
    expect(chooseResumeTarget([A, B], {})).toEqual({
      error:
        "2 halted threads match; name one:\n" +
        "  --session sess-a --content-hash hash-a1\n" +
        "  --session sess-b --content-hash hash-b1",
    });
    expect(chooseResumeTarget([A, A_GROWN], { sessionId: "sess-a" })).toHaveProperty("error");
  });
});
