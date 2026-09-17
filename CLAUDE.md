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

The extraction graph is a LangGraph state machine in `src/graph/`, eleven nodes, four of which call a
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

One thing it does not do: a path *above* `repoRoot` is left alone, and the redactor chain does not
catch a bare username in it — `/Users/dana/other-repo/src/config.ts` leaves the machine whole. Known
limit, recorded in the module and in 18-end-to-end-gaps.md item 4, not something that file closes.

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
that exists at runtime. A checkout needs no build step; a tarball does — see below.

That last point has a consequence worth knowing: another package cannot import this one's `src/`
under plain `node`, which refuses to strip types beneath `node_modules`. A consumer that does has
to run through `tsx`.

It is also why distribution has a build step even though development does not. `pnpm build`
(`prepack` runs it) compiles `src/` into `dist/` with `tsconfig.build.json`, whose one interesting
setting is `rewriteRelativeImportExtensions`: those `.ts` extensions are what make the checkout
runnable without a build, and they name files that do not exist in `dist/`. `tsc` rewrites them,
so there is no hand-written build script — an earlier version of this used
`stripTypeScriptTypes` and a regex over the specifiers, which was a worse `tsc`. `bin/signpost.js`
prefers `dist/` and falls back to `src/`, so one wrapper serves both layouts.

The tarball ships **both** trees. `dist/` is what an installed copy runs; `src/` stays because a
consumer running through `tsx` imports it directly. Dropping `src/` from `files` once broke such a
consumer at import, and nothing in this repo's suite shows that failure — so treat `files` and the
layout as a public interface.

## Tests

Four tiers under `test/`: `unit`, `behaviour`, `invariant`, `property`. `pnpm test` runs
everything; `pnpm test:unit` is the narrower set Stryker drives.

`docs/install.sh` has its own test outside vitest, `pnpm test:install`, because it packs the
repo, and packing writes `dist/` into the checkout that other tests spawn `bin/signpost.js` from.
CI runs it after the suite; the release workflow runs it on the tarball and `SHA256SUMS` it publishes.

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

## Evaluation

`test/eval/` checks extraction quality end to end without calling a model. It holds scenarios —
ordered, hand-written Claude Code sessions over one repo — and the model replies recorded for
each call they make. The suite runs inside `pnpm test`: each step runs the real graph against the
signposts the earlier steps produced, and asserts which operations came out and how many signposts
exist afterwards. A change to the gutter, the redactor, routing, the gate or `applyOperations` that
alters the outcome fails here.

A step can also list `expect_claims`: gists of what the human said. Each gist and every produced
claim go through the local embedding model, and some claim must reach cosine ≥ 0.8 with each gist.
Write a gist from the transcript, never from the recorded reply — a gist copied from the output
measures nothing. A related claim that means something else scores around 0.7, so the margin is
real but not wide.

A prompt edit misses every recorded reply and fails with "no fixture recorded". That is the signal
to re-record and read what the model now says, not something to route around. Never edit
`expect_operations` to make a run pass without saying why the output changed.

Every transcript here is synthetic. Do not add a real session: redaction removes secrets, not the
confidential context that makes a real correction worth learning from.

`FixtureModelProvider` lives in `src/` because the tests need a model double — it replays replies
keyed on `(node, system, user)` and treats a miss as an error.

## How it is used

`curl -fsSL https://gregra81.github.io/signposts/install.sh | bash` (docs/install.sh, served from
GitHub Pages; it fetches the release tarball, verifies SHA256SUMS and runs `npm install -g` on it),
then `signpost init` in a repo: consent, `.signposts/`, the CLAUDE.md pointer,
and `.claude/skills/signposts/SKILL.md` — the skill is how the tool is driven, and it is rewritten
on every accepted `init` so it cannot drift from the CLI it describes.

The CLI is nine commands. `doctor`, `init` and `index` stand alone; `sessions`, `run` and `resume`
are the loop the skill drives, one JSON object per invocation; `review` is the developer's own
terminal; `worker` is spawned by the hook and `mcp` by the plugin, and neither is ever typed (see
below):

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

## The SessionStart hook and its worker

`hooks/session-start.ts` is a standalone bundle that imports nothing from `src/` (the third lint
rule) and ships pre-compiled by `pnpm build:hooks`, because type-stripping is parse work paid on
every session start. It checks three conditions with `stat` calls only — eligible transcripts,
threads waiting, a stale index — takes the run lock, spawns `signpost worker --adopt-lock`
detached, prints one `systemMessage` and exits. Measured, not asserted: `node scripts/measure-hook.mjs`
prints the distribution against `HOOK_BUDGET_MS`, and it sits around 23ms against a 50ms budget, of
which ~18ms is bare Node start-up.

**The worker cannot drain sessions, and that is not an oversight.** Every
extraction node is a model call, and model calls are answered by the Claude Code session through
`interrupt()` — a detached process has none, so a run it started would halt on the first `extract`
and never return. So the worker rebuilds the index (local, free, no credential) and takes a census
into `status.json`; the hook reads that census because it cannot open a database inside the budget.
The notice is worded to match: the index is background work, the sessions and reviews are the
developer's.

