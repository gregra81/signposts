---
name: status
description: What signposts has waiting — eligible sessions, unpublished work, and whether the search index is current.
disable-model-invocation: true
---

Report the state of signposts in this repository, then stop. Do not start a run.

1. `signpost sessions` — the eligible transcripts, oldest first.
2. `signpost doctor`: node version, git author and origin, `gh` auth, model
   cache, database, session-start hook (by hand or through the plugin), setup,
   the status line, and the background worker's last error. Its last line says
   `ready` or lists what is `blocked`, and it exits 1 when something blocks a
   run. An exit 1 is doctor's answer, not a crash: report the blockers it
   names.
3. Say plainly what is waiting and what would clear it: `/signposts:run` for a
   backlog of sessions, `signpost publish` for work committed and not yet published.

Report what the commands actually printed. If a command fails, say so with its
output rather than describing what it would have said.
