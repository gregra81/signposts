// ModelProvider port, per 12-wire-contracts.md's "Provider adapter" section
// (and ToolDef from "Tools (Phase 4.5)"). Shape is verbatim from the doc —
// no fields added or removed. Plain TS interfaces only: nothing here
// validates against these types yet, so no zod schema (YAGNI).

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
  }): Promise<{ value: T; usage: Usage }>;
}
