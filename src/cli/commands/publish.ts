// `signpost publish`: push what the runs committed and open or update the pull
// request, once the developer has said yes to it (19-value-to-a-user.md, open
// item 1). The work is src/io/commit/publish.ts; this prints one JSON object,
// like the run commands, because the skill is what calls it.

import type { ExitCode } from "../../app.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";
import { JSON_INDENT } from "../../core/config/constants.ts";
import type { PublishOutput } from "../protocol.ts";
import type { Publish } from "../run-port.ts";
import { fail } from "../with-run.ts";

export interface RunPublishInput {
  config: ResolvedConfig;
  repoRoot: string;
  publish: Publish;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function runPublish(input: RunPublishInput): Promise<ExitCode> {
  let outcome;
  try {
    outcome = await input.publish({
      config: input.config,
      repoRoot: input.repoRoot,
      warn: (message) => input.stderr.write(`${message}\n`),
    });
  } catch (error) {
    return fail(input.stderr, error instanceof Error ? error.message : String(error));
  }

  const output: PublishOutput =
    outcome === null ? { status: "nothing", publish: null } : { status: "published", publish: outcome };
  input.stdout.write(`${JSON.stringify(output, null, JSON_INDENT)}\n`);

  // 4 rather than 1 for the same reason it always was: the work is safe on a
  // branch, and a caller treating non-zero as fatal must be able to tell that
  // from a failure (12-wire-contracts.md, "Exit codes").
  return outcome?.manualCommand == null ? EXIT_CODES.ok : EXIT_CODES.prCreationFailed;
}
