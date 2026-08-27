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

/** Absolute path to the active profile's credential file — exported so `doctor` can name it. */
export function consoleProfilePath(input: ConsoleProfileInput): string {
  const configDir = input.env[CONFIG_DIR_ENV] ?? path.join(input.homeDir, ANTHROPIC_CONFIG_DIRNAME);
  const profile = input.env[PROFILE_ENV] ?? ANTHROPIC_DEFAULT_PROFILE;
  return path.join(configDir, ANTHROPIC_CREDENTIALS_DIRNAME, `${profile}.json`);
}

export function hasConsoleProfile(input: ConsoleProfileInput): boolean {
  return existsSync(consoleProfilePath(input));
}
