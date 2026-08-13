// Fixture-backed ModelProvider: lets the graph run offline against
// recorded model responses. Never calls a live API — a cache miss is a
// hard error, not a fallback.

import type {
  JSONSchema,
  ModelProvider,
  NodeName,
  ToolDef,
  Usage,
} from "../../core/model/types.js";

export interface FixtureEntry {
  value: unknown;
  usage: Usage;
}

/** Deterministic lookup key: (node, resolved model id, system, user). */
export function fixtureKey(
  node: NodeName,
  modelId: string,
  system: string,
  user: string,
): string {
  return JSON.stringify([node, modelId, system, user]);
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class FixtureModelProvider implements ModelProvider {
  private readonly fixtures: Record<string, FixtureEntry>;
  private readonly models: Record<NodeName, string>;

  constructor(
    fixtures: Record<string, FixtureEntry>,
    models: Record<NodeName, string>,
  ) {
    this.fixtures = fixtures;
    this.models = models;
  }

  async structured<T>(req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
    batchable?: boolean;
    tools?: ToolDef[];
  }): Promise<{ value: T; usage: Usage }> {
    const modelId = this.models[req.node];
    const key = fixtureKey(req.node, modelId, req.system, req.user);
    const entry = this.fixtures[key];
    if (!entry) {
      throw new Error(
        `FixtureModelProvider: no fixture recorded for node=${req.node} model=${modelId} ` +
          `system=${JSON.stringify(truncate(req.system))} user=${JSON.stringify(truncate(req.user))}`,
      );
    }
    return { value: entry.value as T, usage: entry.usage };
  }
}
