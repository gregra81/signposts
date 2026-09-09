// The pull request a run opens, as text: title, labels, and the section each
// session adds to the body (06-review-and-pr.md, "PR mechanics").
//
// The body exists to answer "why does it think this?" without reading the
// diff, so every row carries the evidence line and the session that produced
// it. One section per session, appended rather than replacing what earlier
// sessions wrote: the branch is long-lived and a reviewer coming back to it
// needs the whole story, not the last commit's half.
//
// Pure: operations in, markdown out.

import { OPERATION_TAGS, type Operation } from "../contracts/graph.ts";

/** Stable across the life of the branch — the PR is reused, not reopened. */
export const PR_TITLE = "signposts: knowledge proposed for review";

export const PR_LABEL = "signposts";

/** Added when the PR carries a claim that replaced an existing one. */
export const PR_LABEL_CONTRADICTION = "has-contradiction";

const HEADING = "## Proposed";

/**
 * What an operation that carries no claim of its own says instead. Only two
 * kinds reach it: a reinforce changes nothing but provenance, and a retire
 * names what it removes.
 */
const SUMMARY = {
  [OPERATION_TAGS.reinforce]: "another session said the same thing",
  [OPERATION_TAGS.retire]: "removes an existing signpost",
} as const;

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function row(operation: Operation): string {
  const cells =
    operation.op === OPERATION_TAGS.add
      ? [operation.op, operation.signpost.id, operation.signpost.claim, operation.signpost.evidence]
      : operation.op === OPERATION_TAGS.supersede
        ? [
            operation.op,
            `${operation.id} → ${operation.replacement.id}`,
            operation.replacement.claim,
            operation.replacement.evidence,
          ]
        : operation.op === OPERATION_TAGS.refine
          ? [operation.op, operation.id, operation.claim ?? "(scope only)", operation.evidence ?? ""]
          : [operation.op, operation.id, SUMMARY[operation.op], ""];

  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

/**
 * The order rows appear in, whatever order the graph emitted them: grouped by
 * operation (06-review-and-pr.md, "Body"). A reviewer reads a table of eight
 * proposals by kind — every new claim together, then everything that changes
 * something already recorded — because those are different questions and
 * interleaving them makes the reviewer re-ask which one they are answering.
 *
 * Taken from OPERATION_TAGS rather than listed again here, so an operation
 * added to the union cannot go missing from the body by being left out of a
 * second list.
 */
const OPERATION_ORDER = Object.values(OPERATION_TAGS);

/** Stable within a group: two adds stay in the order the session produced them. */
function byOperation(operations: readonly Operation[]): Operation[] {
  return OPERATION_ORDER.flatMap((op) => operations.filter((operation) => operation.op === op));
}

/**
 * One session's contribution to the body.
 *
 * A session that proposed nothing still gets a line. The alternative is a
 * commit in the history with no explanation in the body, which reads as
 * something having gone missing.
 */
export function prSection(sessionId: string, operations: readonly Operation[]): string {
  const heading = `### Session \`${sessionId}\``;
  if (operations.length === 0) {
    return `${heading}\n\nNothing proposed.\n`;
  }
  const rows = byOperation(operations).map(row).join("\n");
  return `${heading}\n\n| op | signpost | claim | why |\n| --- | --- | --- | --- |\n${rows}\n`;
}

/**
 * The body after this session's section is added.
 *
 * `existing` is what the open PR already says, empty for a PR about to be
 * opened. Sections are only ever appended, so a reviewer reading top to
 * bottom sees the branch in the order it was built.
 */
export function prBody(existing: string, section: string): string {
  const trimmed = existing.trim();
  if (trimmed === "") {
    return `${HEADING}\n\nProposed by signposts from your own Claude Code sessions. Nothing here is merged automatically.\n\n${section}`;
  }
  return `${trimmed}\n\n${section}`;
}

/** `signposts`, plus `has-contradiction` when something was replaced. */
export function prLabels(operations: readonly Operation[]): string[] {
  const replaced = operations.some((operation) => operation.op === OPERATION_TAGS.supersede);
  return replaced ? [PR_LABEL, PR_LABEL_CONTRADICTION] : [PR_LABEL];
}

/** `signposts: 2 from session 01J9F…` (06-review-and-pr.md). */
export function commitMessage(sessionId: string, operations: readonly Operation[]): string {
  return `signposts: ${String(operations.length)} from session ${sessionId}`;
}
