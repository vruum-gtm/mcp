import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Diagnostics } from "../dist/diagnostics.js";

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "vruum-diagnostics-"));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return { root, endpoint, make: (token = "synthetic") => new Diagnostics(root, endpoint, token, new Set(["fetch"]), () => "claude") };
}

async function queued(root) {
  const dirs = await readdir(join(root, "mcp-diagnostics"));
  const dir = join(root, "mcp-diagnostics", dirs[0]);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
}

test("offline diagnostics survive restart and delete only after durable acknowledgement", async (t) => {
  let status = 503;
  const received = [];
  const f = await fixture(t, async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    assert.equal(req.url, "/mcp/diagnostics");
    received.push(JSON.parse(body));
    res.writeHead(status).end("{}");
  });
  const attempt = randomUUID();
  const first = f.make(null);
  await first.record(attempt, "tools/call", "private-customer-input", "missing_token");
  await first.flush();
  assert.equal(received.length, 0);
  let rows = await queued(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, "unknown");
  assert.equal(JSON.stringify(rows).includes("private-customer-input"), false);
  const restarted = f.make();
  await restarted.flush();
  assert.equal((await queued(f.root)).length, 1, "503 retains original ids for retry");
  status = 200;
  await restarted.flush();
  assert.equal((await queued(f.root)).length, 0);
  assert.equal(received[0].events[0].id, received[1].events[0].id);
  assert.equal(received[1].events[0].attempt_id, attempt);
});

test("redirects never forward diagnostic credentials", async (t) => {
  let requests = 0;
  const f = await fixture(t, async (req, res) => {
    requests++;
    res.writeHead(307, { Location: "/stolen" }).end();
  });
  const d = f.make();
  await d.record(randomUUID(), "tools/list", "unknown", "success");
  await d.flush();
  assert.equal(requests, 1);
  assert.equal((await queued(f.root)).length, 1);
});

test("a restarted bridge drains a multi-batch backlog without new activity", async (t) => {
  const received = [];
  const f = await fixture(t, async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    received.push(JSON.parse(body).events);
    res.writeHead(200).end("{}");
  });
  const offline = f.make(null);
  for (let i = 0; i < 123; i++) await offline.record(randomUUID(), "tools/call", "fetch", "success");
  await f.make().flush();
  assert.equal((await queued(f.root)).length, 0);
  assert.deepEqual(received.map((batch) => batch.length), [50, 50, 23]);
  assert.equal(new Set(received.flat().map((event) => event.id)).size, 123);
});

test("a transient outage schedules recovery without keeping the bridge alive", async (t) => {
  // Capture only the retry clock; fetch retains its real network/timeouts.
  const original = globalThis.setTimeout;
  let retry;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 60000) return original(callback, delay, ...args);
    retry = { callback, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
    return retry;
  });
  let status = 503;
  const f = await fixture(t, (req, res) => res.writeHead(status).end("{}"));
  const d = f.make();
  await d.record(randomUUID(), "tools/list", "unknown", "success");
  await d.flush();
  assert.equal(retry.unrefCalled, true);
  status = 200;
  retry.callback();
  await d.flush();
  assert.equal((await queued(f.root)).length, 0);
});

test("queue is bounded and loss stays visible while latest outcome is retained", async (t) => {
  const f = await fixture(t, (req, res) => res.writeHead(503).end());
  const d = f.make(null);
  for (let i = 0; i < 502; i++) await d.record(randomUUID(), "tools/call", "fetch", "success");
  const rows = await queued(f.root);
  assert.equal(rows.length, 500);
  assert.ok(rows.some((r) => r.outcome === "queue_overflow"));
  assert.ok(rows.some((r) => r.outcome === "success"));
});
