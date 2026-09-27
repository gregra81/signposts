---
name: signposts
description: Turn the corrections in your idle Claude Code sessions into reviewed knowledge in this repo. Use when the user asks to run signposts, extract signposts, or capture what a session taught.
---

# signposts

signposts reads this repo's finished Claude Code transcripts and proposes durable
team knowledge — the things the developer corrected you about, which cannot be read
off the code — as markdown in `.signposts/`, in a pull request the team reviews. It
does no reasoning of its own: it pauses and asks *you* for each judgement, then
carries on.

The developer already said yes to the run, and that yes covers the pull request.
Do not ask them anything else between here and reporting it.

## The loop

Every command prints one JSON object. A run advances one halt at a time.

1. `signpost sessions` lists what is eligible. Stop here and say so if the list
   is empty. The first time it runs in a repo it also sets the repo up, and says
   what it did on stderr.
2. **Delegate the rest to a subagent, one per session, one session at a time.**
   The prompts below are thousands of tokens each and belong in a subagent's
   context, not the developer's. Give the subagent this file and the session id,
   and start the next subagent only after this one comes back. Never run sessions
   in parallel: each session compares its candidates against what the earlier
   ones proposed, and two sessions running at once can each propose the same
   signpost.
3. `signpost run --session <id>` — add `--first` for the first session of this
   run only. It clears what the previous run left pending.
4. Read `status`:
   - `waiting` — answer every entry in `pending` (below), then
     `signpost resume --session <id> --content-hash <hash> --replies <repliesPath>`
     and read `status` again. Take `<hash>` and `<repliesPath>` from the very
     output you are answering.
   - `finished` — `proposed` lists what was committed to the local branch named
     in `commit`. Move to the next session.
   - `reExtracted`, on any status, means the critic rejected most of a batch and
     sent it back to `extract` that many times. Tell the developer in one line.
   - `skipped` — the transcript can never be extracted (empty, only subagent
     lines, or a redactor failed on it). `reason` says which. Mention it in one
     line and move on; it is not a failure.

Only exit code `1` is a failure.

## Answering a halt

Each `pending` entry is `{ "id": "...", "request": { ... } }`. The request carries
`node`, `system`, `user` and `schema`. Follow `system` as the instructions, `user`
as the input, and reply with JSON that satisfies `schema` exactly — a reply of the
wrong shape fails the resume.

- `extract` — propose candidate signposts from the transcript.
- `critic` — judge those candidates sceptically.
- `classify` — decide how one candidate relates to what is already recorded.
- `resolve` — adjudicate a contradiction. Read the repository to settle it: the
  code, `git log`, whatever the claim is about. `undecidable` is a real answer:
  the change is then flagged for the reviewer in the pull request.

Write all the answers as `{ "replies": { "<id>": <answer>, ... } }` — keyed by id,
because several may be pending at once and they are not interchangeable — to the
`repliesPath` the output names, with the Write tool, replacing the file at every
halt. That path is outside the checkout and allowed without a prompt. Do not use
`/tmp`, a heredoc or `echo`: each of those stops the run for a permission prompt.

## At the end

If no session committed anything (every `commit` was null), say so in one line
and stop.

Otherwise run `signpost publish`. It pushes the branch and opens the pull
request, or adds to the one `commit.pr` names. Report which sessions ran, what was
proposed, and the pull request. Changes the gate flagged are listed in it under
"Look closely at", with why; the team reviews and merges it, and nothing merges
automatically.

Exit `4` from `publish` is not a failure: the work is committed and no pull
request carries it yet. Show `publish.manualCommand` as it is, and say the status
line keeps reminding them until it is published.
