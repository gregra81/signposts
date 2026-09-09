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
 * embed without the network?", not "does a directory exist".
 *
 * `vendored` is the offline setup of 15-spec.md's story 57: `local_model_path`
 * points at a flat copy of the model, and transformers.js resolves against it
 * and ignores the pinned revision entirely, so the shared cache is beside the
 * point there. Reporting that setup as a cold cache would send a developer to
 * download a model they already have.
 */
export type ModelCacheStatus = "warm" | "cold" | "vendored";

export interface ModelCacheFacts {
  /** `retrieval.local_model_path` is set and the model is under it. */
  vendored: boolean;
  /** The pinned `<repo-id>@<revision>` is in the shared cache, weights and all. */
  pinnedRevisionCached: boolean;
}

export function classifyModelCache(facts: ModelCacheFacts): ModelCacheStatus {
  if (facts.vendored) {
    return "vendored";
  }
  return facts.pinnedRevisionCached ? "warm" : "cold";
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
 * "Distribution"). Nothing installs this hook yet, so this is expected to
 * report absent until that lands; it takes already-parsed JSON so it never
 * throws on a malformed or missing file.
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

export interface DoctorFacts {
  nodeMajorVersion: number;
  nodeMinVersion: number;
  gh: GhAuthFact;
  modelCache: ModelCacheStatus;
  dbIntegrity: DbIntegrityStatus;
  hookInstalled: boolean;
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
  return `session-start hook: ${facts.hookInstalled ? "installed" : "not installed"}`;
}

/** One line per fact, in the order 15-spec.md's story 72 lists them. */
export function buildDoctorReport(facts: DoctorFacts): string[] {
  return [
    nodeLine(facts),
    ghLine(facts),
    modelCacheLine(facts),
    dbIntegrityLine(facts),
    hookLine(facts),
  ];
}
