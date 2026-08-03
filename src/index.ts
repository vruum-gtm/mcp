#!/usr/bin/env node
/**
 * @vruum/mcp — stdio bridge for the hosted Vruum MCP.
 *
 * Two jobs, deliberately small:
 *
 * 1. `tools/list` is served STATICALLY from the bundled `tools.json` (the
 *    member-visible surface of https://api.vruum.ai/mcp, generated in the
 *    Vruum monorepo by `backend/scripts/dump_member_tools.py`). This is what
 *    lets registry crawlers and stdio-only clients introspect the tool
 *    surface without credentials.
 *
 * 2. `tools/call` proxies to the hosted server over Streamable HTTP with the
 *    caller's Vruum token. Without a token, calls return a structured error
 *    explaining how to get one — never a hang or a crash.
 *
 * Token resolution (mirrors @vruum/cli's `lib/config.ts` precedence):
 *   VRUUM_MCP_TOKEN env > VRUUM_TOKEN env > ~/.vruum/credentials (written by
 *   `vruum login`; directory overridable via VRUUM_CONFIG_DIR).
 *
 * Endpoint resolution:
 *   VRUUM_MCP_URL env > credentials apiUrl + "/mcp" > https://api.vruum.ai/mcp
 *
 * Note: `tools.json` intentionally carries no outputSchema — declaring one
 * would make this bridge's local error responses (which have no
 * structuredContent) protocol violations under SDK output validation.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_URL = "https://api.vruum.ai/mcp";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/index.js → package root sibling tools.json (also works from src/ via tsx).
const TOOLS_PATH = join(HERE, "..", "tools.json");
const PKG_PATH = join(HERE, "..", "package.json");

interface ToolsDoc {
  server: string;
  tool_count: number;
  tools: Array<Record<string, unknown> & { name: string }>;
}

interface Credentials {
  token?: string;
  apiUrl?: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readCredentials(): Credentials | null {
  try {
    const dir = process.env.VRUUM_CONFIG_DIR || join(homedir(), ".vruum");
    const parsed = readJson<Credentials>(join(dir, "credentials"));
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveToken(creds: Credentials | null): string | null {
  return (
    process.env.VRUUM_MCP_TOKEN || process.env.VRUUM_TOKEN || creds?.token || null
  );
}

function resolveMcpUrl(creds: Credentials | null): string {
  if (process.env.VRUUM_MCP_URL) return process.env.VRUUM_MCP_URL;
  if (creds?.apiUrl) return creds.apiUrl.replace(/\/+$/, "") + "/mcp";
  return DEFAULT_MCP_URL;
}

const NO_TOKEN_HELP = [
  "No Vruum token configured, so this call was not sent.",
  "",
  "The bridge needs a Vruum personal access token to execute tools:",
  "  1. Sign in at https://vruum.ai and create a token under Settings → API tokens (vk_live_…),",
  "  2. then either `export VRUUM_MCP_TOKEN=<token>` for this client,",
  "     or run `npx @vruum/cli` → `vruum login --token <token>` once.",
  "",
  "If your MCP client supports remote servers, prefer connecting it directly to",
  `${DEFAULT_MCP_URL} (OAuth) instead of this stdio bridge.`,
].join("\n");

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Lazily-connected client to the hosted server; reconnects once on failure. */
class RemoteProxy {
  private client: Client | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly version: string,
  ) {}

  private async connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.token}` },
      },
    });
    const client = new Client(
      { name: "vruum-mcp-bridge", version: this.version },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let client = this.client ?? (await this.connect());
    try {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (firstErr) {
      // One reconnect: sessions expire server-side and the transport does not
      // resurrect them for POSTs. A second consecutive failure is a real error.
      try {
        await this.client?.close();
      } catch {
        /* already dead */
      }
      this.client = null;
      try {
        client = await this.connect();
        return (await client.callTool({ name, arguments: args })) as CallToolResult;
      } catch {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        return errorResult(
          `Vruum MCP call failed against ${this.url}: ${msg}\n` +
            "Check that your token is valid (Settings → API tokens) and the " +
            "endpoint is reachable.",
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const pkg = readJson<{ version: string }>(PKG_PATH);
  const toolsDoc = readJson<ToolsDoc>(TOOLS_PATH);
  const creds = readCredentials();
  const token = resolveToken(creds);
  const mcpUrl = resolveMcpUrl(creds);
  const proxy = token ? new RemoteProxy(mcpUrl, token, pkg.version) : null;

  const server = new Server(
    { name: "vruum-mcp", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions:
        "Bridge to the hosted Vruum revenue-platform MCP. Tool listings are " +
        "served locally; tool calls execute against " +
        `${mcpUrl} under your Vruum token and are authorized server-side.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsDoc.tools as never,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!toolsDoc.tools.some((t) => t.name === name)) {
      return errorResult(`Unknown tool: ${name}`);
    }
    if (!proxy) return errorResult(NO_TOKEN_HELP);
    return proxy.call(name, (args ?? {}) as Record<string, unknown>);
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`vruum-mcp fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
