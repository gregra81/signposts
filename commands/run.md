---
name: run
description: Extract signposts from this repo's idle Claude Code sessions and open a pull request with what they hold.
disable-model-invocation: true
---

Drive the signposts extraction loop for this repository.

Follow the signposts skill that ships with this plugin — it is the authority on the
loop, the halt and the shape of a reply. Read it before running anything.

In short: `signpost sessions` says what is eligible; stop and say so if nothing is.
Otherwise run the loop in a subagent, one session at a time, then run
`signpost publish` and report the pull request. Typing this command is the yes:
ask nothing else on the way.

$ARGUMENTS may name a single session id to run instead of the whole backlog.
