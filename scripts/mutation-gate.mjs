// @ts-check
// Per-module mutation break thresholds.
//
// Stryker's `thresholds.break` is a single global number applied to the whole
// run, which lets a well-covered module carry a weak one. This script reads
// Stryker's JSON report and applies the floor per module instead, so every
// module clears the bar on its own. It also fails on a mutated module that
// has no entry below, so a new module cannot slip in ungated.
//
// Runs as `pnpm mutate:gate`, after `pnpm mutate`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPORT_PATH = "reports/mutation/mutation.json";

/**
 * Break threshold per mutated module. Uniform at 95 across src/core; the
 * shape is kept so one module can be given a different floor without
 * reworking the script. Longest matching prefix wins, so a nested module can
 * override its parent.
 * @type {ReadonlyArray<{ module: string, break: number }>}
 */
const THRESHOLDS = [
  { module: "src/core/redact", break: 95 },
  { module: "src/core/gate", break: 95 },
  { module: "src/core/graph", break: 95 },
  { module: "src/core/eligibility", break: 95 },
  { module: "src/core/transcript", break: 95 },
  { module: "src/core/signpost", break: 95 },
  { module: "src/core/gutter", break: 95 },
  { module: "src/core/retrieval", break: 95 },
  { module: "src/core/pr", break: 95 },
  { module: "src/core/config", break: 95 },
  { module: "src/core/contracts", break: 95 },
  { module: "src/core/git", break: 95 },
  { module: "src/core/cli", break: 95 },
  { module: "src/core/init", break: 95 },
  { module: "src/core/doctor", break: 95 },
  { module: "src/core/errors", break: 95 },
  { module: "src/core/prompts", break: 95 },
  { module: "src/core/review", break: 95 },
  // The structured-output schema adapter. A surviving mutant here is a
  // keyword wrongly kept or wrongly stripped, which is a 400 on every call to
  // the node whose schema it mangled.
  { module: "src/core/model", break: 95 },
  // The graph wiring. Held at 100 rather than 95: it is thin, every branch in
  // it is a routing decision, and it is the half of the extraction graph that
  // src/core's pure functions cannot cover.
  { module: "src/graph", break: 100 },
];

/** Ignored by configuration — `ignoreStatic` drops static-initializer mutants. */
const IGNORED = "Ignored";

/** Mutant states that count as "the suite caught it". */
const KILLED = new Set(["Killed", "Timeout"]);
/** States that count against the score. Ignored/CompileError are excluded. */
const SURVIVED = new Set(["Survived", "NoCoverage"]);

/**
 * @param {string} file path as it appears in the Stryker report
 * @returns {{ module: string, break: number } | undefined}
 */
function thresholdFor(file) {
  const normalized = file.split(path.sep).join("/");
  let match;
  for (const entry of THRESHOLDS) {
    if (
      normalized.startsWith(`${entry.module}/`) &&
      (match === undefined || entry.module.length > match.module.length)
    ) {
      match = entry;
    }
  }
  return match;
}

/**
 * Mutation score the way Stryker computes it: killed / (killed + survived),
 * with ignored and compile-error mutants left out of both sides.
 * @param {ReadonlyArray<{ status: string }>} mutants
 * @returns {number | undefined} undefined when there is nothing to score
 */
function score(mutants) {
  let killed = 0;
  let survived = 0;
  for (const mutant of mutants) {
    if (KILLED.has(mutant.status)) killed += 1;
    else if (SURVIVED.has(mutant.status)) survived += 1;
  }
  const total = killed + survived;
  return total === 0 ? undefined : (killed / total) * 100;
}

async function main() {
  /** @type {string} */
  let raw;
  try {
    raw = await readFile(REPORT_PATH, "utf8");
  } catch {
    console.error(
      `mutation-gate: no report at ${REPORT_PATH}. Run \`pnpm mutate\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  /** @type {{ files?: Record<string, { mutants: Array<{ status: string }> }> }} */
  const report = JSON.parse(raw);
  const files = Object.entries(report.files ?? {});

  // A report with no files means the gate verified nothing. Stryker is
  // configured to mutate src/core and src/graph, so an empty report is a
  // broken run —
  // a truncated write, a crash between reporting and exit — not a project
  // with nothing to check. Passing here would report success for work that
  // never happened.
  if (files.length === 0) {
    console.error(
      `mutation-gate: ${REPORT_PATH} lists no files. Expected mutants under ` +
        "src/core and src/graph. Treating an empty report as a failed run " +
        "rather than a pass.",
    );
    process.exitCode = 1;
    return;
  }

  /** @type {Map<string, { module: string, break: number, mutants: Array<{ status: string }> }>} */
  const byModule = new Map();
  /** Mutated core files no threshold entry claims. @type {string[]} */
  const unclaimed = [];

  for (const [file, data] of files) {
    const threshold = thresholdFor(file);
    if (threshold === undefined) {
      if (data.mutants.length > 0) unclaimed.push(file);
      continue;
    }
    const bucket = byModule.get(threshold.module) ?? {
      ...threshold,
      mutants: [],
    };
    bucket.mutants.push(...data.mutants);
    byModule.set(threshold.module, bucket);
  }

  // Without this, renaming or adding a core module makes its mutants fall
  // through every prefix and the gate passes silently — an enforcement
  // mechanism that quietly stops enforcing is worse than none, because you
  // stop looking. Fail loudly and make someone update THRESHOLDS.
  if (unclaimed.length > 0) {
    console.error(
      "mutation-gate: these mutated files match no entry in THRESHOLDS.\n" +
        "Add them (or correct a renamed module path) in scripts/mutation-gate.mjs:\n" +
        unclaimed.map((file) => `  ${file}`).join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  // Same hole as the empty-report check above: the report had files, none of
  // them carried a mutant any threshold claims, so no module got scored. That
  // is a broken run, not a clean one.
  if (byModule.size === 0) {
    console.error(
      "mutation-gate: no mutants landed in any module with a per-module " +
        "threshold, so nothing was gated.",
    );
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const [module, bucket] of [...byModule].sort()) {
    const value = score(bucket.mutants);
    if (value === undefined) {
      // Nothing scoreable. Two different situations wear the same shape.
      //
      // A module of top-level constants (src/core/prompts) is all static
      // initializers, which `ignoreStatic` drops by design — there is no
      // assertion that could kill those mutants short of a second copy of
      // the value in a test. Skipping it is correct.
      //
      // Everything else scoring nothing — a compile error swallowing the
      // whole file — is a module nobody checked, and it must not read as
      // `ok` in the log.
      const staticOnly = bucket.mutants.some((mutant) => mutant.status === IGNORED);
      if (!staticOnly) failed = true;
      console.log(
        `  ${staticOnly ? "skip" : "FAIL"} ${module}  no scoreable mutants  (break ${bucket.break})`,
      );
      continue;
    }
    const ok = value >= bucket.break;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${module}  ${value.toFixed(2)}  (break ${bucket.break})`,
    );
  }

  if (failed) {
    console.error("mutation-gate: a module is below its break threshold, or was not scored at all.");
    process.exitCode = 1;
  }
}

await main();
