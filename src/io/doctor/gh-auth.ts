// `gh auth status` via a real subprocess (R5 — deliberately not the Forge
// port; `doctor` reports on the environment, it doesn't touch a PR).
// Degrades gracefully when `gh` is missing: src/core/doctor/report.ts turns
// this raw fact into a report line.

import { spawnSync } from "node:child_process";
import type { GhAuthFact } from "../../core/doctor/report.ts";

export function checkGhAuth(): GhAuthFact {
  const result = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });

  if (result.error) {
    // ENOENT (gh not on PATH) or any other spawn failure — treat as absent.
    return { installed: false, authenticated: false };
  }

  return { installed: true, authenticated: result.status === 0 };
}
