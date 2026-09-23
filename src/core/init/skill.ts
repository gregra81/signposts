// The skill `signpost init` installs into the repository, and the only place
// the run loop is described.
//
// It is a constant rather than a file copied from the package because it has
// to stay in step with the CLI it drives: the commands, the two halts and the
// shape of a reply are this repo's contract, and a skill that has drifted
// from them fails in the middle of a run with half a session extracted.
//
// Two instructions in it carry the design and are not stylistic:
//
//   - The loop runs in a subagent. A run's prompts are the transcript, the
//     candidates and their neighbours, several thousand tokens per session,
//     and putting that in the developer's own context is the tool taking the
//     workspace it was supposed to serve.
//
//   - A review halt comes back to the main session. Only the developer can
//     answer it, and a subagent cannot ask them. `signpost review` is the
//     developer's own way to answer one later, at their terminal; the skill
//     is told not to run it, and the command refuses a stdin that is not a
//     terminal anyway.
//
//   - Sessions run one at a time. Each session's proposals are indexed for the
//     next one to classify against (06-review-and-pr.md, "Reindex within a
//     run"), and that only works in order. "One per session" alone read as
//     permission to start them all at once, and an agent did: two sessions on
//     gregra81/earnest each added the same signpost. `recheck_neighbours`
//     catches most of that now, but not two sessions that settle within
//     seconds of each other.

export const SKILL_DIR = ".claude/skills/signposts";
export const SKILL_FILENAME = "SKILL.md";

export const SKILL_DOC = `---
name: signposts
description: Turn the corrections in your idle Claude Code sessions into reviewed knowledge in this repo. Use when the user asks to run signposts, extract signposts, capture what a session taught, or review pending signpost proposals.
---

# signposts

signposts reads this repo's finished Claude Code transcripts and proposes durable
team knowledge — the things you corrected it about, which cannot be read off the
code — as markdown in \`.signposts/\`, on a branch, and in a pull request once the
developer says so. It does no reasoning of its own: it pauses and asks *you* for
each judgement, then carries on.

## The loop

Every command prints one JSON object. A run advances one halt at a time.

1. \`signpost sessions\` lists what is eligible (idle 24h+, not already processed).
   Stop here and say so if the list is empty.
2. **Delegate the rest to a subagent, one per session, one session at a time.**
   The prompts below are thousands of tokens each and belong in a subagent's
   context, not the user's. Give the subagent this file and the session id, and
   start the next subagent only after this one comes back. Never run sessions in
   parallel: each session compares its candidates against what the earlier ones
   proposed, and two sessions running at once can each propose the same signpost.
3. \`signpost run --session <id>\` — add \`--first\` for the first session of this
   run only. It clears what the previous run left pending.
4. Read \`status\`:
   - \`waiting\` — answer every entry in \`pending\` (below), then
     \`signpost resume --session <id> --content-hash <hash> --replies <file>\`
     and read \`status\` again. Take \`<hash>\` from \`contentHash\` in the very
     output you are answering. It is half of the thread id, and passing it back
     is what stops it being re-derived from the transcript: the developer may
     have carried on in that Claude Code session since the halt, and a session
     identified by a different hash is a different thread.
   - \`finished\` — \`proposed\` lists what was committed to the local branch
     named in \`commit\`. Nothing is pushed yet. Move to the next session.
   - \`reExtracted\`, on any status, means the critic rejected most of a batch and
     sent it back to \`extract\` that many times. The proposals are a second pass,
     which is why there may be fewer of them. Tell the user in one line.
   - \`skipped\` — the transcript can never be extracted (empty, only subagent
     lines, or a redactor failed on it). \`reason\` says which. It is recorded and
     will not be offered again. Mention it in one line and move to the next
     session; it is not a failure.

**Exit codes.** \`5\` is not a failure: it means the run halted on a
\`human_review\`. Only \`1\` is a failure.

## Answering a halt

Each \`pending\` entry is \`{ "id": "...", "request": { ... } }\`. Write your answers
to a JSON file as \`{ "replies": { "<id>": <answer>, ... } }\` — keyed by id, because
several may be pending at once and they are not interchangeable.

**\`"kind": "model_call"\`** — the request carries \`node\`, \`system\`, \`user\` and
\`schema\`. Follow \`system\` as the instructions, \`user\` as the input, and reply with
JSON that satisfies \`schema\` exactly. Nothing else validates it: a reply of the
wrong shape fails the resume.

- \`extract\` — propose candidate signposts from the transcript.
- \`critic\` — judge those candidates sceptically.
- \`classify\` — decide how one candidate relates to what is already recorded.
- \`resolve\` — adjudicate a contradiction. Read the repository to settle it: the
  code, \`git log\`, whatever the claim is about. \`undecidable\` is a real answer
  and routes to the developer, so use it rather than guessing.

**\`"kind": "human_review"\`** — do not answer this yourself, and do not let a
subagent answer it. Return to the main session, show the developer each entry in
\`needsHuman\` (the operation and why it was gated), and ask them to accept, reject
or edit each one. Then resume with
\`{ "<id>": { "<key>": { "decision": "accept", "decidedAt": "<ISO 8601>" } } }\`,
where \`<key>\` is the \`key\` field on that \`needsHuman\` entry — copied, not
derived. A key naming no outstanding operation is an error, not a silent skip.

The developer can also answer these later themselves, by typing
\`signpost review\` at their own terminal. **Never run that command**, in the main
session or a subagent: it is a prompt for a person, and it refuses a stdin that
is not a terminal.

**Every operation in \`needsHuman\` needs an entry.** A rejected one is
\`"decision": "reject"\`, not an omission — an operation you leave out has not been
decided, so the review halts again on it and the session cannot reach the commit.
Rejected operations are dropped; nothing merges without a decision on each.

## What to tell the user at the end

Which sessions ran and what was proposed. If none of them committed anything
(every \`commit\` was null), say so and stop: there is nothing to publish.

Otherwise ask whether to publish it: push the branch and open the pull request, or
add to it when \`commit.pr\` names one. **Ask, and wait for the answer.** The run
committed locally and nothing has left this machine; publishing is the
developer's call, not yours.

On yes, run \`signpost publish\` and report the pull request it names. \`status:
"nothing"\` means no run committed anything since the last publish. Exit \`4\` is
not a failure: the branch is committed and no pull request carries it yet, and
\`publish.manualCommand\` is the command that finishes it — show it as it is.

On no, say that the commits stay on the branch and the next run adds to it, and
that \`signpost publish\` pushes them whenever they want. Nothing merges
automatically either way; the PR is where the team reviews it.
`;
