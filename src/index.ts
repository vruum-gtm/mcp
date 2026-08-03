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
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_URL = "https://api.vruum.ai/mcp";
// The SDK's per-request default is 60s, which real Vruum tools (research,
// imports) legitimately exceed. Overridable via VRUUM_MCP_TIMEOUT_MS.
const DEFAULT_CALL_TIMEOUT_MS = 300_000;

function resolveCallTimeoutMs(): number {
  const raw = Number(process.env.VRUUM_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
}

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

/**
 * Lazily-connected client to the hosted server.
 *
 * Failure semantics, deliberately conservative: a failed `tools/call` is
 * NEVER automatically retried. Many Vruum tools mutate state, send outreach
 * externally, or spend money, and an ambiguous failure (timeout, dropped
 * response) may mean the server already executed — a client-side replay could
 * double-send. The failed connection is discarded so the NEXT call gets a
 * fresh session, the error is surfaced structurally, and the calling harness
 * decides whether the tool is safe to retry. (This mirrors Vruum's own
 * server-side durable-send-intent discipline: ambiguous outcomes park, they
 * are not replayed.)
 */
class RemoteProxy {
  private client: Client | null = null;
  /** Serializes connection creation so concurrent first calls share one
   * client instead of racing to overwrite `this.client` (and later closing
   * each other's healthy connections). */
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly version: string,
  ) {}

  private getClient(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = (async () => {
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
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Discard `failed` only if it is still the current client — a concurrent
   * call may already have replaced it with a healthy connection. */
  private discard(failed: Client): void {
    if (this.client === failed) this.client = null;
    void failed.close().catch(() => {
      /* already dead */
    });
  }

  /**
   * Raw tools/call — deliberately NOT `client.callTool()`: the helper
   * validates results against outputSchemas cached by `listTools()`, and the
   * remote advertises outputSchemas this bridge intentionally does not. The
   * raw request form has no cache and no validation, so passthrough stays
   * passthrough. Timeout is raised above the SDK's 60s default because real
   * Vruum tools (research, imports) legitimately run longer.
   */
  private rawCall(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
      { timeout: resolveCallTimeoutMs(), resetTimeoutOnProgress: true },
    );
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch (connectErr) {
      // First-connect failures (DNS, invalid token, endpoint down) get the
      // same structured error path as call failures — never a raw handler
      // throw that surfaces as an opaque JSON-RPC internal error.
      const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
      return errorResult(
        `Could not connect to the Vruum MCP at ${this.url}: ${msg}\n` +
          "Check that your token is valid (Settings → API tokens) and the " +
          "endpoint is reachable.",
      );
    }
    try {
      return await this.rawCall(client, name, args);
    } catch (callErr) {
      this.discard(client);
      const msg = callErr instanceof Error ? callErr.message : String(callErr);
      return errorResult(
        `Vruum MCP call '${name}' failed against ${this.url}: ${msg}\n` +
          "NOT automatically retried — the server may or may not have executed " +
          "the action, and replaying a send/spend tool could duplicate it. " +
          "Verify state with a read tool (e.g. fetch/search) before retrying; " +
          "the next call will use a fresh connection.",
      );
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
      // `listChanged: false` is the honest declaration: the listing is a
      // static snapshot bundled at release time, so this server never emits
      // notifications/tools/list_changed.
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Bridge to the hosted Vruum revenue-platform MCP. Tool listings are " +
        "served locally; tool calls execute against " +
        `${mcpUrl} under your Vruum token and are authorized server-side.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    // The full list is returned in one page, so `nextCursor` is never set and
    // a client can never legitimately hold a cursor for this server. Spec:
    // "Invalid cursors SHOULD result in an error with code -32602."
    const cursor = request.params?.cursor;
    if (cursor !== undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Invalid cursor: this server returns all tools in a single page and " +
          "never issues a nextCursor.",
      );
    }
    return { tools: toolsDoc.tools as never };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Spec (server/tools#error-handling): errors in *finding* the tool are
    // PROTOCOL errors, not `isError` results — only errors originating from a
    // tool's execution use `isError: true` (so the model can self-correct).
    if (!toolsDoc.tools.some((t) => t.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    // A missing token IS an execution error — the tool exists and the model
    // should see why it could not run.
    if (!proxy) return errorResult(NO_TOKEN_HELP);
    return proxy.call(name, (args ?? {}) as Record<string, unknown>);
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`vruum-mcp fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
