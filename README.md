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
and opens a pull request against a folder of markdown in the repo. A human reviews it like any
other PR — nothing gets merged automatically.

A signpost is what a previous traveler leaves behind so the next one doesn't take the wrong turn.

## Install

```
curl -fsSL https://gregra81.github.io/signposts/install.sh | bash
signpost init          # asks once, writes .signposts/ and the skill
```

The script wants Node 24 or newer. It downloads the release tarball, checks it against the
SHA256SUMS published beside it, and hands it to `npm install -g`. Pin a version with
`SIGNPOSTS_VERSION=0.1.0`, and read it before you run it if you would rather not pipe a stranger's
shell script into bash: it is [docs/install.sh](docs/install.sh) in this repo.

Then the plugin, which is the second half rather than an alternative:

```
/plugin marketplace add gregra81/signposts
/plugin install signposts@signposts
```

It carries the session-start hook, the `/signposts:*` commands and the MCP server, so you never
open a settings file. It cannot carry the code: a plugin is installed by cloning its repository,
and a clone has no `node_modules` and none of the compiled output. So the manifest names `signpost`
and `signpost-session-start`, which the install above puts on your PATH. Package first, then
plugin.

`signpost init` still asks for consent and still installs the status line, neither of which a
plugin is allowed to do.

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
session contradicts it, the run stops and asks you rather than overwriting what your colleague
recorded.

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

**Your working tree is never touched.** A run commits through a second worktree, so proposals
appear on a branch and in a PR while you carry on with whatever you were doing.

**The write path shipped first.** Retrieval-and-inject is a crowded space; capturing the knowledge
at all was the part worth building first. The read path is now an MCP server with one tool,
`search_signposts`, over the index the write path already maintains. The `CLAUDE.md` pointer stays
anyway: it is what still works when the server is not running.

## The commands

After `init` you mostly don't type any of these — you ask Claude to run signposts, and the skill
it installed drives the loop.

| Command | What it is for |
|---|---|
| `signpost init` | Consent, `.signposts/`, the CLAUDE.md pointer, the skill, the status line. Asked once. |
| `signpost review` | Where you answer the things a run stopped on, one at a time, as a before/after diff. |
| `signpost doctor` | Checks this machine: node version, `gh` auth, model cache, database, whether the hook is installed. |
| `signpost index` | Rebuilds the local search index by hand. The session-start hook does it in the background. |
| `signpost sessions`, `run`, `resume` | The loop the skill drives. One JSON object per invocation. |

`signpost review` is the one you will type. A run stops at anything that edits, deletes or
contradicts knowledge you already have, and it stays stopped until you answer, usually days later
and from a different process. Accept, reject, edit or skip each proposal. It refuses a stdin that
is not a terminal, so nothing automated can answer in your place.

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

Node 24 or newer, git, and a repo with a GitHub `origin`. `gh` authenticated if you want the pull
request opened for you; without it the branch is still pushed and you get the `gh pr create` line
to run yourself. The first run downloads a 23MB embedding model, once per machine, after which
retrieval works offline.

## Uninstall

```
npm rm -g signposts     # or: rm -rf "$(npm prefix -g)/lib/node_modules/signposts"
rm -rf ~/.signposts     # database, index, model cache
```

`.signposts/` in your repo is yours and stays. So does the status line entry in
`.claude/settings.local.json`, which is one line to delete.

## Where this stands

Just getting started. Building it in layers, one PR at a time.

One honest caveat: nothing here checks that a signpost is actually *true*, only that it's novel
and not obviously hedged. The PR review is what catches a wrong one.

## Licence

MIT. See [LICENSE](LICENSE).
