// Fake Stdio (src/app.ts's `stdio`, not a port) for driving the consent
// prompt and capturing what a command printed — hand-written, no mocking
// framework, same rationale as the fake ports.

import { PassThrough, Readable } from "node:stream";
import type { Stdio } from "../../../src/app.js";

export interface FakeStdio extends Stdio {
  /** Everything written to `output` (stdout), joined. */
  writtenOutput(): string;
  /** Everything written to `error` (stderr), joined. */
  writtenError(): string;
}

/** `answerLine` is fed to the first `readline` question asked (e.g. the consent prompt); omit if none is expected. */
export function createFakeStdio(answerLine?: string): FakeStdio {
  const input = answerLine === undefined ? new Readable({ read() {} }) : Readable.from([`${answerLine}\n`]);
  return buildFakeStdio(input);
}

/** Stdin that hits EOF immediately with no data — the piped/non-TTY/CI case (e.g. `< /dev/null`). */
export function createEofStdio(): FakeStdio {
  return buildFakeStdio(Readable.from([]));
}

function buildFakeStdio(input: Readable): FakeStdio {
  const output = new PassThrough();
  const error = new PassThrough();
  const outputChunks: string[] = [];
  const errorChunks: string[] = [];
  output.on("data", (chunk: Buffer) => outputChunks.push(chunk.toString("utf8")));
  error.on("data", (chunk: Buffer) => errorChunks.push(chunk.toString("utf8")));

  return {
    input,
    output,
    error,
    writtenOutput: () => outputChunks.join(""),
    writtenError: () => errorChunks.join(""),
  };
}
