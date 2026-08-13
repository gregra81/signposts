// @ts-check
// Per-module mutation break thresholds.
//
// Stryker's `thresholds.break` is a single global number. 16-build-plan.md
// Tier 3 asks for different floors per module, because not all of the core
// carries the same risk — a surviving mutant in redact/ is a secret pattern
// the tests do not actually check, while one in gutter/ degrades quality.
// This script reads Stryker's JSON report and applies the table.
//
// Runs as `pnpm mutate:gate`, after `pnpm mutate`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPORT_PATH = "reports/mutation/mutation.json";

/**
 * Break threshold per `src/core/` module, from 16-build-plan.md Tier 3.
 * Longest matching prefix wins, so a nested module can override its parent.
 * @type {ReadonlyArray<{ module: string, break: number }>}
 */
const THRESHOLDS = [
  { module: "src/core/redact", break: 95 },
  { module: "src/core/paths", break: 95 },
  { module: "src/core/gate", break: 95 },
  { module: "src/core/eligibility", break: 95 },
  { module: "src/core/transcript", break: 95 },
  { module: "src/core/signpost", break: 95 },
  { module: "src/core/gutter", break: 95 },
  { module: "src/core/retrieval", break: 95 },
  { module: "src/core/pr", break: 95 },
  { module: "src/core/config", break: 95 },
  { module: "src/core/contracts", break: 95 },
  { module: "src/core/git", break: 95 },
  { module: "src/core/cli", break: 80 },
  { module: "src/core/init", break: 80 },
  { module: "src/core/doctor", break: 80 },
  { module: "src/core/errors", break: 80 },
];

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

  if (files.length === 0) {
    console.log("mutation-gate: no mutated files in the report, nothing to gate.");
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

  if (byModule.size === 0) {
    console.log(
      "mutation-gate: no mutants in any module with a per-module threshold.",
    );
    return;
  }

  let failed = false;
  for (const [module, bucket] of [...byModule].sort()) {
    const value = score(bucket.mutants);
    if (value === undefined) {
      console.log(`  ${module}  no scoreable mutants  (break ${bucket.break})`);
      continue;
    }
    const ok = value >= bucket.break;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${module}  ${value.toFixed(2)}  (break ${bucket.break})`,
    );
  }

  if (failed) {
    console.error("mutation-gate: a module is below its break threshold.");
    process.exitCode = 1;
  }
}

await main();
