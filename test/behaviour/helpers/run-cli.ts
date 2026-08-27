// Thin wrapper matching 15-spec.md's "The seam":
// `runCli(["run"], { config, ports: { model, clock, forge } })`. Every
// behaviour test in test/behaviour/cli drives the app through this instead
// of constructing createApp itself.

import { createApp, type CreateAppInput, type ExitCode } from "../../../src/app.js";

export function runCli(argv: string[], input: CreateAppInput): Promise<ExitCode> {
  return createApp(input).run(argv);
}
