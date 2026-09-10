// 18-end-to-end-gaps.md item 4, both halves: the paths the entropy redactor
// used to destroy, and the repo-relative form that replaces the reason it was
// pointed at them in the first place.

import path from "node:path";
import { describe, expect, it } from "vitest";
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
    // 44 characters, slashes and all: dropping `/` from the class costs the
    // pattern the slashes, not the match — there is more than enough left.
    const blob = "dGhpc0lzQVZlcnlMb25nQmFzZTY0U2Vjcm/ldFZhbHVlPT0";

    expect(redact(blob)).toContain("[REDACTED:high-entropy]");
    expect(redact(blob)).not.toContain("dGhpc0lzQVZlcnlMb25nQmFzZTY0");
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
