// Production wiring for bin/signpost.js (R6): resolves config from the real
// filesystem/env/cwd/homedir and constructs the three production ports,
// then hands both to createApp. This — together with bin/signpost.js
// itself — is the only place any port is constructed; every command
// downstream receives ports already built, never builds its own (R2).
//
// The model port has no live implementation yet (Slice B — see
// src/io/model/recording-provider.ts's "not implemented" stub); wiring one
// up here would mean a live Anthropic call reachable from this task, which
// is explicitly out of scope. FixtureModelProvider with no fixtures stands
// in exactly as 16-build-plan.md sanctions for the test double, and is
// equally correct here: none of init/index/doctor call the model port, and
// a call that did would fail loudly rather than silently going live.
//
// `repo` (the "owner/name" git-origin key) is NOT resolved here: `doctor`
// must run in any repo, including one with no GitHub origin, so eagerly
// resolving it in this composition root would crash `doctor` before it
// even runs. Each of `init`/`index` resolves its own `repo` lazily instead
// (src/io/git/remote-origin.ts's resolveRepo) and fails gracefully if it
// can't.

import os from "node:os";
import process from "node:process";
import type { App } from "../app.ts";
import { createApp } from "../app.ts";
import { resolveConfig } from "../core/config/resolve.ts";
import { AUTH_METHOD_AUTO, MODEL_DEFAULT } from "../core/config/constants.ts";
import type { NodeName } from "../core/model/types.ts";
import { readRepoConfigFile, readUserConfigFile } from "./config.ts";
import { gatherAuthFacts } from "./credentials/index.ts";
import { FixtureModelProvider } from "./model/fixture-provider.ts";
import { systemClock } from "./clock/system-clock.ts";
import { stubForge } from "./forge/stub-forge.ts";

const MODELS: Record<NodeName, string> = {
  extract: MODEL_DEFAULT,
  critic: MODEL_DEFAULT,
  classify: MODEL_DEFAULT,
  resolve: MODEL_DEFAULT,
};

export function buildProductionApp(): App {
  const repoRoot = process.cwd();
  const homeDir = os.homedir();

  const config = resolveConfig({
    repoRoot,
    homeDir,
    repoFileContents: readRepoConfigFile(repoRoot),
    userFileContents: readUserConfigFile(homeDir),
    env: process.env,
  });

  // Every credential source is probed once, here: env vars, Claude Code's
  // credential store, and the `ant auth login` profile directory. Only the
  // resulting presence flags travel downstream — no token leaves this call.
  const auth = gatherAuthFacts(
    {
      homeDir,
      env: process.env,
      platform: process.platform,
      account: os.userInfo().username,
      now: Date.now(),
    },
    config.auth.method,
  );

  return createApp({
    config,
    credentials: {
      selected: auth.selected,
      usable: auth.usable,
      subscriptionType: auth.subscriptionType,
      rateLimitTier: auth.rateLimitTier,
      subscriptionExpired: auth.subscriptionExpired,
      pinned: config.auth.method !== AUTH_METHOD_AUTO,
    },
    ports: {
      model: new FixtureModelProvider({}, MODELS),
      clock: systemClock,
      forge: stubForge,
    },
  });
}
