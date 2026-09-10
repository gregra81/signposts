---
name: run
description: Extract signposts from this repo's idle Claude Code sessions — the run/resume loop, one halt at a time.
disable-model-invocation: true
---

Drive the signposts extraction loop for this repository.

Follow `.claude/skills/signposts/SKILL.md` — it is written by `signpost init`, is
rewritten on every `init`, and is the authority on the loop, the two kinds of halt
and the shape of a reply. Read it before running anything.

In short: `signpost sessions` says what is eligible; stop and say so if nothing is.
Otherwise run the loop in a subagent, one session at a time, and bring any
`human_review` halt back here — only the developer can answer that one.

$ARGUMENTS may name a single session id to run instead of the whole backlog.
