// Fixture-backed ModelProvider: lets the graph run against recorded replies,
// with no host and no session behind it. A miss is a hard error, not a
// fallback — a test that silently answered its own question would prove
// nothing.

import type { JSONSchema, ModelProvider, NodeName } from "../../core/model/types.ts";

/** Deterministic lookup key: (node, system, user). */
export function fixtureKey(node: NodeName, system: string, user: string): string {
  return JSON.stringify([node, system, user]);
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class FixtureModelProvider implements ModelProvider {
  private readonly fixtures: Record<string, unknown>;

  constructor(fixtures: Record<string, unknown>) {
    this.fixtures = fixtures;
  }

  async structured<T>(req: {
    node: NodeName;
    system: string;
    user: string;
    schema: JSONSchema;
  }): Promise<T> {
    const key = fixtureKey(req.node, req.system, req.user);
    if (!(key in this.fixtures)) {
      throw new Error(
        `FixtureModelProvider: no fixture recorded for node=${req.node} ` +
          `system=${JSON.stringify(truncate(req.system))} user=${JSON.stringify(truncate(req.user))}`,
      );
    }
    return this.fixtures[key] as T;
  }
}
