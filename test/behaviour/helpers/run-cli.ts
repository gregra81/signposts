// Thin wrapper matching 15-spec.md's "The seam":
// `runCli(["run"], { config, openRun })`. Every behaviour test in
// test/behaviour/cli drives the app through this instead of constructing
// createApp itself.
//
// `openRun` defaults to the production one, because what these tests are
// about is the real thing: a real database, a real embedder, real git. A test
// that only needs `init`, `index` or `doctor` never reaches it — those
// commands do not open a run — so the default costs them nothing.

import { createApp, type CreateAppInput, type ExitCode } from "../../../src/app.js";
import { openRun } from "../../../src/io/open-run.js";

export function runCli(
  argv: string[],
  input: Omit<CreateAppInput, "openRun"> & Partial<Pick<CreateAppInput, "openRun">>,
): Promise<ExitCode> {
  return createApp({ openRun, ...input }).run(argv);
}
