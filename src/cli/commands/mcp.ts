// `signpost mcp` — the read path, served over stdio (10-roadmap.md Phase 6.5).
//
// Not typed by a person, in the same way `worker` is not: the plugin's
// manifest starts it (`.claude-plugin/plugin.json`), Claude Code owns both
// ends of its pipe, and it exits when that pipe closes. It is a command rather
// than a second binary so it is built by the one composition root like
// everything else (R2).
//
// It spends no tokens and needs no consent: the whole point of the read path
// is that a new hire who cloned the repo this morning, has run nothing and
// holds no credential can still read what the team recorded (05-retrieval.md,
// and the reason `index` is not gated either — src/core/cli/dispatch.ts).
//
// **stdout is the JSON-RPC wire.** Anything else printed there is a protocol
// error, and the things this process loads are not all silent: transformers.js
// logs, and any stray `console.log` under `src/` would land in the middle of a
// response frame. So the global console is rebound to stderr for the life of
// the server, once, here — the one place that can be sure it is the wire.

import { Console } from "node:console";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ExitCode } from "../../app.ts";
import { EXIT_CODES } from "../../core/cli/exit-codes.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  renderOutput,
  searchInputSchema,
  searchOutputSchema,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  SEARCH_TOOL_TITLE,
  type SearchToolInput,
} from "../../core/mcp/search-tool.ts";
import { createSearchService, type SearchService } from "../../io/mcp/search-service.ts";
// The server names itself to the client; the package's own version is the
// only honest answer, and importing it keeps a second copy from drifting.
import packageJson from "../../../package.json" with { type: "json" };

/** Matches the key the plugin manifest registers this server under. */
const SERVER_NAME = "signposts";

export interface McpCommandInput {
  config: ResolvedConfig;
  repoRoot: string;
  stderr: NodeJS.WritableStream;
  /** Resolves when the client closes the connection — the process's own stdin in production. */
  stdin: NodeJS.ReadableStream;
}

/**
 * Registers the one tool. `readOnlyHint`/`openWorldHint` are the honest
 * annotations for it: it opens the database read-only (src/io/db/read-only.ts)
 * and reaches nothing outside this machine.
 */
export function buildMcpServer(search: SearchService): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: packageJson.version }, { capabilities: { tools: {} } });

  server.registerTool(
    SEARCH_TOOL_NAME,
    {
      title: SEARCH_TOOL_TITLE,
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input: SearchToolInput) => {
      const output = await search.search({
        query: input.query,
        ...(input.paths === undefined ? {} : { paths: input.paths }),
        limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      });
      // MCP's content-block discriminator. It collides with the constants
      // module's TEXT_BLOCK_TYPE, which is the same word for a different
      // thing — that one names a block in a Claude Code transcript and is
      // read by the gutter. Neither is tunable, and importing one into the
      // other would tie this tool's wire format to transcript parsing.
      // eslint-disable-next-line signposts/no-magic-literal -- coincidental collision; see above
      return { content: [{ type: "text", text: renderOutput(output) }], structuredContent: output };
    },
  );

  return server;
}

export async function runMcp({ config, repoRoot, stderr, stdin }: McpCommandInput): Promise<ExitCode> {
  globalThis.console = new Console(stderr, stderr);

  const warn = (message: string): void => {
    stderr.write(`${message}\n`);
  };
  const search = createSearchService({ config, repoRoot, warn });

  const handle = serveStdio(() => buildMcpServer(search), { onerror: (error) => warn(String(error)) });

  // The server lives as long as the client holds the pipe open. `close` covers
  // a client that goes away without ending the stream cleanly; `end` is the
  // ordinary shutdown.
  await new Promise<void>((resolve) => {
    stdin.once("end", resolve);
    stdin.once("close", resolve);
  });
  await handle.close();

  return EXIT_CODES.ok;
}
