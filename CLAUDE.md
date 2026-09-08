# CLAUDE.md: signposts

The specs live in `~/Projects/memento/knowledge/projects/signposts/`, numbered `01`–`17`. Code
comments cite them by number, and when a comment says `13-constants.md` it means that file is the
authority and this repo is the transcription. Read the one a change touches before changing it.

## Shape

`src/core/` is pure. No filesystem, no network, no clock, no `process.env`. `src/io/` is where
those live. A function that needs the time or the environment takes it as an argument.

Ports are interfaces (`src/graph/ports.ts`, `src/cli/run-port.ts`) constructed in exactly one
place: the composition root, which is `src/io/production-app.ts` and the `openRun` it hands down
(`src/io/open-run.ts`). Nothing else builds a port (R2). Nothing below the composition root reads
the environment (R7). Tests pass fakes into the same seams.

A run's resources — a database handle, a checkpointer, an embedder that loads an ONNX pipeline —
live for one invocation, so `openRun` is a function rather than a built object: `doctor` has to
run in a repo with no database, and `init` must not create one before consent.

The extraction graph is a LangGraph state machine in `src/graph/`, ten nodes, four of which call a
model: `extract`, `critic`, `classify`, `resolve_conflict`.

## Who answers the model calls

The Claude Code session does. signposts holds no credential and calls no API: `hostModel`
(`src/graph/host-model.ts`) implements the `ModelProvider` port with `interrupt()`, so a model call
halts the run and comes back from `startRun`/`resumeRun` as a pending request carrying the node,
both turns and the JSON Schema for the reply. The session answers it and resumes the thread by
interrupt id.

`human_review` halts the same way and is answered the same way; `kind` on the payload
(`MODEL_REQUEST_KIND`, `REVIEW_REQUEST_KIND`) is what tells the two apart. Answer by interrupt id,
never positionally — `classify` fans out, so several tasks can be halted at once.

The reply crosses a process boundary and is validated on arrival: `src/graph/llm.ts` parses it with
the same zod schema the request went out with, and a reply that does not satisfy it throws.

## Rules the linter enforces, and why

Three custom rules in `eslint-rules/`. Each exists because of a specific failure, so work with
them instead of around them.

**`no-magic-literal`** — a string or number under `src/` that duplicates a value exported by
`src/core/config/constants.ts` is an error. Re-tuning a constant has to stay a one-line change
there. When you hit this and the collision is coincidental, the fix is a named constant for your
value, never a reference to the unrelated one that happens to share it.

**`no-io-in-core`** — under `src/core/`, every Node builtin is an error unless it is on a short
allowlist (`path`, `url`, `util`, `buffer`, and `crypto` for hashing only), and so are
`process.*`, `Date.now()`, `new Date()` and `Math.random()`. An allowlist rather than a list of
banned modules, because a denylist catches `node:fs` and waves through `node:fs/promises`. The
rule exists because a module under `src/core/` imported `node:fs` and called lstat, readlink and
realpath for months while this file claimed core was pure. When you hit it, the fix is the one the
shape section describes: take what you need as an argument.

**`no-src-import-in-hooks-or-statusline`** — `hooks/` and `statusline/` run outside the app and
may not import from `src/`.

## Language and imports

Node 24 with native type stripping, so **erasable syntax only**: no `enum`, no parameter
properties, no `namespace`. Relative imports carry the `.ts` extension, because that is the file
that exists at runtime. There is no build step and no `dist/`.

That last point has a consequence worth knowing: another package cannot import this one under
plain `node`, which refuses to strip types beneath `node_modules`. `signposts-eval` runs its
scripts through `tsx` for exactly this reason.

## Tests

Four tiers under `test/`: `unit`, `behaviour`, `invariant`, `property`. `pnpm test` runs
everything; `pnpm test:unit` is the narrower set Stryker drives.

The suite must pass with the network denied:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network*)' pnpm test
```

Check that after touching anything that loads a model or an embedding. The embedding model was
fetched over the network on every run for weeks while the suite looked green. A warm cache does
not fix it, because transformers.js fetches file metadata before it will read `cacheDir`. Offline
needs `allowRemoteModels: false` and `localModelPath`, which `test/support/global-setup.ts`
arranges.

Mutation testing runs per module, not globally: `pnpm mutate` then `pnpm mutate:gate`. A module
with no threshold entry fails the gate, so a new module cannot arrive ungated. `pnpm verify` is
the whole chain.

Never edit an existing test to make a change pass without saying so and getting agreement.

## Evaluation lives elsewhere

The golden set, the synthetic scenarios and the recorded model responses are in the private
`signposts-eval` repo, which depends on this one. This repo has no reference to it: no import, no
path, no config. Keep it that way: fixtures are one person's private corpus, and `src/` is what a
user's runtime touches.

`FixtureModelProvider` stays here because the repo's own tests need a model double — it replays
replies keyed on `(node, system, user)` and treats a miss as an error.

## How it is used

`npm i -g signposts`, then `signpost init` in a repo: consent, `.signposts/`, the CLAUDE.md pointer,
and `.claude/skills/signposts/SKILL.md` — the skill is how the tool is driven, and it is rewritten
on every accepted `init` so it cannot drift from the CLI it describes.

The CLI is six commands. `doctor`, `init` and `index` stand alone; `sessions`, `run` and `resume`
are the loop the skill drives, one JSON object per invocation:

```
signpost sessions                                  # eligible transcripts
signpost run --session <id> [--first]              # -> {status: "waiting", pending: [...]}
signpost resume --session <id> --replies <path>    # -> the next halt, or "finished"
```

`--first` clears what the previous run left pending, so it belongs on the first session of a run
and nowhere else. The skill runs the loop in a subagent (a session's prompts are thousands of
tokens) and brings a `human_review` halt back to the main session, because only the developer can
answer it.

A run never touches the developer's checkout. `commit` writes through a second worktree
(`paths.worktreeDir`) on `signposts/<author-slug>/<date>`, so proposals live on a branch and in a PR
and appear in the working tree only when it merges. Sessions accumulate onto whichever of those
branches still has an open PR; once it merges the next session starts a new one from the base,
because nothing rebases the branch and a reused one drifts from the merged corpus
(`src/core/git/branch.ts`).

So a change can still be correct, tested, and unreachable by a user. Say so when that is true of
what you just wrote.

## A known hole

`retire` is in the operation union, `validate-operations.ts` checks it, and `partition.ts` maps it
to the `deletes_existing` gate reason. No classification path emits it, so both are unreachable.

## Style

Comments explain why, and name the doc or the incident behind a decision. Match the density of the
file you are editing; several modules open with a long header explaining a design choice, and that
is deliberate.

Commit messages and PR prose go through the `humanizer` skill before committing.
