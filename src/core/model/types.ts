// ModelProvider port, per 12-wire-contracts.md's "Provider adapter" section
// (and ToolDef from "Tools (Phase 4.5)"). Shape is the doc's, with one
// addition: `runTool`, because `ToolDef` describes a tool and cannot run one,
// and the doc's Phase 4.5 section says nothing about who executes the call.
// ToolDef and the `structured` request's documented fields are verbatim.
// Plain TS interfaces only: nothing here validates against these types yet,
// so no zod schema (YAGNI).

// Minimal local stand-in for a JSON Schema object. Not validated against
// anywhere in this slice — just a typed placeholder for the `schema` /
// `inputSchema` params.
export type JSONSchema = Record<string, unknown>;

export type NodeName = "extract" | "critic" | "classify" | "resolve";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * What one tool call handed back, as the text the model sees.
 *
 * `isError` is separate from the content rather than encoded in it: a
 * rejected path and a file that happens to contain the word "error" must not
 * look the same on the wire, and the provider maps this onto the tool_result
 * block's own `is_error` flag.
 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/**
 * Executes one tool call. Additional to 12-wire-contracts.md's shape, which
 * defines `ToolDef` but nothing that can run one: a name, a sentence and a
 * schema describe a tool, they do not perform it. Kept beside `tools` rather
 * than folded into `ToolDef` so the documented type stays verbatim.
 *
 * Never rejects for anything the model did — an unknown tool, arguments that
 * fail their schema, a path outside the repository — because those are turns
 * in the conversation, not faults in the run. It rejects only when the
 * machine underneath it fails.
 */
export type ToolRunner = (name: string, input: unknown) => Promise<ToolResult>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  costUsd: number;
}

export interface ModelProvider {
  structured<T>(req: {
    node: NodeName;
    system: string; // byte-stable => cacheable. No timestamps, no ids.
    user: string;
    schema: JSONSchema;
    batchable?: boolean;
    tools?: ToolDef[]; // Phase 4.5, resolve only
    runTool?: ToolRunner; // Phase 4.5, required whenever `tools` is supplied
  }): Promise<{ value: T; usage: Usage }>;
}
