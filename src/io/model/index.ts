// Entry point for src/io/model: the fixture double the tests replay against.
// The live provider is src/graph/host-model.ts, which halts the run and lets
// the session answer.
export { FixtureModelProvider, fixtureKey } from "./fixture-provider.ts";
