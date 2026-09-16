// `signpost doctor` (15-spec.md user story 72, R5): turns raw, already-
// gathered facts into the report lines printed to stdout. Every fact (node
// version, `gh` output, cache/db/hook presence) is gathered by
// src/io/doctor/*; this module only decides what each fact means and how to
// phrase it — no filesystem, no subprocess, no env access.

export interface GhAuthFact {
  /** false when the `gh` binary itself could not be spawned (e.g. ENOENT). */
  installed: boolean;
  /** Only meaningful when `installed` is true. */
  authenticated: boolean;
}

export type DbIntegrityStatus = "ok" | "corrupt" | "no-database";

/**
 * What the embedding model's cache holds — the question being "can a run
 * embed?", not "does a directory exist".
 *
 * `vendored` is the offline setup of 15-spec.md's story 57: `local_model_path`
 * points at a flat copy of the model, and transformers.js resolves against it
 * and ignores the pinned revision entirely, so the shared cache is beside the
 * point there. Reporting that setup as a cold cache would send a developer to
 * download a model they already have.
 *
 * `unavailable` is the other half of that story, and the reason the remote
 * policy is an input here: with `retrieval.allow_remote_models` false and
 * nothing on disk, transformers.js does not download, it throws
 * ("`env.allowRemoteModels=false` and file was not found locally"). Calling
 * that cold promises a download that cannot happen — a self-diagnosis that
 * sends the developer to wait for nothing.
 */
export type ModelCacheStatus = "warm" | "cold" | "vendored" | "unavailable";

export interface ModelCacheFacts {
  /** `retrieval.local_model_path` is set and the model's weights are under it. */
  vendored: boolean;
  /** The pinned `<repo-id>@<revision>`'s weights are in the shared cache. */
  pinnedRevisionCached: boolean;
  /** `retrieval.allow_remote_models` — whether a cold cache can still fill itself. */
  remoteAllowed: boolean;
}

export function classifyModelCache(facts: ModelCacheFacts): ModelCacheStatus {
  if (facts.vendored) {
    return "vendored";
  }
  if (facts.pinnedRevisionCached) {
    return "warm";
  }
  return facts.remoteAllowed ? "cold" : "unavailable";
}

/** `pragmaResult` is the raw `PRAGMA integrity_check` row text; only "ok" means healthy. */
export function classifyDbIntegrity(dbExists: boolean, pragmaResult: string | undefined): DbIntegrityStatus {
  if (!dbExists) {
    return "no-database";
  }
  return pragmaResult === "ok" ? "ok" : "corrupt";
}

export function isNodeVersionSupported(currentMajor: number, minMajor: number): boolean {
  return currentMajor >= minMajor;
}

/**
 * Reads a settings file's `hooks.SessionStart` for an entry whose
 * command mentions "signpost" (Claude Code's hook shape: an array of
 * `{ hooks: [{ command }] }` groups per matcher — see 07-triggering-and-ux.md
 * "Distribution"). It takes already-parsed JSON so it never throws on a
 * malformed or missing file.
 *
 * A settings file is no longer the only way the hook is installed — see
 * `detectSignpostPlugin` below.
 */
export function detectSignpostSessionStartHook(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) {
    return false;
  }
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) {
    return false;
  }
  const sessionStart = (hooks as Record<string, unknown>).SessionStart;
  if (!Array.isArray(sessionStart)) {
    return false;
  }
  return sessionStart.some((group) => {
    if (typeof group !== "object" || group === null) {
      return false;
    }
    const entries = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(entries)) {
      return false;
    }
    return entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).command === "string" &&
        ((entry as Record<string, unknown>).command as string).includes("signpost"),
    );
  });
}

/** The plugin's own name, as `.claude-plugin/plugin.json` declares it. */
export const PLUGIN_NAME = "signposts";

