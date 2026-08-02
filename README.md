# signposts

**signposts turns a team's Claude Code sessions into reviewed, shared knowledge.**

When you work with Claude Code, you correct it. *"No, we don't use that pattern here."*
*"That'll break — staging is read-only."* *"Don't edit that file, it's generated."* Those
corrections are real institutional knowledge, and today they die the moment the session ends.
The next developer — and the next Claude session — rediscovers them from scratch.

signposts reads the transcripts already sitting on the developer's disk, distills the lessons
that **cannot be recovered by reading the code**, checks each one against what the team already
knows, and opens a **pull request** against a folder of markdown in the repo. A human reviews it
like any other PR.

A *signpost* is a marker a previous traveller left so the next one doesn't take the wrong turn.
That is the whole product in one word.

## The shape, in six steps

1. **Discover** — scan `~/.claude/projects/**.jsonl` for sessions idle ≥ 24h.
2. **Gutter** — reduce each transcript to human turns plus trimmed assistant context. No LLM.
3. **Extract → critique** — an LLM proposes candidate signposts; a second pass applies a
   skeptical bar.
4. **Retrieve → classify** — for each candidate, pull semantically near existing signposts and
   decide: novel, duplicate, refinement, or contradiction.
5. **Gate** — high-confidence additions auto-open a PR. Low confidence, any edit or delete of
   existing knowledge, and every unresolved contradiction pause for a human.
6. **Commit** — write markdown to `.signposts/` in the repo, open the PR.

## Non-negotiables

| # | Decision | Why |
|---|---|---|
| 1 | **Local-first. No server, no Docker, no hosted database.** | Transcripts are private and contain unredacted secrets. Extraction runs on the developer's machine with the developer's credentials. This also makes install one command. |
| 2 | **Git is the store.** Signposts are markdown committed to the project's own repo under `.signposts/`. | Contributors *are* the team — no org directory, no auth system, no cross-repo plumbing. |
| 3 | **The review gate is a pull request** — one long-lived branch and one PR per developer, `signposts/<author>`. | The HITL surface already exists and developers already live in it. |
| 4 | **Only interaction-derived knowledge.** Never anything inferable by reading the code. | This is the entire differentiator. |
| 5 | **Sessions idle ≥ 24h only.** | Claude Code sessions are resumable; "ended" is not final. |
| 6 | **The write path is the deep half, and it ships first.** The read path starts as a `CLAUDE.md` pointer; an MCP server follows later. | Retrieval-and-inject is a crowded space; the differentiator is the write path. |

## Status

Early build, in progress. This project is being built step by step, layer by layer, each layer
landing as its own PR.

## Nothing verifies that the human was right

The bar tests novelty, not truth. Hedge detection keeps unsure claims out of the auto-publish
path; the PR reviewer is the truth check.
