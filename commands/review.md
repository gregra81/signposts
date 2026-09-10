---
name: review
description: Surface the signpost proposals parked on you and explain how to answer them.
disable-model-invocation: true
---

Signpost proposals that the confidence gate sent to a person wait on a checkpoint
until that person answers them. Two things can be true here, and they are answered
differently:

- **A run is halted right now** on a `human_review` in this session. Show the user
  each entry in `needsHuman` — the operation and why it was gated — ask them to
  accept, reject or edit each one, and resume as
  `.claude/skills/signposts/SKILL.md` describes. Every operation needs a decision;
  an omission is not a rejection.
- **Nothing is halted here.** Then the parked reviews are answered by
  `signpost review`, which the user runs in their own terminal. **Never run that
  command yourself** — it is a prompt for a person, and it refuses a stdin that is
  not a terminal.

Do not decide on the user's behalf in either case.
