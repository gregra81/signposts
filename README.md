# signposts

[![CI](https://github.com/gregra81/signposts/actions/workflows/ci.yml/badge.svg)](https://github.com/gregra81/signposts/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/gregra81/signposts)](https://github.com/gregra81/signposts/releases/latest)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

When you work with Claude Code, you end up correcting it constantly. "No, we don't use that
pattern here." "That'll break, staging is read-only." "Don't touch that file, it's generated."
Those corrections are real knowledge about how a team actually works, and right now they just
evaporate when the session ends. The next person, human or Claude, has to relearn the same thing.

signposts reads the Claude Code transcripts already sitting on your disk, pulls out the lessons
that you couldn't get by just reading the code, checks them against what's already been recorded,
and opens a pull request of markdown in the repo. A human reviews it like any other PR, and
nothing gets merged automatically.

A signpost is what a previous traveler leaves behind so the next one doesn't take the wrong turn.

## Install

```
curl -fsSL https://gregra81.github.io/signposts/install.sh | bash
```

That is the only command. There is nothing to set up per repo: once a session has gone quiet, the
next Claude Code session asks whether to turn it into a pull request, and a yes does the rest.

The script wants Node 24 or newer. It downloads the release tarball, checks it against the
SHA256SUMS published beside it, and hands it to `npm install -g`. Pin a version with
`SIGNPOSTS_VERSION=0.1.0`, and read it before you run it if you would rather not pipe a stranger's
shell script into bash: it is [docs/install.sh](docs/install.sh) in this repo.

That one command installs both halves. The CLI is the code; the Claude Code plugin is the wiring —
the session-start hook, the `/signposts:*` commands and the `search_signposts` server — and the
script installs it for you with `claude plugin install`, so there is nothing to type inside Claude
Code. Restart any session that was already open, so it picks the plugin up.

The plugin cannot carry the code, which is why the order matters: a plugin is installed by cloning
its repository, and a clone has no `node_modules` and none of the compiled output. Its manifest
names `signpost` and `signpost-session-start`, the binaries the package puts on your PATH.

If the `claude` CLI is not on your PATH, the installer says so and prints the two commands to run
inside Claude Code instead:

```
/plugin marketplace add gregra81/signposts
/plugin install signposts@signposts
```

`SIGNPOSTS_SKIP_PLUGIN=1` installs the CLI on its own.

The first run in a repo sets it up on the way through. Claude Code asks you once to allow
`signpost sessions`, the run's first command. That command installs the status line and adds two
allow rules to `.claude/settings.local.json` (the `signpost` binary and one replies file outside
the repo), so the rest of the run, and every run after it, does not stop to ask. A plugin is not
allowed to do either, which is why the run does it. That file stays out of git. Nothing is written into your
checkout: the `CLAUDE.md` pointer comes in with the first pull request.

## What you end up with

One file per lesson, in the repo, in a pull request you review like any other:

```markdown
---
id: staging-read-only
claim: Staging is read only outside the ETL window
category: environment
scope:
  repo: acme/api
  paths:
    - db/migrations/**
confidence: 0.9
status: active
provenance:
  session_ids:
    - 01J9F8Q2K7
    - 01J9M2B4RT
  authors:
    - dana@acme.example
    - sam@acme.example
  first_seen: 2026-09-02
  last_reinforced: 2026-09-09
---

A migration run against staging failed with a permissions error, and the human said every write
goes through the nightly ETL job.
```

Two authors on that file because two people hit the same wall in different words, and the second
session recognised the first one's claim instead of writing a second file about it. When a third
session contradicts it, the change goes into the pull request flagged, with the reason, and your
colleague's claim stays until someone merges it.

## How it works

1. Scan `~/.claude/projects/**.jsonl` for sessions that have ended, or have been idle 24+ hours.
2. Strip each transcript down to the human turns plus trimmed assistant context. No LLM involved
   at this step — it's cheap and it runs on everything.
3. Your Claude Code session proposes candidate signposts, then critiques them with a skeptical eye.
4. For each candidate, retrieve the nearest existing signposts and classify it: new, duplicate,
   refinement, or contradiction.
5. Write the markdown to `.signposts/` and commit it to your branch, locally.
6. Push the branch and open or update the PR. Anything low-confidence, anything that edits or
   deletes existing knowledge, every contradiction, and everything on a repo's first run is listed
   in the PR under "Look closely at", with the reason.

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

**A session has to be finished first:** ended, or idle 24+ hours. Claude Code sessions are
resumable, so a quiet session isn't really finished until enough time has passed. A session you
exit or `/clear` is marked by a `SessionEnd` hook and needs no wait, so the next session can offer
to capture it straight away. If you resume it after all, the new activity cancels the mark and the
full day applies again.

**Your working tree is never touched.** A run commits through a second worktree, so proposals
appear on a branch while you carry on with whatever you were doing.

**One question, then a pull request.** Claude offers the run and says it will open a pull request.
Your yes covers both. In a repo nothing has run in yet, Claude Code also asks once to allow the
first `signpost` command, because a plugin cannot grant permissions. The run stops at a local commit and `signpost publish` does the push at the
end, so nothing leaves your machine before you have said yes. There used to be more questions: a
consent prompt at `init`, a review of every flagged change inside the session, and a separate yes
to publishing. Each one was a reason not to use the tool, and the pull request was already the
place where a person reviews the work.

**The write path shipped first.** Retrieval-and-inject is a crowded space; capturing the knowledge
at all was the part worth building first. The read path is now an MCP server with one tool,
`search_signposts`, over the index the write path already maintains. The `CLAUDE.md` pointer stays
anyway: it is what still works when the server is not running.

## The commands

You don't normally type any of these. Claude offers a run, and the skill that ships with the plugin
drives the loop.

| Command | What it is for |
|---|---|
| `signpost doctor` | Checks this machine: node version, `gh` auth, model cache, database, whether the hook is installed. |
| `signpost sessions`, `run`, `resume` | The loop the skill drives. One JSON object per invocation. |
| `signpost publish` | Pushes what the runs committed and opens or updates the PR. The skill runs it at the end. |
| `signpost index` | Rebuilds the local search index by hand. The session-start hook does it in the background. |
| `signpost init` | Sets a repo up and downloads the embedding model ahead of time. Optional: the first run does the same. |

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

## Requirements

Node 24 or newer, git, and a repo with a GitHub `origin`. `gh` authenticated if you want
`signpost publish` to open the pull request for you; without it the branch is still pushed and you
get the `gh pr create` line to run yourself. The first run downloads a 23MB embedding model, once per machine, after which
retrieval works offline.

## Uninstall

Remove the plugin first: once the package is gone, its hook and search server call a `signpost`
that no longer exists.

```
claude plugin uninstall signposts@signposts
claude plugin marketplace remove signposts
npm rm -g signposts     # or: rm -rf "$(npm prefix -g)/lib/node_modules/signposts"
rm -rf ~/.signposts     # database, index, model cache
```

`.signposts/` in your repo is yours and stays. So does what the first run wrote into each repo's
`.claude/settings.local.json`: two allow rules, which do nothing once `signpost` is gone, and the
`statusLine` entry, which you have to change. If its command ends in `--wrap '<your command>'`,
put your command back as the `command`; otherwise delete the entry. A status line that points at
a file that is gone shows nothing at all, yours included.

## Where this stands

Just getting started. Building it in layers, one PR at a time.

One honest caveat: nothing here checks that a signpost is actually *true*, only that it's novel
and not obviously hedged. The PR review is what catches a wrong one.

## Licence

MIT. See [LICENSE](LICENSE).
