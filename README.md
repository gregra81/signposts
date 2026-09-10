# signposts

When you work with Claude Code, you end up correcting it constantly. "No, we don't use that
pattern here." "That'll break, staging is read-only." "Don't touch that file, it's generated."
Those corrections are real knowledge about how a team actually works, and right now they just
evaporate when the session ends. The next person, human or Claude, has to relearn the same thing.

signposts reads the Claude Code transcripts already sitting on your disk, pulls out the lessons
that you couldn't get by just reading the code, checks them against what's already been recorded,
and opens a pull request against a folder of markdown in the repo. A human reviews it like any
other PR — nothing gets merged automatically.

A signpost is what a previous traveler leaves behind so the next one doesn't take the wrong turn.

## How it works

1. Scan `~/.claude/projects/**.jsonl` for sessions that have been idle 24+ hours.
2. Strip each transcript down to the human turns plus trimmed assistant context. No LLM involved
   at this step — it's cheap and it runs on everything.
3. Your Claude Code session proposes candidate signposts, then critiques them with a skeptical eye.
4. For each candidate, retrieve the nearest existing signposts and classify it: new, duplicate,
   refinement, or contradiction.
5. High-confidence new additions open a PR automatically. Anything low-confidence, anything that
   edits or deletes existing knowledge, and every contradiction stops and waits for a human.
6. Write the markdown to `.signposts/` and open the PR.

## Decisions that shaped this

**Local-first, no server, no API key.** Transcripts are private and sometimes contain secrets that
weren't meant to leave the machine. Extraction runs inside the Claude Code session you already
have — signposts pauses and asks it to do the reading — so there is nothing to sign up for and
install is one command instead of a deployment.

**Git is the store.** Signposts live as markdown under `.signposts/` in the project's own repo.
No separate database, no auth system — the people who'd read this already have repo access.

**Review happens through a PR**, one branch per developer per review cycle
(`signposts/<author>/<date>`). A shared branch would just be a push race between everyone's local
worker. Sessions pile onto the branch that is still open; a merge starts the next one.

**Only knowledge you couldn't get from reading the code.** If it's inferable from the source, it
doesn't belong here — that's the entire point of the tool.

**Sessions have to sit idle 24+ hours first.** Claude Code sessions are resumable, so "ended"
isn't really final until enough time has passed.

**The write path shipped first.** Retrieval-and-inject is a crowded space; capturing the knowledge
at all was the part worth building first. The read path is now an MCP server with one tool,
`search_signposts`, over the index the write path already maintains. The `CLAUDE.md` pointer stays
anyway: it is what still works when the server is not running.

## Using it

```
npm i -g signposts
signpost init          # asks once, writes .signposts/ and the skill
```

Or install the Claude Code plugin. It carries the session-start hook, the `/signposts:*` commands
and the MCP server, and you never open a settings file. `signpost init` still asks for consent and
still installs the status line, which is not something a plugin is allowed to do.

After that you never run it by hand: ask Claude to run signposts, and the skill it installed drives
the extraction, brings anything that needs your judgement back to you, and opens the PR.

The exception is `signpost review`. A run stops at anything that edits, deletes or contradicts
knowledge you already have, and it stays stopped until you answer, usually days later and from a
different process. `signpost review` is where you answer: what is waiting and for how long, then
one proposal at a time as a before/after diff with the reason it stopped. Accept, reject, edit or
skip each one. It refuses a stdin that is not a terminal, so nothing automated can answer in your
place.

Two others you may type yourself. `signpost doctor` checks the machine instead of reporting what
ought to be true: the running node version against the floor, `gh` auth, whether the embedding
model is cached for offline use, database integrity, and whether the session-start hook is
installed. Run it before writing a bug report.

`--verbose` narrates a run on stderr: which transcript it picked, what each halt is waiting on,
and the exact command that answers it. stdout stays one JSON object, so a pipe through `jq` still
works. This is how you drive the pipeline by hand, with no plugin and no hook in it.

## Reading it back

`search_signposts` matches on meaning. Ask it whether staging can take a migration and you get the
signpost saying the database is read-only, whatever words that signpost happens to use. It runs on
your machine against the local index, so a query costs nothing.

A fresh clone has no index. Nobody has run anything there and nothing has consented, which is
normal, so the tool returns an empty result and says which of those it is. It does not fail: an
error inside a Claude turn would be a worse answer than "there is nothing here yet", and the
signposts are markdown in the repo regardless — the `CLAUDE.md` pointer is what sends Claude to
read them. The session-start hook builds the index in the background, and the next session
searches it.

## Where this stands

Just getting started. Building it in layers, one PR at a time.

One honest caveat: nothing here checks that a signpost is actually *true*, only that it's novel
and not obviously hedged. The PR review is what catches a wrong one.
