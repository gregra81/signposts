// Node 6, `resolve_conflict` — LLM. Rarest, hardest, strongest model.
//
// Entered only when `classify` routed at least one candidate here. It picks up
// every contradiction that has no resolution yet and adjudicates each: does
// the new claim supersede the old, does the old stand, are both true under
// narrower scopes (very common — one is staging, the other production), or
// does the evidence not settle it.
//
// **Undecidable is a first-class outcome, not a failure.** It routes to a
// person, and choosing it costs one review where guessing wrong silently
// corrupts the knowledge base.
//
// The node handles the whole batch rather than running as one task per
// contradiction. That keeps the hop from `classify` a channel write, which is
// what lets the deferred `validate` wait for this node — see nodes/classify.ts.
// The calls inside are still one per contradiction and still concurrent.

import { CLASSIFICATION_KINDS } from "../../core/contracts/graph.ts";
import { resolveToolDefs } from "../../core/graph/resolve-tools.ts";
import { resolveUserTurn } from "../../core/prompts/user-turns.ts";
import { callStructured } from "../llm.ts";
import type { Candidate, Resolution } from "../../core/contracts/graph.ts";
import type { ExtractionState, ExtractionUpdate } from "../state.ts";
import type { GraphPorts } from "../ports.ts";
import type { Signpost } from "../../core/signpost/schema.ts";

export function makeResolveConflictNode(ports: GraphPorts) {
  return async function resolveConflictNode(state: ExtractionState): Promise<ExtractionUpdate> {
    const pending = state.candidates.filter(
      (candidate) =>
        state.classifications[candidate.tempId]?.kind === CLASSIFICATION_KINDS.CONTRADICTION &&
        state.resolutions[candidate.tempId] === undefined,
    );

    const settled = await Promise.all(
      pending.map((candidate) => resolveOne(ports, state, candidate)),
    );

    // Keyed on the candidate we asked about, never on the tempId the model
    // echoed back — `classify` is defensive about the same thing. Two
    // contradictions adjudicated concurrently can come back carrying the same
    // echoed id, and filing one under the other's key would justify a
    // `supersede` with evidence about a different claim.
    const resolutions: Record<string, Resolution> = {};
    for (const settledOne of settled) {
      if (settledOne !== undefined) {
        resolutions[settledOne.tempId] = settledOne.resolution;
      }
    }
    return { resolutions };
  };
}

async function resolveOne(
  ports: GraphPorts,
  state: ExtractionState,
  candidate: Candidate,
): Promise<{ tempId: string; resolution: Resolution } | undefined> {
  const existing = await findExisting(ports, state, candidate.tempId);
  if (existing === undefined) {
    // A contradiction we cannot look up is one we cannot adjudicate. Leaving
    // it unresolved is deliberate: the gate treats that exactly like
    // `undecidable` — routed to a person, never dropped and never
    // auto-published.
    return undefined;
  }

  // The tools go out with every resolve call, and the runner is bound to the
  // run's own repoRoot rather than to anything the model can name. Whether
  // they get used is the model's decision; whether a path they are handed is
  // reachable is not — see src/io/tools/repo-tools.ts. The provider bounds
  // the back-and-forth at MAX_RESOLVE_TOOL_ITERATIONS and then makes the
  // model answer, which is why running out of evidence produces an
  // `undecidable` resolution instead of an exception.
  const resolution = await callStructured({
    model: ports.model,
    node: "resolve",
    user: resolveUserTurn(state.repo, candidate, existing),
    tools: resolveToolDefs(),
    runTool: ports.tools.forRepo(state.repoRoot),
  });
  return { tempId: candidate.tempId, resolution };
}

/**
 * The neighbour the classification points at. Looked up among the candidate's
 * own retrieved neighbours first — it is almost always one of them — and only
 * then in the mirror, which covers a relatedId the model named from outside
 * the retrieved set.
 */
async function findExisting(
  ports: GraphPorts,
  state: ExtractionState,
  tempId: string,
): Promise<Signpost | undefined> {
  const relatedId = state.classifications[tempId]?.relatedId;
  if (relatedId === undefined) {
    return undefined;
  }
  const fromNeighbours = (state.neighbours[tempId] ?? []).find(
    (neighbour) => neighbour.id === relatedId,
  );
  return fromNeighbours ?? (await ports.index.byId(state.repo, relatedId));
}
