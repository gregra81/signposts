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

**The write path ships first.** Reading signposts back into a session starts as a plain
`CLAUDE.md` pointer; a proper MCP server comes later. Retrieval-and-inject is already a crowded
space — the part worth building first is getting the knowledge captured at all.

## Using it

```
npm i -g signposts
signpost init          # asks once, writes .signposts/ and the skill
```

After that you never run it by hand: ask Claude to run signposts, and the skill it installed drives
the extraction, brings anything that needs your judgement back to you, and opens the PR.

## Where this stands

Just getting started. Building it in layers, one PR at a time.

One honest caveat: nothing here checks that a signpost is actually *true*, only that it's novel
and not obviously hedged. The PR review is what catches a wrong one.
