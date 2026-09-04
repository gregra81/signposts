// The rule that keeps src/core/ pure.
//
// Written after confine.ts was found importing node:fs and calling lstat,
// readlink and realpath — for a real reason, and unnoticed for months.
// These cases are the escape routes a denylist would have missed.

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-io-in-core.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("no-io-in-core", rule, {
  valid: [
    { code: 'import path from "node:path";', filename: "src/core/paths/confine.ts" },
    {
      // Hashing is deterministic, which is why content hashes live in core.
      code: 'import { createHash } from "node:crypto";',
      filename: "src/core/signpost/content-hash.ts",
    },
    { code: 'import { confine } from "../core/paths/confine.ts";', filename: "src/core/x.ts" },
    // io is where these belong, and the graph is not core either.
    { code: 'import fs from "node:fs";', filename: "src/io/tools/repo-tools.ts" },
    { code: 'import { spawnSync } from "node:child_process";', filename: "src/io/git/remote-origin.ts" },
    { code: "const now = Date.now();", filename: "src/io/clock/system-clock.ts" },
    {
      // Parsing a date string is deterministic; only the zero-arg form reads
      // the clock.
      code: 'const d = new Date("2026-01-01");',
      filename: "src/core/eligibility/eligibility.ts",
    },
    {
      // Anchored at the repo root, so a "src/core/" segment nested inside
      // another tree is not core and not an escape hatch either way.
      code: 'import fs from "node:fs";',
      filename: "statusline/src/core/leak.ts",
    },
  ],
  invalid: [
    {
      code: 'import fs from "node:fs";',
      filename: "src/core/paths/confine.ts",
      errors: [{ messageId: "forbiddenModule" }],
    },
    {
      // The subpath a denylist of bare names would wave through.
      code: 'import { readFile } from "node:fs/promises";',
      filename: "src/core/x.ts",
      errors: [{ messageId: "forbiddenModule" }],
    },
    {
      // ...and the unprefixed spelling.
      code: 'import { spawnSync } from "child_process";',
      filename: "src/core/x.ts",
      errors: [{ messageId: "forbiddenModule" }],
    },
    {
      code: 'const fs = require("node:fs");',
      filename: "src/core/x.ts",
      errors: [{ messageId: "forbiddenModule" }],
    },
    {
      code: 'const fs = await import("node:os");',
      filename: "src/core/x.ts",
      errors: [{ messageId: "forbiddenModule" }],
    },
    {
      // A partially-allowed module taken whole hands over its random
      // functions along with its hashes.
      code: 'import crypto from "node:crypto";',
      filename: "src/core/x.ts",
      errors: [{ messageId: "wholeModule" }],
    },
    {
      code: 'import * as crypto from "node:crypto";',
      filename: "src/core/x.ts",
      errors: [{ messageId: "wholeModule" }],
    },
    {
      code: 'import { randomUUID } from "node:crypto";',
      filename: "src/core/signpost/slug.ts",
      errors: [{ messageId: "forbiddenBinding" }],
    },
    {
      code: "const dir = process.env.HOME;",
      filename: "src/core/config/resolve.ts",
      errors: [{ messageId: "forbiddenGlobal" }],
    },
    {
      code: "const now = Date.now();",
      filename: "src/core/eligibility/eligibility.ts",
      errors: [{ messageId: "forbiddenClock" }],
    },
    {
      code: "const now = new Date();",
      filename: "src/core/eligibility/eligibility.ts",
      errors: [{ messageId: "forbiddenClock" }],
    },
    {
      code: "const r = Math.random();",
      filename: "src/core/graph/candidates.ts",
      errors: [{ messageId: "forbiddenRandom" }],
    },
  ],
});
