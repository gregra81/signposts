// @ts-check
// Which of the two trees `signpost.js` runs.
//
// Plain JavaScript on purpose: an installed copy lives under `node_modules`,
// where Node refuses to strip types, and this module is imported before
// anything else has run.
//
// The rule is that constraint, not a preference. An installed copy must run
// `dist/`; everywhere else `src/` runs directly and is what the developer
// edited.
//
// It used to be "dist/ if it is there, src/ otherwise", which is wrong in the
// one place both are: a checkout. `pnpm test:install` packs the repo and
// `prepack` builds, so one run of the install test leaves a `dist/` behind and
// freezes `signpost` in that checkout at that moment — silently, `doctor`
// included, which goes on reporting ready. On 2026-09-23 a real run made
// against a two-week-old build showed the critic receiving no conventions,
// which reads exactly like the bug PR #54 had fixed
// (19-value-to-a-user.md, "Driving the loop end to end").
//
// PURE: a path and two booleans in, a name out. The caller does the looking.

/** Where a package's code lives once npm has installed it. */
const INSTALLED_MARKER = "node_modules";

/**
 * `"src"`, `"dist"`, or null when neither tree is present.
 *
 * `root` is the package root — the directory holding `bin/` — so a checkout
 * with its own `node_modules` below it is still a checkout.
 *
 * @param {string} root
 * @param {{hasDist: boolean, hasSrc: boolean}} trees
 * @returns {"src" | "dist" | null}
 */
export function chooseTree(root, { hasDist, hasSrc }) {
  const installed = root.split("/").includes(INSTALLED_MARKER);
  if (installed || !hasSrc) {
    return hasDist ? "dist" : hasSrc ? "src" : null;
  }
  return "src";
}
