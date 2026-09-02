# CLAUDE.md: signposts

The specs live in `~/Projects/memento/knowledge/projects/signposts/`, numbered `01`–`17`. Code
comments cite them by number, and when a comment says `13-constants.md` it means that file is the
authority and this repo is the transcription. Read the one a change touches before changing it.

## Shape

`src/core/` is pure. No filesystem, no network, no clock, no `process.env`. `src/io/` is where
those live. A function that needs the time or the environment takes it as an argument.

Ports are interfaces (`src/graph/ports.ts`, `src/app.ts`) constructed in exactly one place, the
composition root at `src/io/production-app.ts`. Nothing else builds a port (R2). Nothing below the
composition root reads the environment, the Keychain, or the `ant` profile directory (R7). Tests
pass fakes into the same seams.

The extraction graph is a LangGraph state machine in `src/graph/`, ten nodes, four of which call a
model: `extract`, `critic`, `classify`, `resolve_conflict`.

## Rules the linter enforces, and why

Three custom rules in `eslint-rules/`. Each exists because of a specific failure, so work with
them instead of around them.

**`no-magic-literal`** — a string or number under `src/` that duplicates a value exported by
`src/core/config/constants.ts` is an error. Re-tuning a constant has to stay a one-line change
there. When you hit this and the collision is coincidental, the fix is a named constant for your
value, never a reference to the unrelated one that happens to share it.

**`no-anthropic-sdk-outside-io-model`** — `@anthropic-ai/sdk` may only be imported under
`src/io/model/`. Any live model call belongs there.

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

`FixtureModelProvider` stays here because the repo's own tests need a model double, and
`production-app.ts` currently uses it as a placeholder. That placeholder goes when the graph is
wired.

## The graph is not wired yet

`buildExtractionGraph` and `startRun` are referenced nowhere outside `src/graph/`.
`production-app.ts` builds a `FixtureModelProvider` with an empty map and no `neighbours`, `index`
or `commit` ports. `src/io/db/neighbours.ts` implements RRF retrieval, has tests, and nothing calls
it. The CLI has three commands: `doctor`, `init`, `index`.

So a change can be correct, tested, and still unreachable by a user. Say so when that is true of
what you just wrote.

## Two known holes

`retire` is in the operation union, `validate-operations.ts` checks it, and `partition.ts` maps it
to the `deletes_existing` gate reason. No classification path emits it. Both are unreachable.

`RESOLVE_SYSTEM` tells the model it has read-only tools (`read_file`, `git_log`, `grep_repo`) and
instructs it to use them. `resolve-conflict.ts` passes no tools. The `ToolDef` plumbing exists and
no node supplies it, so the resolver follows its other instruction and prefers `undecidable`.

## Style

Comments explain why, and name the doc or the incident behind a decision. Match the density of the
file you are editing; several modules open with a long header explaining a design choice, and that
is deliberate.

Commit messages and PR prose go through the `humanizer` skill before committing.
