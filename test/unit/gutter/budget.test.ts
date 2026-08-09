import { describe, expect, it } from "vitest";
import { head, headAndTail } from "../../../src/core/gutter/budget.js";

describe("head", () => {
  it("passes text through unmodified when under both limits", () => {
    const text = "Short reply. Still short.";
    expect(head(text, 2, 400)).toBe(text);
  });

  it("passes text through unmodified when exactly at the sentence budget, well under the char budget", () => {
    const text = "One. Two.";
    expect(head(text, 2, 400)).toBe(text);
  });

  it("cuts at maxSentences when the sentence count is the tighter limit", () => {
    const text = "One. Two. Three. Four.";
    expect(head(text, 2, 400)).toBe("One. Two. ");
  });

  it("cuts mid-sentence at exactly maxChars, preserving exact prefix content", () => {
    // Digits, not a repeated char, so a slice off-by-one changes the assertion.
    const text = "0123456789ABCDEFGHIJ. tail content that must not appear";
    expect(head(text, 2, 10)).toBe("0123456789");
  });

  it("includes a whole first sentence that fits, then cuts partway through the second", () => {
    const text = "Hi. 0123456789ABCDEFGHIJ. tail";
    expect(head(text, 2, 8)).toBe("Hi. 0123");
  });

  it("passes a first sentence through whole when its length exactly equals maxChars", () => {
    // "1234567." is exactly 8 chars; the equal-length case must not be
    // treated as over budget (off-by-one would shorten this by one char).
    const text = "1234567.8901234.";
    expect(head(text, 2, 8)).toBe("1234567.");
  });

  it("returns the whole (short) text when there is no terminal punctuation", () => {
    expect(head("no punctuation here", 2, 400)).toBe("no punctuation here");
  });

  it("returns empty string for empty input (the zero-text-blocks case)", () => {
    expect(head("", 2, 400)).toBe("");
  });

  it("treats a run of punctuation as one sentence boundary, not one per character", () => {
    expect(head("Wait!! Ok. Then this.", 2, 400)).toBe("Wait!! Ok. ");
  });

  it("never exceeds maxChars", () => {
    const text = "Sentence one is long. ".repeat(50);
    const result = head(text, 2, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("shaves a lone trailing high surrogate rather than splitting an emoji's UTF-16 pair", () => {
    // "😀" is a surrogate pair; placed so the 400-char slice lands exactly
    // between its two code units.
    const text = "a".repeat(399) + "😀" + "b".repeat(200);
    const result = head(text, 2, 400);
    expect(result).toBe("a".repeat(399));
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result.isWellFormed()).toBe(true);
  });

  it("does not shave a valid trailing char just because a fully-paired emoji appears earlier", () => {
    // The surrogate check must look only at the very end of the cut, not
    // anywhere in it — an intact (non-lone) surrogate pair mid-string must
    // not trigger a trim of an unrelated trailing character.
    const text = "😀" + "x".repeat(450);
    const result = head(text, 2, 400);
    expect(result.length).toBe(400);
    expect(result.endsWith("x")).toBe(true);
  });
});

describe("headAndTail", () => {
  it("passes text through unmodified, not duplicated, when it is shorter than the head+tail budget", () => {
    expect(headAndTail("short text", 600, 900)).toBe("short text");
  });

  it("passes text through unchanged, including the middle, at exactly the head+tail budget", () => {
    const text = "H" + "x".repeat(1498) + "T"; // length 1500 = 600 + 900
    expect(headAndTail(text, 600, 900)).toBe(text);
  });

  it("drops content once the source is one char over the head+tail budget", () => {
    const text = "H" + "x".repeat(1499) + "T"; // length 1501 = head + tail + 1
    const result = headAndTail(text, 600, 900);
    expect(result.length).toBe(1500); // 600 + 900, not the original 1501
    expect(result.startsWith("H" + "x".repeat(599))).toBe(true); // exact head slice
    expect(result.endsWith("x".repeat(899) + "T")).toBe(true); // exact tail slice
    expect(result).not.toBe(text);
  });

  it("takes head from the start and tail from the end, dropping a distinct middle marker", () => {
    const text = "START" + "MIDDLE-MARKER-THAT-MUST-BE-DROPPED" + "END";
    const result = headAndTail(text, 5, 3);
    expect(result).toBe("STARTEND");
    expect(result).not.toContain("MIDDLE-MARKER");
  });

  it("shaves lone surrogates at both the head cut and the tail cut, keeping the result well-formed", () => {
    const headChars = 600;
    const tailChars = 900;
    // Each emoji is placed so its UTF-16 pair straddles a cut point: the
    // head cut lands between the head-side emoji's two code units, and the
    // tail cut lands between the tail-side emoji's two code units.
    const prefix = "a".repeat(headChars - 1);
    const suffix = "n".repeat(tailChars - 1);
    const text = prefix + "😀" + "m".repeat(1000) + "😀" + suffix;

    const result = headAndTail(text, headChars, tailChars);

    expect(result).toBe(prefix + suffix);
    expect(result.isWellFormed()).toBe(true);
  });

  it("yields exactly the head, not head+full text, when tailChars is 0 (N4)", () => {
    const text = "H".repeat(600) + "x".repeat(1000);
    const result = headAndTail(text, 600, 0);
    expect(result).toBe("H".repeat(600));
  });

  it("does not shave a valid leading tail char just because a fully-paired emoji appears later in the tail", () => {
    // Same anchoring requirement as head(): the check must look only at the
    // very start of the tail cut, not anywhere in it.
    const headChars = 601;
    const tailChars = 900;
    const tailRegion = "y" + "😀" + "z".repeat(897); // 900 chars: leading char is plain
    const text = "a".repeat(602) + tailRegion; // 602 + 900 > headChars + tailChars, forces the slice path

    const result = headAndTail(text, headChars, tailChars);

    expect(result.endsWith(tailRegion)).toBe(true); // full 900-char tail, unshaved
  });
});
