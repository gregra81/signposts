// ModelProvider port, per 12-wire-contracts.md's "Provider adapter".
//
// The reasoning is done by the Claude Code session that started the run, so a
// call is a request handed to the host and an answer handed back — there is
// no credential, no per-node model and no token accounting on this side of
// the boundary. What the port carries is the three things the host needs to
// answer: which node is asking, what to read, and the shape of the reply.
//
// Plain TS interfaces only: nothing here validates against these types yet,
// so no zod schema (YAGNI). The reply is validated where it lands, in
// src/graph/llm.ts, against the schema this request went out with.

// Minimal local stand-in for a JSON Schema object.
export type JSONSchema = Record<string, unknown>;

export type NodeName = "extract" | "critic" | "classify" | "resolve";

export interface StructuredRequest {
  node: NodeName;
  /** Byte-stable per node: the instructions, never anything about this run. */
  system: string;
  user: string;
  /** The reply must satisfy this. */
  schema: JSONSchema;
}

export interface ModelProvider {
  structured<T>(req: StructuredRequest): Promise<T>;
}
