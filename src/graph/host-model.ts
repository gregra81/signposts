// The ModelProvider the graph runs against: the Claude Code session that
// started the run.
//
// A model call is an `interrupt()`, exactly like `human_review`. The run
// halts, the request is checkpointed with the thread, and the process may
// exit; the host answers it and resumes the thread by interrupt id. Nothing
// here holds a credential or opens a socket, because nothing here talks to an
// API — the reasoning happens in the session, and signposts supplies the
// prompt, the schema and everything the graph knows.
//
// `interrupt()` propagates by throwing a GraphInterrupt, so nothing may wrap
// this in a try/catch. LangGraph re-executes the calling node from the top on
// resume, replaying the interrupts it already answered in order, which is what
// makes a node with several calls (the resolver, one per contradiction)
// resumable one answer at a time.
//
// The reply crosses a process boundary and is not trusted: src/graph/llm.ts
// parses it against the same schema the request carried, and a reply that
// does not satisfy it throws there.

import { interrupt } from "@langchain/langgraph";
import type { ModelProvider, StructuredRequest } from "../core/model/types.ts";

/** Discriminates a model call from the other thing a run halts on. */
export const MODEL_REQUEST_KIND = "model_call";

/** What the host is asked for: one node's prompt, and the shape of the answer. */
export interface ModelRequest extends StructuredRequest {
  kind: typeof MODEL_REQUEST_KIND;
}

export function isModelRequest(value: unknown): value is ModelRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === MODEL_REQUEST_KIND
  );
}

export const hostModel: ModelProvider = {
  async structured<T>(req: StructuredRequest): Promise<T> {
    return interrupt<ModelRequest, T>({
      kind: MODEL_REQUEST_KIND,
      node: req.node,
      system: req.system,
      user: req.user,
      schema: req.schema,
    });
  },
};
