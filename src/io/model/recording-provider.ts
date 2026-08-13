// Stub ModelProvider that will wrap the real Anthropic client and record
// fixtures for FixtureModelProvider to replay. Not implemented yet — that
// lands in Slice B, along with the "@anthropic-ai/sdk" import and the API
// key. This file must not call a live model or read env in the meantime.

import type {
  JSONSchema,
  ModelProvider,
  NodeName,
  ToolDef,
  Usage,
} from "../../core/model/types.js";
import type { FixtureEntry } from "./fixture-provider.js";

export class RecordingModelProvider implements ModelProvider {
  private readonly client: unknown;
  private readonly writeFixture: (key: string, entry: FixtureEntry) => void;

  constructor(
    client: unknown,
    writeFixture: (key: string, entry: FixtureEntry) => void,
  ) {
    this.client = client;
    this.writeFixture = writeFixture;
  }

  async structured<T>(_req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
    batchable?: boolean;
    tools?: ToolDef[];
  }): Promise<{ value: T; usage: Usage }> {
    throw new Error("not implemented — Slice B");
  }
}
