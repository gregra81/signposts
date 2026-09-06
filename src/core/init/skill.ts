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
//     answer it, and a subagent cannot ask them.

export const SKILL_DIR = ".claude/skills/signposts";
export const SKILL_FILENAME = "SKILL.md";

export const SKILL_DOC = `---
name: signposts
description: Turn the corrections in your idle Claude Code sessions into reviewed knowledge in this repo. Use when the user asks to run signposts, extract signposts, capture what a session taught, or review pending signpost proposals.
---

# signposts

signposts reads this repo's finished Claude Code transcripts and proposes durable
team knowledge — the things you corrected it about, which cannot be read off the
code — as markdown in \`.signposts/\`, on a branch, in a pull request. It does no
reasoning of its own: it pauses and asks *you* for each judgement, then carries on.

## The loop

Every command prints one JSON object. A run advances one halt at a time.

1. \`signpost sessions\` lists what is eligible (idle 24h+, not already processed).
   Stop here and say so if the list is empty. Keep each session's
   \`contentHash\` — it is half of the thread id, and every resume needs it.
2. **Delegate the rest to a subagent, one per session.** The prompts below are
   thousands of tokens each and belong in a subagent's context, not the user's.
   Give the subagent this file and the session id.
3. \`signpost run --session <id>\` — add \`--first\` for the first session of this
   run only. It clears what the previous run left pending.
4. Read \`status\`:
   - \`waiting\` — answer every entry in \`pending\` (below), then
     \`signpost resume --session <id> --content-hash <hash> --replies <file>\`
     and read \`status\` again. Pass the hash the listing gave you rather than
     letting it be re-derived: the transcript may have grown since the halt,
     and a session identified by a different hash is a different thread.
   - \`finished\` — \`proposed\` lists what went into the branch and PR. Move to
     the next session.

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
\`{ "<id>": { "<operation key>": { "decision": "accept", "decidedAt": "<ISO 8601>" } } }\`,
one entry per operation, using the same keys the request used. A rejected operation
is simply left out of the accept — nothing merges without them.

## What to tell the user at the end

Which sessions ran, what was proposed, and the pull request. Nothing merges
automatically; the PR is where they review it.
`;
