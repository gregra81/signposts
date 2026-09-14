// Tier 5 scan: one home per prompt.
//
// A system prompt that exists in two places drifts, and a drifted prompt
// breaks caching silently — the call still works, it just costs full price
// and behaves slightly differently from the one its quality was measured with.
// This walks the tree rather than trusting review to notice a copy-paste,
// and checks every substantial line, not only whole-prompt copies.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as promptModule from "../../src/core/prompts/system.js";
import { SYSTEM_PROMPTS } from "../../src/core/prompts/system.js";
import type { NodeName } from "../../src/core/model/types.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PROMPT_MODULE = path.join(REPO_ROOT, "src", "core", "prompts", "system.ts");
const SCANNED_DIRS = ["src", "test", "eslint-rules", "hooks", "scripts", "bin", "statusline"];

const NODES = Object.keys(SYSTEM_PROMPTS) as NodeName[];

/**
 * Lines long enough to be unmistakable, and free of the characters a template
 * literal has to escape — so a marker can be searched for in source text
 * exactly as it appears in the prompt value.
 */
function markers(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 40 && !line.includes("`") && !line.includes("${"));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function sourceFiles(): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const dir of SCANNED_DIRS) {
    const entries = await readdir(path.join(REPO_ROOT, dir), {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|js|mjs)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      contents.set(file, readFileSync(file, "utf8"));
    }
  }
  return contents;
}

describe("prompt uniqueness", () => {
  it.each(NODES)("%s prompt is the value of exactly one exported constant", (node) => {
    const named = Object.entries(promptModule).filter(
      ([, value]) => typeof value === "string" && value === SYSTEM_PROMPTS[node],
    );
    expect(named.map(([name]) => name)).toHaveLength(1);
  });

  it("no prompt line is inlined anywhere but the prompt module", async () => {
    const files = await sourceFiles();
    const own = files.get(PROMPT_MODULE);
    expect(own).toBeDefined();

    const inlined: Array<{ file: string; line: string }> = [];
    for (const node of NODES) {
      const lines = markers(SYSTEM_PROMPTS[node]);
      expect(lines.length).toBeGreaterThan(0);

      for (const marker of lines) {
        // The new-hire test appears in more than one prompt on purpose, so
        // the module may legitimately hold a line once per prompt using it.
        const expected = NODES.filter((other) => SYSTEM_PROMPTS[other].includes(marker)).length;
        if (occurrences(own!, marker) !== expected) {
          inlined.push({ file: PROMPT_MODULE, line: marker });
        }
        for (const [file, content] of files) {
          if (file === PROMPT_MODULE) continue;
          if (content.includes(marker)) inlined.push({ file, line: marker });
        }
      }
    }

    expect(inlined).toEqual([]);
  });
});
