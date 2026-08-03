/**
 * Black-box tests for the stdio bridge: spawn the built binary and speak
 * newline-delimited JSON-RPC over stdin/stdout, exactly as an MCP client
 * (or a registry crawler's introspection probe) would.
 *
 * VRUUM_CONFIG_DIR points at a nonexistent directory in every spawn so the
 * developer's real ~/.vruum/credentials can never leak into the token-less
 * assertions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "index.js");
const TOOLS = JSON.parse(readFileSync(join(ROOT, "tools.json"), "utf8"));

/** Spawn the bridge, send JSON-RPC messages, resolve with responses by id. */
function rpc(messages, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VRUUM_CONFIG_DIR: "/nonexistent-vruum-config",
        VRUUM_MCP_TOKEN: "",
        VRUUM_TOKEN: "",
        ...env,
      },
    });
    const wanted = new Set(messages.filter((m) => m.id !== undefined).map((m) => m.id));
    const responses = new Map();
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for responses; stderr: ${stderr}`));
    }, timeoutMs);

    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.size === wanted.size) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "0.0.0" },
  },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

test("initialize handshake identifies the bridge", async () => {
  const res = await rpc([INITIALIZE]);
  const init = res.get(1);
  assert.equal(init.result.serverInfo.name, "vruum-mcp");
  assert.ok(init.result.capabilities.tools, "must advertise tools capability");
});

test("tools/list serves the full bundled surface without credentials", async () => {
  const res = await rpc([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const tools = res.get(2).result.tools;
  assert.equal(tools.length, TOOLS.tool_count);
  // The client facade view — curated compound tools, not the granular tail.
  assert.ok(tools.length >= 20, "expected the client facade surface");
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has("get_daily_briefing"));
  assert.ok(names.has("search"));
  // Operator tools must never appear in the public artifact — this includes
  // annotation-gated ones (role: operator), not just the OPERATOR_TOOLS set.
  for (const op of ["get_operator_overview", "manage_clients", "manage_ad_campaign"]) {
    assert.ok(!names.has(op), `operator tool ${op} leaked into tools.json`);
  }
  for (const t of tools) {
    assert.ok(t.name, "every tool has a name");
    assert.ok(t.inputSchema, `tool ${t.name} has an inputSchema`);
    assert.ok(t.annotations, `tool ${t.name} carries safety annotations`);
    assert.equal(t.outputSchema, undefined, `tool ${t.name} must not declare outputSchema`);
    assert.equal(
      (t._meta ?? {}).defer_loading,
      undefined,
      `tool ${t.name} must not carry the stripped defer_loading tag`,
    );
  }
});

test("tools/call without a token returns a structured, instructive error", async () => {
  const res = await rpc([
    INITIALIZE,
    INITIALIZED,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_daily_briefing", arguments: {} },
    },
  ]);
  const result = res.get(3).result;
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /VRUUM_MCP_TOKEN/);
  assert.match(text, /vruum\.ai/);
});

test("tools/call for an unknown tool is a PROTOCOL error, not an isError result", async () => {
  // Spec (server/tools#error-handling): errors in *finding* the tool are
  // JSON-RPC errors (-32602 Invalid params); `isError: true` is reserved for
  // errors originating from a tool's execution.
  const res = await rpc([
    INITIALIZE,
    INITIALIZED,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "definitely_not_a_tool", arguments: {} },
    },
  ]);
  const msg = res.get(4);
  assert.equal(msg.result, undefined, "must not return a result");
  assert.equal(msg.error.code, -32602, "must be Invalid params");
  assert.match(msg.error.message, /Unknown tool/);
});

test("tools/list rejects a cursor it never issued (-32602)", async () => {
  // This server returns every tool in one page and never sets nextCursor, so
  // any cursor is invalid. Spec: invalid cursors SHOULD be -32602.
  const res = await rpc([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: "2.0", id: 5, method: "tools/list", params: { cursor: "bogus" } },
  ]);
  const msg = res.get(5);
  assert.equal(msg.result, undefined, "must not return a result");
  assert.equal(msg.error.code, -32602);
});

test("declares the tools capability with listChanged:false (static listing)", async () => {
  const res = await rpc([INITIALIZE]);
  const caps = res.get(1).result.capabilities;
  assert.ok(caps.tools, "servers supporting tools MUST declare the tools capability");
  assert.equal(caps.tools.listChanged, false, "listing is a static snapshot");
});

test("writes nothing but JSON-RPC to stdout", async () => {
  // stdio transport: "The server MUST NOT write anything to its stdout that
  // is not a valid MCP message." Every stdout line must parse as JSON-RPC.
  const res = await rpc([
    INITIALIZE,
    INITIALIZED,
    { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} },
  ]);
  // rpc() JSON.parses every non-empty stdout line, so reaching here without a
  // throw already proves stdout hygiene; assert we got the response back.
  assert.equal(res.get(6).result.tools.length, TOOLS.tool_count);
});