/**
 * Reads a settings file's `enabledPlugins` for this plugin.
 *
 * Since the plugin landed, `hooks/hooks.json` registers the SessionStart hook
 * and no settings file mentions it at all — so `detectSignpostSessionStartHook`
 * reported "not installed" to every plugin user about a hook firing on every
 * single session (18-end-to-end-gaps.md, "Spec drift"). That is the shape of
 * wrong that 07-triggering-and-ux.md's "turns a bug report into a
 * self-diagnosis" cannot survive: it sends someone to debug a thing that works.
 *
 * The key is `"<plugin>@<marketplace>"` mapped to a boolean, and the
 * marketplace half is whatever the plugin was installed from, so only the name
 * before the `@` is matched. `false` is a plugin explicitly turned off, which
 * is not an install.
 *
 * A plugin loaded with `--plugin-dir` leaves no trace in any settings file and
 * is invisible here. That is a development-time flag, and the report says
 * "not found in settings" rather than "not installed" for exactly that reason.
 */
export function detectSignpostPlugin(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) {
    return false;
  }
  const enabled = (settings as Record<string, unknown>).enabledPlugins;
  if (typeof enabled !== "object" || enabled === null) {
    return false;
  }
  return Object.entries(enabled as Record<string, unknown>).some(
    ([key, value]) => value === true && key.split("@")[0] === PLUGIN_NAME,
  );
}

/** How the SessionStart hook reached this machine, if it did. */
export type HookInstall = "plugin" | "settings" | "absent";

/**
 * `git config user.email`, and the `owner/name` the `origin` remote yields.
 *
 * Both are `null` when absent, and both stop the loop outright: without the
 * email, `sessions`, `run` and `resume` exit 1; without an origin, `init` and
 * `index` do. Their messages are good — they just arrive from the wrong
 * command, on a fresh container or a new machine, which is where `doctor` is
 * the command someone actually runs (18-end-to-end-gaps.md, item 7).
 */
export interface GitFacts {
  authorEmail: string | null;
  repo: string | null;
}

/**
 * Whether this repo has consented to spend tokens (07-triggering-and-ux.md,
 * "First-run consent"). `unknown` when it cannot be read: no origin gives no
 * key to look it up under, and an unreadable database has nowhere to look.
 * Both of those are reported, and blocked on, by their own lines.
 */
export type ConsentFact = "given" | "not-given" | "unknown";

/**
 * The status line `init` installed, if it did (19-value-to-a-user.md item 6).
 * The command holds an absolute path into one install, so a Node upgrade or an
 * uninstall leaves it pointing at nothing — and a command that is not there
 * exits non-zero, which blanks the whole bar, a wrapped status line with it.
 */
export type StatusLineFact = { state: "ok" } | { state: "absent" } | { state: "missing"; scriptPath: string };

export interface DoctorFacts {
  nodeMajorVersion: number;
  nodeMinVersion: number;
  gh: GhAuthFact;
  modelCache: ModelCacheStatus;
  dbIntegrity: DbIntegrityStatus;
  hook: HookInstall;
  git: GitFacts;
  consent: ConsentFact;
  statusLine: StatusLineFact;
  /**
   * `lastError` from status.json: what the detached worker last failed at. Its
   * stderr goes to /dev/null, and the status line tells the developer to run
   * doctor about it — which, until this, read nothing at all.
   */
  lastError: string | null;
}

function nodeLine(facts: DoctorFacts): string {
  const ok = isNodeVersionSupported(facts.nodeMajorVersion, facts.nodeMinVersion);
  return `node: v${facts.nodeMajorVersion} (floor v${facts.nodeMinVersion}) — ${ok ? "ok" : "below floor"}`;
}

function ghLine(facts: DoctorFacts): string {
  if (!facts.gh.installed) {
    return "gh: not found on PATH";
  }
  return facts.gh.authenticated ? "gh: authenticated" : "gh: installed, not authenticated";
}

