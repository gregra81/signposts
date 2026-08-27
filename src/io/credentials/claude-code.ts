// Reads the OAuth credential Claude Code holds for a signed-in Claude
// subscription. On macOS it lives in the login Keychain as a generic
// password; elsewhere Claude Code writes it to `~/.claude/.credentials.json`.
// Both carry the same JSON payload, parsed by
// src/core/credentials/claude-code-payload.ts.
//
// Every failure mode here is "absent", never a throw: no Keychain item, a
// locked Keychain, no `security` binary, an unreadable file, malformed JSON.
// `doctor` is the command you run when the machine is broken, so it has to
// survive a broken machine.
//
// This reads another application's credential store. That is a real cost —
// it breaks whenever Claude Code changes storage — and it is accepted
// deliberately; see 08-models-and-credentials.md, "The Claude subscription
// credential".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLAUDE_CODE_CREDENTIALS_FILE,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
} from "../../core/config/constants.ts";
import {
  parseSubscriptionCredential,
  type SubscriptionCredential,
} from "../../core/credentials/claude-code-payload.ts";

const MACOS_PLATFORM = "darwin";
const SECURITY_BINARY = "security";

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * `security find-generic-password -w` prints the secret to stdout and exits
 * non-zero when the item is missing or the Keychain is locked. stdio for
 * stderr is "ignore" so a lock prompt's diagnostics never land in signposts'
 * own output alongside the token.
 */
function readKeychain(account: string): string | undefined {
  try {
    return execFileSync(
      SECURITY_BINARY,
      ["find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return undefined;
  }
}

function readCredentialsFile(homeDir: string): string | undefined {
  try {
    return readFileSync(path.join(homeDir, CLAUDE_CODE_CREDENTIALS_FILE), "utf8");
  } catch {
    return undefined;
  }
}

export interface ReadSubscriptionInput {
  homeDir: string;
  /** `process.platform`, passed in rather than read, so both branches are testable. */
  platform: string;
  /** Keychain account name — the OS username Claude Code stored the item under. */
  account: string;
}

/**
 * Returns the credential as stored, without checking expiry — callers pair
 * this with `isCredentialUsable` and their own clock. Undefined means no
 * subscription credential is available on this machine.
 */
export function readSubscriptionCredential(
  input: ReadSubscriptionInput,
): SubscriptionCredential | undefined {
  const raw =
    input.platform === MACOS_PLATFORM
      ? (readKeychain(input.account) ?? readCredentialsFile(input.homeDir))
      : readCredentialsFile(input.homeDir);

  return parseSubscriptionCredential(parseJson(raw));
}