The worker never writes `lastRunFinishedAt`. That is the watermark the hook uses to stop waking for
a session already judged, and the worker judges none. `settle` (`src/cli/with-run.ts`) writes it,
since `run`, `resume` and `review` are the three commands that finish one. It goes down only once
the finished session leaves nothing else eligible, and it carries that session's own last activity
rather than the clock: the watermark is one date for the whole repo, so a wall-clock stamp buries
every transcript that fell quiet just before it — the backlog nobody has run, and the session the
developer was sitting in. Both processes write the same file, so each carries the other's fields
through untouched.

Both processes key `STATE_DIR` on `sha256(repoRoot)`, and the worker gets its repoRoot from
`process.cwd()`, which Node always reports resolved — so the hook resolves symlinks before hashing.
Without that, a checkout reached through a symlink gives the two different state directories and
they silently share nothing.

## The statusLine

`statusline/statusline.ts` is the second standalone bundle, under the same rule as the hook: it
imports nothing from `src/` and transcribes the constants it needs. `pnpm build:hooks` strips it to
`statusline/statusline.js`, which is what the settings entry points at and what `prepack` builds
into the tarball — the `.js` is gitignored, so `files` in package.json is what puts it there and
the `.ts` stays out. A developer never runs the build; an end user gets the output.

It reads `status.json` and nothing else — no database, no git subprocess — because it runs on every
assistant message and on a one-second `refreshInterval`.

It renders one of four things, each true at the moment it renders: a review parked on the developer,
a run in flight, the worker reindexing, a failure nobody was told about — in that order, because a
review is the only one of them asking for anything. It says nothing about a backlog. That is the
hook's message and it is delivered once; a bar that repeats it every few seconds becomes noise.

The progress comes from `settle` (`src/cli/with-run.ts`), for the same reason the watermark does:
the worker drains no session. A run is a sequence of processes, so the count lives on disk and each
invocation adds its own session to what the last one left. It ages out after
`RUN_PROGRESS_STALE_MINUTES`, because closing the terminal between two halts leaves progress behind
with nothing to finish it, and a bar reading "2/3 sessions" all week is not stale, it is wrong.

Which is why `settle` retakes the census in the same write. A run halted on a review re-stamps
nothing until the developer answers, so its progress ages out — and `threadsWaiting` used to be
the worker's alone, written only when a session start happened to wake one. The state the
developer most has to act on was the state that went blank. Both counts come from the same
`pendingReviews` the worker's census uses, so a run replaces them with fresher numbers rather than
competing; `lastIndexedAt` and `lastError` stay the worker's and are carried through.

`init` installs it into `.claude/settings.local.json` rather than `settings.json`: the command holds
an absolute path to this machine's install, and a status line is a personal preference, so neither
belongs in a file the team shares. **If the developer already has a statusLine, theirs is wrapped
rather than replaced** (`--wrap`, and `src/core/init/statusline-settings.ts`): Claude Code allows one
command, ours runs theirs, prints what it printed, and adds a row underneath. The wrapped command
stays visible in the settings file so they can see what happened and take it back by deleting one
thing. Nothing is written at all when the compiled bundle is missing — a command that is not there
exits non-zero, which blanks the bar and takes their status line down with it.

## The plugin, and what it cannot carry

Two manifests, and both are needed. `.claude-plugin/marketplace.json` is what
`/plugin marketplace add gregra81/signposts` reads, and it offers this repo's own plugin from the
repo root (`"source": "./"`); `.claude-plugin/plugin.json` is that plugin. Without the first, the
second cannot be installed at all, which is how v0.1.0 shipped — the README described an install
nobody could perform.

`plugin.json` carries `commands/` (`/signposts:run`, `/signposts:status`, `/signposts:review`) and
`mcpServers` (which starts `signpost mcp`), and it does **not** name `hooks/hooks.json`. Claude Code
loads that file by convention, and declaring it is fatal rather than redundant: "Duplicate hooks
file detected", and the whole plugin fails to load, commands and MCP server with it. v0.1.0 shipped
that too. `test/behaviour/plugin/manifest.test.ts` holds both rules and resolves every path in the
manifests against the repo, because a manifest that points at a file that moved fails as
"installed, and nothing happened" — and, as those two showed, a manifest whose paths all resolve
can still fail to load.

Nobody types either install. `docs/install.sh` runs `claude plugin marketplace add` and
`claude plugin install` after the npm install — both are idempotent — and falls back to printing
the two `/plugin` commands when the `claude` CLI is missing.

One error message worth knowing, because it cost an afternoon: an MCP server whose `command` is not
on PATH is reported as `ENOENT: Executable not found in $PATH: "stdio"`. It names the transport,
not the missing binary. The binary is `signpost`, and the fix is installing the package, not
touching the manifest.

**The status line is not in it.** A plugin's own `settings.json` accepts `agent` and
`subagentStatusLine` and nothing else, so `init` still installs the status line into
`.claude/settings.local.json` — see the statusLine section above; that is a platform limit, not an
oversight.