function modelCacheLine(facts: DoctorFacts): string {
  switch (facts.modelCache) {
    case "warm":
      return "embedding model cache: warm — the pinned model is cached, retrieval works offline";
    case "vendored":
      return "embedding model cache: vendored — retrieval loads from retrieval.local_model_path";
    case "cold":
      return "embedding model cache: cold — the first run downloads the model (~23MB, once per machine)";
    case "unavailable":
      return "embedding model cache: unavailable — retrieval.allow_remote_models is false and nothing is cached; vendor a copy and set retrieval.local_model_path";
  }
}

function dbIntegrityLine(facts: DoctorFacts): string {
  switch (facts.dbIntegrity) {
    case "no-database":
      return "database: no database yet";
    case "ok":
      return "database: ok";
    case "corrupt":
      return "database: integrity check failed";
  }
}

function hookLine(facts: DoctorFacts): string {
  switch (facts.hook) {
    case "plugin":
      return "session-start hook: installed — by the signposts plugin";
    case "settings":
      return "session-start hook: installed — in a Claude Code settings file";
    case "absent":
      // Not `signpost init`, which this line used to name: init writes the
      // skill, the pointer and the status line, and has never installed the
      // hook. The hook arrives with the plugin, so a person following the old
      // advice re-ran init and read the same line again.
      return "session-start hook: not found in settings or in an enabled plugin — install the plugin inside Claude Code with `/plugin marketplace add gregra81/signposts` then `/plugin install signposts@signposts`";
  }
}

/** A git fact as its value, or as the reason its absence stops the loop. */
function gitLine(label: string, value: string | null, absent: string): string {
  return `${label}: ${value ?? absent}`;
}

function consentLine(facts: DoctorFacts): string {
  switch (facts.consent) {
    case "given":
      return "consent: given";
    case "not-given":
      return "consent: not given — run `signpost init`";
    case "unknown":
      return "consent: unknown — needs an origin remote and a readable database to check";
  }
}

function statusLineLine(facts: DoctorFacts): string {
  switch (facts.statusLine.state) {
    case "ok":
      return "status line: installed";
    case "absent":
      return "status line: not installed by signposts";
    case "missing":
      return (
        `status line: points at ${facts.statusLine.scriptPath}, which is gone — it blanks your whole status bar, ` +
        "including any status line it wraps; run `signpost init` to repoint it"
      );
  }
}

/**
 * What stops `signpost run` outright, in report order (19-value-to-a-user.md
 * item 4). Everything else doctor says degrades a run or a search without
 * stopping it — a cold cache downloads, a missing `gh` leaves the work on a
 * branch, a failed reindex leaves search stale — and is reported, not failed.
 */
export function blockers(facts: DoctorFacts): string[] {
  return [
    ...(isNodeVersionSupported(facts.nodeMajorVersion, facts.nodeMinVersion) ? [] : ["node below floor"]),
    ...(facts.git.authorEmail === null ? ["no git author"] : []),
    ...(facts.git.repo === null ? ["no origin remote"] : []),
    ...(facts.dbIntegrity === "corrupt" ? ["database corrupt"] : []),
    ...(facts.consent === "not-given" ? ["no consent"] : []),
  ];
}

/** One line per fact, in the order 15-spec.md's story 72 lists them, then the verdict. */
export function buildDoctorReport(facts: DoctorFacts): string[] {
  const blocked = blockers(facts);
  return [
    nodeLine(facts),
    gitLine(
      "git author",
      facts.git.authorEmail,
      "git config user.email is not set — `sessions`, `run` and `resume` all refuse to run without it",
    ),
    gitLine(
      "git origin",
      facts.git.repo,
      "no 'origin' remote, or none that yields an owner/name — `init` and `index` refuse to run without it",
    ),
    ghLine(facts),
    modelCacheLine(facts),
    dbIntegrityLine(facts),
    hookLine(facts),
    consentLine(facts),
    statusLineLine(facts),
    `last background error: ${facts.lastError ?? "none"}`,
    blocked.length === 0 ? "ready: nothing blocks `signpost run`" : `blocked: ${blocked.join(", ")}`,
  ];
}
