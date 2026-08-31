// The other process. Spawned by test/behaviour/graph/process-death.test.ts,
// which kills it mid-run and then starts it again in `resume` mode against
// the same checkpoint file.
//
// It is a script rather than a function because that is the whole claim under
// test: an in-process call proves the graph can be re-entered, not that a
// checkpoint survives a process that no longer exists. This one is SIGKILLed —
// no shutdown hook, no flush on the way out — so anything the second run sees
// was already on disk.
//
// Run by bare `node` (Node's type stripping), so every specifier here and in
// everything it imports has to be a real filename — `.ts`, not `.js`.

import process from "node:process";
import { buildExtractionGraph, startRun } from "../../../src/graph/index.ts";
import { openCheckpointer } from "../../../src/io/db/checkpointer.ts";
import type { NodeName } from "../../../src/core/model/types.ts";
import { candidate, gutteredSession, makeHarness, RUN_INPUT } from "./graph-harness.ts";

/** Printed on stdout once the run is deep enough to be worth killing. */
export const REACHED_CLASSIFY = "REACHED_CLASSIFY";

// Guarded so the test can import the marker above without running anything:
// only the spawned process is `main`.
if (import.meta.main) {
  const [mode, checkpointPath] = process.argv.slice(2);
  await run(mode ?? "", checkpointPath ?? "");
}

async function run(mode: string, checkpointPath: string): Promise<void> {
  // One high-confidence novel candidate: no conflict, no human, straight
  // through to `commit` — so "did it finish?" is a question the commit port
  // answers, with no interrupt in the way.
  const harness = makeHarness({
    session: gutteredSession(),
    script: {
      extract: [{ candidates: [candidate({ confidence: 1 })] }],
      critic: [{ verdicts: [{ tempId: "t1", keep: true, reason: "durable" }] }],
      classify: [{ tempId: "t1", kind: "NOVEL", rationale: "nothing like it recorded" }],
    },
  });

  /**
   * In `hang` mode the model stops answering at `classify` and the process
   * waits to be killed. By then `gutter`, `extract` and `critic` have each
   * completed a superstep, so their results are checkpointed and the kill
   * lands squarely in the middle of the run — 15-spec.md's "kill during
   * classification".
   */
  const model = {
    structured: async <T,>(req: Parameters<typeof harness.model.structured>[0]) => {
      if (mode === "hang" && req.node === ("classify" satisfies NodeName)) {
        console.log(REACHED_CLASSIFY);
        // A promise that never settles empties the event loop, and Node exits
        // on an empty loop — which would end this process cleanly, the one
        // thing the test must not let it do. The timer keeps it alive until
        // the signal arrives.
        setInterval(() => {}, 1_000);
        await new Promise<never>(() => {});
      }
      return harness.model.structured<T>(req);
    },
  };

  const { checkpointer, close } = openCheckpointer(checkpointPath);
  const graph = buildExtractionGraph({ ports: { ...harness, model }, checkpointer });
  const result = await startRun(graph, checkpointer, RUN_INPUT);

  // The second run's verdict, read by the test: resumed rather than started
  // again, `extract` never asked a second time, and the operation committed.
  console.log(
    JSON.stringify({
      disposition: result.disposition,
      extractCalls: harness.model.callsTo("extract").length,
      committed: harness.commit.operations.length,
    }),
  );
  close();
}