**A plugin is installed by cloning its repository, and a clone carries no code that runs.** No
`node_modules`, and neither compiled bundle — `hooks/*.js`, `statusline/*.js` and `dist/` are all
build output and all gitignored. `better-sqlite3` is native, so vendoring is not on the table
either. So the manifest points at nothing inside the clone: it names `signpost` and
`signpost-session-start`, the two binaries the global install puts on PATH. The plugin
carries the wiring; the release tarball carries the code, and the installer does both in that
order.

The hook took that failure silently, and the general fix is in the lock rather than in the hook.
`hooks/session-start.js` is zero-dependency and ran fine from a clone, took the run lock, and
spawned a worker that died at its first import with its stderr going to `/dev/null`. The worker is
what releases the lock, and "is a worker still working" was measured by the lockfile's mtime alone —
so the lock sat for `LOCK_STALE_MINUTES` after every wake. The pid had been in that file since the
first version and nothing but `doctor` read it. Both `lockIsHeld` (the hook) and `heldByALiveWorker`
(`src/io/worker/lock.ts`) check it with `process.kill(pid, 0)` now, so a worker that dies for any
reason frees the lock at the next session start.

**`doctor` knows what an enabled plugin looks like.** It reads `enabledPlugins` in the same three
settings files it already read for a hand-installed hook, and reports which of the two routes the
hook came by. A plugin loaded with `--plugin-dir` leaves no trace in any of them, which is why the
absent case says "not found in settings or in an enabled plugin" rather than "not installed".

## The MCP server

`signpost mcp` (`src/cli/commands/mcp.ts`) serves one tool, `search_signposts`, over stdio. It is
dispatched but never typed, like `worker`: the plugin manifest starts it, Claude Code owns both
ends of the pipe. It spends no tokens, so consent does not gate it — the whole point of the read
path is a new hire who has run nothing and holds no credential
(05-retrieval.md, "The MCP server on a cold clone").

**It never throws.** A state with nothing to search — no origin remote, no database, no index, an
unreadable one — is an empty result plus a diagnostic naming the cause and the fallback
(`src/core/mcp/search-tool.ts`). An error there lands inside a Claude turn for the ordinary
condition of a fresh checkout, and the corpus is readable without this server anyway: that is why
the CLAUDE.md pointer stays after the server ships (15-spec.md story 62).

**It searches what it can.** An index behind the mirror is still searched, and so is its FTS half
alone when the embedder will not load or the index was built with another model. Each comes back
with its hits and a caveat in `diagnostic`. All three used to return nothing, so a `git pull`
blanked search until the worker ran (19-value-to-a-user.md item 12). `init` fetches the model
after consent (`src/io/embed/prefetch.ts`), so the download no longer lands inside a Claude turn.

Three things it does not do:

- **It does not open the database for writing.** `openDb` creates and migrates; a reader must do
  neither (R3), so `src/io/db/read-only.ts` opens read-only and reports "no" instead of throwing.
- **It does not re-hash the corpus on disk.** Stale means `shouldReindex` disagreeing with the
  merged rows in the mirror — the same decision `signpost index` makes, over the same rows it is
  fed. Pending rows are excluded from both the hash and the results: a proposal a person may still
  reject is not recorded knowledge, and counting one made the whole index read as stale for the
  length of a run, while pointing the reader at the `signpost index` that would have deleted it.
  Disk drift is the worker's to fix, and it wakes at the same session start this server does.
- **It does not treat every failure as the same failure.** No file is a checkout nothing has run
  in; a file this build cannot read is a schema worth naming; a database with no `index_meta` row
  is a repo that has consented and not indexed, which is where `init` leaves every repo. Each gets
  its own diagnostic, because the friendly one ("expected on a fresh clone") is a lie about the
  other two.
- **It does not trust the working directory.** Claude Code documents which variables a manifest
  may substitute but not the cwd a server is spawned in, so the manifest passes
  `SIGNPOSTS_REPO_ROOT` and `src/io/production-app.ts` resolves it (realpath, for the same reason
  the hook does). A repoRoot guessed wrong is not an error — it is a second state directory and a
  search that answers "nothing recorded here".

The query embedder is built once per process and kept; the database is opened per call, so a
search made an hour into a session sees the index the worker rebuilt ten minutes ago.

## Retire

`retire` fires from `OBSOLETE`, the fifth classification kind: a candidate that withdraws a
neighbour and offers no replacement claim of its own. `CONTRADICTION` is the case where the
candidate makes its own claim; that resolves to `supersede` and keeps both. The prompt says to
prefer `CONTRADICTION` when unsure, because a wrong `OBSOLETE` retires a claim that was still true.

Retiring is a status, not a deletion: the file stays with `status: retired` and a `retiredReason`.
Everything downstream filters on `ACTIVE_STATUS`, so a retired signpost drops out of the index, the
mirror and retrieval without any of those three needing to know the status exists.

## Style

Comments explain why, and name the doc or the incident behind a decision. Match the density of the
file you are editing; several modules open with a long header explaining a design choice, and that
is deliberate.

Commit messages and PR prose go through the `humanizer` skill before committing.
