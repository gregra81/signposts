// Whether this repo has consented, for `doctor` (19-value-to-a-user.md item 4).
// The same read the run commands' gate makes (../../cli/consent.ts), without
// that gate's stderr: doctor reports it as a line, and turns what it cannot
// read into `unknown` rather than a failure of its own.

import type { ConsentFact } from "../../core/doctor/report.ts";
import { readConsent } from "../init/consent-state.ts";

export function checkConsent(dbPath: string, repo: string | null): ConsentFact {
  if (repo === null) {
    return "unknown";
  }
  try {
    return readConsent(dbPath, repo) ? "given" : "not-given";
  } catch {
    return "unknown";
  }
}
