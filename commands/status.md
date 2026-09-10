---
name: status
description: What signposts has waiting — eligible sessions, reviews parked on you, and whether the search index is current.
disable-model-invocation: true
---

Report the state of signposts in this repository, then stop. Do not start a run.

1. `signpost sessions` — the eligible transcripts, oldest first.
2. `signpost doctor` — node version, `gh` auth, model cache, database integrity,
   session-start hook. **Its hook line does not cover a plugin install.** It looks
   in `.claude/settings.json`, `.claude/settings.local.json` and
   `~/.claude/settings.json`, and the plugin registers the hook in its own
   `hooks/hooks.json` instead — so "not installed" there means "not installed by
   hand", and says nothing about the plugin. If signposts is installed as a
   plugin, say so rather than repeating that line.
3. Say plainly what is waiting and what the user would type for each: `signpost run`
   for a backlog of sessions, `signpost review` in their own terminal for a parked
   review.

Report what the commands actually printed. If a command fails, say so with its
output rather than describing what it would have said.
