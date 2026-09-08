// The review prompt itself: one operation on screen, one keypress, next.
//
// Plain readline over the Stdio bundle, exactly like the consent prompt
// (../init/consent-prompt.ts) and for the same reason — this is a terminal a
// person is sitting at, not a port a test needs to fake at the port level.
// What the typed line means, and what an edit does to the operation, are pure
// and live in src/core/review/answer.ts; this module only asks.
//
// Two rules hold this together, and both are about not deciding for the
// developer:
//
//   - An unrecognised answer re-asks. It is never read as "skip", because a
//     mistyped key would then quietly leave the proposal in the queue while
//     the screen scrolled past it.
//   - EOF is `quit`, not `accept`, and not an unrecognised answer either — a
//     closed stdin re-asked forever would spin. Nobody is there, and the safe
//     reading of nobody-is-there is that nothing was decided. The command
//     refuses to run non-interactively anyway; this is the second lock on the
//     same door.
//
// An edit is re-parsed against `operationSchema` before it is accepted, so a
// claim over CLAIM_MAX_CHARS is caught here — where the reviewer can retype
// it — rather than at the resume, where it would throw out the whole batch.

import { createInterface, type Interface } from "node:readline";
import { operationSchema, type HumanDecision, type Operation } from "../../core/contracts/graph.ts";
import { operationKey } from "../../core/graph/decisions.ts";
import { summariseIssues } from "../../core/errors/format-zod-error.ts";
import {
  editableText,
  isEditable,
  parseReviewChoice,
  REVIEW_CHOICES,
  withEdits,
} from "../../core/review/answer.ts";
import { renderItem, type ReviewItem } from "../../core/review/render.ts";

export interface ReviewPromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface ReviewPromptInput {
  items: readonly ReviewItem[];
  io: ReviewPromptIo;
  /** When the decisions were made — recorded on each one. */
  now: Date;
}

export interface ReviewPromptResult {
  /** Keyed by `operationKey`, ready for the resume. Skipped items are absent. */
  decisions: Record<string, HumanDecision>;
  /** Whether the reviewer stopped early. What follows the quit is untouched. */
  quit: boolean;
}

const KEYS = "[a]ccept [r]eject [e]dit [s]kip [q]uit";
const KEYS_NO_EDIT = "[a]ccept [r]eject [s]kip [q]uit";
const KEEP = " (Enter keeps it)";

/** Asks about each operation in turn, and returns what was decided. */
export async function promptForReview(input: ReviewPromptInput): Promise<ReviewPromptResult> {
  const rl = createInterface({ input: input.io.input, output: input.io.output });
  const ask = asker(rl, input.io.output);
  const decisions: Record<string, HumanDecision> = {};

  try {
    for (const item of input.items) {
      const decision = await decide(item, ask, input);
      if (decision === undefined) {
        return { decisions, quit: true };
      }
      if (decision !== REVIEW_CHOICES.skip) {
        decisions[operationKey(item.operation)] = decision;
      }
    }
  } finally {
    rl.close();
  }

  return { decisions, quit: false };
}

/**
 * One operation, until it is answered.
 *
 * Undefined means quit. `"skip"` is returned as itself rather than as a
 * decision, because a skipped operation must reach the resume as an absence.
 */
async function decide(
  item: ReviewItem,
  ask: Ask,
  input: ReviewPromptInput,
): Promise<HumanDecision | typeof REVIEW_CHOICES.skip | undefined> {
  const editable = isEditable(item.operation);

  for (;;) {
    input.io.output.write(`\n${renderItem(item)}\n`);
    const answer = await ask(`${editable ? KEYS : KEYS_NO_EDIT} `);
    if (answer === undefined) {
      return undefined;
    }
    const choice = parseReviewChoice(answer, editable);

    if (choice === REVIEW_CHOICES.quit) {
      return undefined;
    }
    if (choice === REVIEW_CHOICES.skip) {
      return REVIEW_CHOICES.skip;
    }
    if (choice === REVIEW_CHOICES.accept || choice === REVIEW_CHOICES.reject) {
      return { decision: choice, decidedAt: input.now.toISOString() };
    }
    if (choice === REVIEW_CHOICES.edit) {
      const edited = await editOperation(item.operation, ask, input.io.output);
      if (edited !== undefined) {
        return { decision: REVIEW_CHOICES.edit, edited, decidedAt: input.now.toISOString() };
      }
      // A rejected edit falls through and asks again, with the original still
      // on screen: the reviewer has not decided anything yet.
      continue;
    }
    input.io.output.write(`Not one of ${editable ? KEYS : KEYS_NO_EDIT}.\n`);
  }
}

/**
 * The reviewer's replacement wording, or undefined if it does not parse.
 *
 * Only the two fields a review is about. Everything else — the id, the
 * category, the scope, the provenance — is carried over untouched, which is
 * also what keeps the edit inside the operation it answers.
 */
async function editOperation(
  operation: Operation,
  ask: Ask,
  output: NodeJS.WritableStream,
): Promise<Operation | undefined> {
  const current = editableText(operation);
  const claim = await ask(`claim${KEEP}\n  ${current.claim ?? ""}\n> `);
  const evidence = await ask(`why${KEEP}\n  ${current.evidence ?? ""}\n> `);

  const edited = withEdits(operation, {
    ...(claim === undefined || claim.trim() === "" ? {} : { claim: claim.trim() }),
    ...(evidence === undefined || evidence.trim() === "" ? {} : { evidence: evidence.trim() }),
  });

  const parsed = operationSchema.safeParse(edited);
  if (!parsed.success) {
    output.write(`That is not a usable operation: ${summariseIssues(parsed.error.issues)}\n`);
    return undefined;
  }
  return parsed.data;
}

/** One question, answered — or `undefined` once stdin has ended. */
type Ask = (question: string) => Promise<string | undefined>;

/**
 * Asks, and tells EOF apart from an empty line.
 *
 * Lines are queued as they arrive rather than read one `rl.question` at a
 * time. Between two questions this loop does asynchronous work — parsing an
 * edit, resuming a thread — and readline goes on emitting `line` for whatever
 * is already buffered; with no question outstanding those lines are dropped.
 * Against a terminal that is invisible, because a person types the next line
 * after seeing the prompt. Against anything else it silently eats every
 * answer but the first.
 *
 * `undefined` is the end of input, and the caller reads it as quit. Resolving
 * with `""` instead would be indistinguishable from a bare Enter, and `decide`
 * re-asks an unrecognised answer — which against a closed stream is a loop
 * printing the same prompt forever.
 */
function asker(rl: Interface, output: NodeJS.WritableStream): Ask {
  const queued: string[] = [];
  let waiting: ((line: string | undefined) => void) | undefined;
  let closed = false;

  const answer = (line: string | undefined): boolean => {
    const resolve = waiting;
    if (resolve === undefined) {
      return false;
    }
    waiting = undefined;
    resolve(line);
    return true;
  };

  rl.on("line", (line: string) => {
    if (!answer(line)) {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    answer(undefined);
  });

  return (question) =>
    new Promise<string | undefined>((resolve) => {
      output.write(question);
      const next = queued.shift();
      if (next !== undefined) {
        resolve(next);
        return;
      }
      if (closed) {
        resolve(undefined);
        return;
      }
      waiting = resolve;
    });
}
