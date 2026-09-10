// The MCP server as Claude Code actually starts it: a real `node
// bin/signpost.js mcp` process, spoken to over its own stdin/stdout.
//
// In-process tests of the service prove what it answers; this proves the two
// things only a process can. That the transport is stdio and the framing is
// intact — **every line on stdout is a JSON-RPC message and nothing else**,
// which is why src/cli/commands/mcp.ts rebinds the global console to stderr.
// And that a cold clone's tool call comes back as a *result*: an error there
// would surface inside a Claude turn for the ordinary state of a fresh
// checkout (05-retrieval.md, "The MCP server on a cold clone").
//
// The JSON-RPC is written by hand rather than through a client library: what
// is under test is the wire, and a client that shares a codebase with the
// server would hide a framing bug from both.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_TOOL_NAME, diagnosticFor, SEARCH_UNAVAILABLE } from "../../../src/core/mcp/search-tool.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = path.join(PROJECT_ROOT, "bin", "signpost.js");
const PROTOCOL_VERSION = "2025-06-18";

interface Response {
  id: number;
  result?: unknown;
  error?: unknown;
}

/** One stdio client: writes requests, parses whole lines, keeps every line it saw. */
class Client {
  readonly lines: string[] = [];
  private readonly pending = new Map<number, (response: Response) => void>();
  private buffer = "";
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;

  // A plain field rather than a parameter property: `erasableSyntaxOnly` is on
  // (Node strips types, it does not compile them), and a parameter property
  // emits code.
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          this.lines.push(line);
          this.deliver(line);
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private deliver(line: string): void {
    let message: Response;
    try {
      message = JSON.parse(line) as Response;
    } catch {
      return; // Kept in `lines` — the framing assertion below is what fails on it.
    }
    const resolve = this.pending.get(message.id);
    if (resolve !== undefined) {
      this.pending.delete(message.id);
      resolve(message);
    }
  }

  request(method: string, params: unknown): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
}

describe("signpost mcp over stdio", () => {
  let homeDir: string;
  let repoRoot: string;
  let child: ChildProcessWithoutNullStreams;
  let client: Client;

  beforeEach(async () => {
    homeDir = mkdtempSync(path.join(tmpdir(), "signposts-stdio-home-"));
    repoRoot = mkdtempSync(path.join(tmpdir(), "signposts-stdio-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repoRoot });

    child = spawn(process.execPath, [ENTRY, "mcp"], {
      cwd: repoRoot,
      // HOME points the state directory at the temp home, so this test never
      // reads or writes the developer's own database.
      env: { ...process.env, HOME: homeDir },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    client = new Client(child);

    const initialize = await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "behaviour-test", version: "0" },
    });
    expect(initialize.error).toBeUndefined();
    client.notify("notifications/initialized");
  }, 60_000);

  afterEach(() => {
    child.kill();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("advertises exactly one tool, the one 12-wire-contracts.md names", async () => {
    const listed = (await client.request("tools/list", {})).result as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };

    expect(listed.tools.map((tool) => tool.name)).toEqual([SEARCH_TOOL_NAME]);
    expect(Object.keys(listed.tools[0]!.inputSchema.properties).sort()).toEqual(["limit", "paths", "query"]);
  });

  it("answers a query against a repo with no index with a result, not an error", async () => {
    const response = await client.request("tools/call", {
      name: SEARCH_TOOL_NAME,
      arguments: { query: "can I run migrations against staging" },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent: { results: unknown[]; diagnostic: string };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.results).toEqual([]);
    expect(result.structuredContent.diagnostic).toBe(diagnosticFor(SEARCH_UNAVAILABLE.no_index));
    expect(result.content[0]?.text).toBe(result.structuredContent.diagnostic);
  });

  it("keeps stdout to JSON-RPC messages and nothing else", async () => {
    await client.request("tools/call", { name: SEARCH_TOOL_NAME, arguments: { query: "anything" } });

    expect(client.lines.length).toBeGreaterThan(0);
    for (const line of client.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
