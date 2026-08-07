// Behaviour test for the streaming reader — outside test/unit because the
// repo's mutation-graded unit suite (test/unit, driven by
// vitest.unit.config.ts / stryker.config.mjs) excludes src/io/. Root
// vitest.config.ts includes test/**/*.test.ts, so this still runs under
// `pnpm test`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readTranscript } from "../../../src/io/transcript/read.js";

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({
    uuid: "u",
    parentUuid: null,
    sessionId: "s",
    timestamp: "2026-01-01T00:00:00Z",
    type: "system",
    ...fields,
  });

describe("readTranscript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "signposts-transcript-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function collect(filePath: string, logger?: (msg: string) => void) {
    const { lines, counts } = readTranscript(filePath, logger ? { logger } : {});
    const collected = [];
    for await (const l of lines) {
      collected.push(l);
    }
    return { collected, counts };
  }

  it("counts a truncated final line as malformed and skipped, completing normally with earlier lines yielded", async () => {
    const good1 = line({ uuid: "a" });
    const good2 = line({ uuid: "b" });
    const truncated = line({ uuid: "c" }).slice(0, -5);
    const file = path.join(dir, "truncated.jsonl");
    writeFileSync(file, [good1, good2, truncated].join("\n"));

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(2);
    expect(collected.map((l) => l.uuid)).toEqual(["a", "b"]);
    expect(counts.linesSkipped).toBe(1);
    expect(counts.linesIgnored).toBe(0);
    expect(counts.linesRead).toBe(3);
    expect(counts.linesRead).toBe(collected.length + counts.linesSkipped);
  });

  it("counts unrecognised-type sidecar lines as ignored (not skipped), and still yields them", async () => {
    const good1 = line({ uuid: "a" });
    const good2 = line({ uuid: "b" });
    const mode = '{"type":"mode","mode":"normal","sessionId":"s1"}';
    const aiTitle = '{"type":"ai-title","aiTitle":"Some title","sessionId":"s1"}';
    const file = path.join(dir, "sidecar.jsonl");
    writeFileSync(file, [good1, mode, good2, aiTitle].join("\n"));

    const { collected, counts } = await collect(file);

    expect(collected).toHaveLength(4);
    expect(counts.linesRead).toBe(4);
    expect(counts.linesSkipped).toBe(0);
    expect(counts.linesIgnored).toBe(2);
    expect(counts.linesRead).toBe(collected.length + counts.linesSkipped);
  });

  it("skips garbage non-JSON lines interleaved with good ones, yielding good lines in order", async () => {
    const file = path.join(dir, "garbage.jsonl");
    writeFileSync(
      file,
      [line({ uuid: "a" }), "not json at all", line({ uuid: "b" }), "{also bad", line({ uuid: "c" })].join("\n"),
    );

    const { collected, counts } = await collect(file);

    expect(collected.map((l) => l.uuid)).toEqual(["a", "b", "c"]);
    expect(counts.linesSkipped).toBe(2);
    expect(counts.linesIgnored).toBe(0);
    expect(counts.linesRead).toBe(5);
  });

  it("warns once for an unseen major version even across many lines with that version", async () => {
    const file = path.join(dir, "unseen-major.jsonl");
    writeFileSync(
      file,
      [
        line({ uuid: "a", version: "3.0.1" }),
        line({ uuid: "b", version: "3.0.1" }),
        line({ uuid: "c", version: "3.0.1" }),
      ].join("\n"),
    );

    const warnings: string[] = [];
    const { collected } = await collect(file, (msg) => warnings.push(msg));

    expect(collected).toHaveLength(3);
    expect(warnings).toHaveLength(1);
  });

  it("never warns for a known (version 2) fixture", async () => {
    const file = path.join(dir, "known-major.jsonl");
    writeFileSync(
      file,
      [line({ uuid: "a", version: "2.1.223" }), line({ uuid: "b", version: "2.0.0" })].join("\n"),
    );

    const warnings: string[] = [];
    const { counts } = await collect(file, (msg) => warnings.push(msg));

    expect(warnings).toHaveLength(0);
    expect([...counts.versionsSeen].sort()).toEqual(["2.0.0", "2.1.223"]);
  });

  it("records the version and warns on an unseen major from an unrecognised-type (ignored) line, with no known-type line in the file at all", async () => {
    // Real shape: "attachment" sidecar lines carry a version field. R4 is
    // unqualified by line type — this must still record and warn even
    // though every line in the file is "ignored", never "parsed".
    const file = path.join(dir, "attachment-only.jsonl");
    writeFileSync(
      file,
      [
        '{"type":"attachment","version":"3.0.1","sessionId":"s1"}',
        '{"type":"attachment","version":"3.0.1","sessionId":"s1"}',
      ].join("\n"),
    );

    const warnings: string[] = [];
    const { collected, counts } = await collect(file, (msg) => warnings.push(msg));

    expect(collected).toHaveLength(2);
    expect(counts.linesIgnored).toBe(2);
    expect(counts.linesSkipped).toBe(0);
    expect([...counts.versionsSeen]).toEqual(["3.0.1"]);
    expect(warnings).toHaveLength(1);
  });

  it("fuzz: arbitrary strings joined as lines never throw, and skipped+parsed counts sum to lines read", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), async (rawLines) => {
        const file = path.join(dir, `fuzz-${Math.random()}.jsonl`);
        writeFileSync(file, rawLines.join("\n"));

        const { collected, counts } = await collect(file);

        expect(counts.linesSkipped + collected.length).toBe(counts.linesRead);
        // Some fc.string() samples ARE valid JSON (e.g. "1", "43") — but only
        // scalars, since fc.string() draws plain text, never object syntax
        // with a "type" key. A scalar fails otherLineSchema's looseObject
        // (which requires an object), so it lands in linesSkipped either way.
        // Sharpens R2's new boundary: "invalid JSON" and "valid JSON, wrong
        // shape" both land in linesSkipped, and only a real object with an
        // unrecognised `type` string reaches linesIgnored — which is exactly
        // what would catch a moved boundary.
        expect(counts.linesIgnored).toBe(0);
      }),
    );
  });
});
