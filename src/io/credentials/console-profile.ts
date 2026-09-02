// Detects an `ant auth login` profile — the OAuth credential the Anthropic
// CLI and every Anthropic SDK read from disk when no credential env var is
// set. Presence only: signposts never parses or forwards this token, because
// a bare `new Anthropic()` already resolves it natively. All we need to know
// is whether that would succeed.
//
// Layout (`ant auth status`, CLI 1.27.0):
//   $ANTHROPIC_CONFIG_DIR (default ~/.config/anthropic)
//     configs/<profile>.json       settings
//     credentials/<profile>.json   tokens
//
// The active profile is $ANTHROPIC_PROFILE, else "default".

import { existsSync } from "node:fs";
import path from "node:path";
import {
  ANTHROPIC_CONFIG_DIRNAME,
  ANTHROPIC_CREDENTIALS_DIRNAME,
  ANTHROPIC_DEFAULT_PROFILE,
} from "../../core/config/constants.ts";

const CONFIG_DIR_ENV = "ANTHROPIC_CONFIG_DIR";
const PROFILE_ENV = "ANTHROPIC_PROFILE";

export interface ConsoleProfileInput {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The profile `ant` would use: $ANTHROPIC_PROFILE, else "default".
 *
 * Exported because a client pinned to this method has to name it. Passing
 * `profile` to the SDK constructor is what stops ANTHROPIC_API_KEY in the
 * environment from shadowing the profile (`client.mjs` skips both credential
 * env vars when `profile` is set), so the name is the whole pin.
 */
export function activeConsoleProfile(env: ConsoleProfileInput["env"]): string {
  return env[PROFILE_ENV] ?? ANTHROPIC_DEFAULT_PROFILE;
}

/** Absolute path to the active profile's credential file — exported so `doctor` can name it. */
export function consoleProfilePath(input: ConsoleProfileInput): string {
  const configDir = input.env[CONFIG_DIR_ENV] ?? path.join(input.homeDir, ANTHROPIC_CONFIG_DIRNAME);
  return path.join(configDir, ANTHROPIC_CREDENTIALS_DIRNAME, `${activeConsoleProfile(input.env)}.json`);
}

export function hasConsoleProfile(input: ConsoleProfileInput): boolean {
  return existsSync(consoleProfilePath(input));
}
