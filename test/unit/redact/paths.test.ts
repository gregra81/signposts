// 18-end-to-end-gaps.md item 4, both halves: the paths the entropy redactor
// used to destroy, and the repo-relative form that replaces the reason it was
// pointed at them in the first place.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTROPY_MIN_LEN } from "../../../src/core/config/constants.js";
import { redact } from "../../../src/core/redact/redact.js";
import { repoRelativePath } from "../../../src/core/redact/paths.js";

describe("ordinary file paths survive redaction", () => {
  // Measured against the built function in the end-to-end run, not reasoned
  // about: each of these came back as `[REDACTED:high-entropy]` plus its
  // extension, filename included.
  const paths = [
    "src/main/java/com/acme/payments/gateway/RetryPolicy.java",
    "packages/web/src/components/checkout/PaymentForm.tsx",
    "/home/ci/work/repo/src/services/billing/invoices.py",
  ];

  for (const filePath of paths) {
    it(`leaves ${filePath} alone`, () => {
      expect(redact(filePath)).toBe(filePath);
    });
  }

  it("still redacts a base64 blob that happens to contain slashes", () => {
    const blob = "dGhpc0lzQVZlcnlMb25nQmFzZTY0U2Vjcm/ldFZhbHVlPT0";

    expect(redact(blob)).toContain("[REDACTED:high-entropy]");
    expect(redact(blob)).not.toContain("dGhpc0lzQVZlcnlMb25nQmFzZTY0");
  });

  // The other half of the trade. An AWS secret access key is forty base64
  // characters, and a `/` lands in roughly half of them; with `/` out of the
  // class the run split into two sub-ENTROPY_MIN_LEN pieces and nothing
  // matched. `redactEnvSecrets` catches this only in a `KEY=value` line, and a
  // transcript quotes a key in prose as readily as in a shell assignment.
  it("redacts a secret whose only flaw was a slash in the middle", () => {
    const key = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    const redacted = redact(`the secret is ${key} and it rotates monthly`);
    expect(redacted).toContain("[REDACTED:high-entropy]");
    expect(redacted).not.toContain("wJalrXUtnFEMI");
    expect(redacted).not.toContain("bPxRfiCYEXAMPLEKEY");
  });

  // A blob inside a path is the case the segment fallback exists for: the run
  // is not one secret, so it is split, and only the piece long enough to be
  // one is replaced. Exactly ENTROPY_MIN_LEN characters, because the floor is
  // inclusive.
  it("redacts a blob embedded in a path without taking the directories with it", () => {
    const blob = "dGhpc0lzQVZlcnlMb25nQmFzZTY0U2Vj";
    expect(blob).toHaveLength(ENTROPY_MIN_LEN);

    expect(redact(`cache/objects/${blob}`)).toBe("cache/objects/[REDACTED:high-entropy]");
  });

  // The two halves of what makes a slashed run one blob rather than a path.
  // A path of CamelCase directories has no digit in it; a path of SHOUTING
  // ones has no lower case in any segment. A random base64 run has both.
  it("leaves a slashed run that is missing either signal alone", () => {
    const camelCase = "Users/Greg/Documents/ProjectsArchive";
    const shouting = "RELEASE/2026/BUILDARTIFACTS/CHECKSUMS";

    expect(redact(camelCase)).toBe(camelCase);
    expect(redact(shouting)).toBe(shouting);
  });
});

describe("repoRelativePath", () => {
  const repoRoot = path.resolve("/work/acme-api");

  it("strips the repo root, which is where the home directory was", () => {
    expect(repoRelativePath(path.join(repoRoot, "src/config.ts"), repoRoot)).toBe(
      path.join("src", "config.ts"),
    );
  });

  it("leaves a path that is already relative", () => {
    expect(repoRelativePath("src/config.ts", repoRoot)).toBe("src/config.ts");
  });

  it("leaves a path above the root for the redactor chain to handle", () => {
    const outside = path.resolve("/work/other-repo/src/config.ts");

    expect(repoRelativePath(outside, repoRoot)).toBe(outside);
  });

  it("leaves the repo root itself, which names no file", () => {
    expect(repoRelativePath(repoRoot, repoRoot)).toBe(repoRoot);
  });
});
