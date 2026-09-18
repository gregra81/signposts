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

`FixtureModelProvider` lives in `src/` because the tests need a model 