/** Bounded, private metadata outbox. Never stores tokens, arguments or results. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Family = "claude" | "codex" | "chatgpt" | "vruum-mcp-bridge" | "unknown";
export function family(name: string | undefined): Family {
  const value = (name ?? "").toLowerCase();
  for (const prefix of ["claude", "codex", "chatgpt", "vruum-mcp-bridge"] as const) {
    if (value === prefix || value.startsWith(prefix + "-") || value.startsWith(prefix + "/")) return prefix;
  }
  return "unknown";
}

type Outcome = "started" | "success" | "tool_error" | "missing_token" | "unknown_tool"
  | "invalid_cursor" | "connect_error" | "call_error" | "queue_overflow" | "protocol_error" | "cancelled";
export interface Observation {
  id: string;
  attempt_id: string;
  observed_at: string;
  client: Family;
  method: "tools/call" | "tools/list" | "unknown";
  tool_name: string;
  outcome: Outcome;
  duration_ms: number;
}
const MAX_PENDING = 500;
const FILE = /^\d{13}-[0-9a-f-]{36}\.json$/;

export class Diagnostics {
  private readonly directory: string;
  private active: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private retry: ReturnType<typeof setTimeout> | null = null;
  constructor(
    root: string,
    private readonly endpoint: string,
    private readonly token: string | null,
    private readonly tools: Set<string>,
    private readonly getClient: () => Family,
  ) {
    // Keep environments separate without retaining the configured URL.
    this.directory = join(root, "mcp-diagnostics", createHash("sha256").update(endpoint).digest("hex"));
  }

  async record(attempt: string, method: Observation["method"], tool: string, outcome: Outcome, duration = 0): Promise<void> {
    const observation: Observation = {
      id: randomUUID(), attempt_id: attempt, observed_at: new Date().toISOString(),
      client: this.getClient(), method, tool_name: this.tools.has(tool) ? tool : "unknown",
      outcome, duration_ms: Math.min(86400000, Math.max(0, Math.round(duration))),
    };
    this.writing = this.writing.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = (await readdir(this.directory)).filter((name) => FILE.test(name)).sort();
      if (names.length >= MAX_PENDING) {
        // Preserve an explicit loss marker, even when connectivity is absent.
        await Promise.all(names.slice(0, 2).map((name) => unlink(join(this.directory, name)).catch(() => {})));
        await this.write({ ...observation, id: randomUUID(), outcome: "queue_overflow" });
        console.error("vruum-mcp diagnostics queue overflow; coverage is incomplete");
      }
      await this.write(observation);
    }).catch(() => {
      console.error("vruum-mcp diagnostics storage unavailable; coverage is incomplete");
    });
    await this.writing;
  }

  private async write(observation: Observation): Promise<void> {
    const destination = join(this.directory, `${Date.now()}-${observation.id}.json`);
    const temporary = destination + ".tmp";
    await writeFile(temporary, JSON.stringify(observation), { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  }

  flush(): Promise<void> {
    if (!this.token) return Promise.resolve();
    if (!this.active) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.active = this.upload().finally(() => { this.active = null; });
    }
    return this.active;
  }

  private retryLater(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.flush();
    }, 60000).unref();
  }

  private async upload(): Promise<void> {
    try {
      const url = new URL(this.endpoint);
      // A diagnostic must not leak credentials through a redirect or downgrade.
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return;
      url.pathname = url.pathname.replace(/\/+$/, "") + "/diagnostics";
      url.search = "";
      url.hash = "";
      // Drain the bounded backlog without requiring another business call.
      // Ten batches match the collector's per-minute allowance.
      for (let batch = 0; batch < 10; batch++) {
        await this.writing;
        const names = (await readdir(this.directory).catch(() => []))
          .filter((name) => FILE.test(name)).sort().slice(0, 50);
        if (!names.length) return;
        const events = await Promise.all(names.map(async (name) => {
          const raw = await readFile(join(this.directory, name), "utf8");
          if (raw.length > 4096) throw new Error("invalid diagnostic");
          return JSON.parse(raw);
        }));
        const response = await fetch(url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "X-Vruum-Client": this.getClient() },
          body: JSON.stringify({ events }),
        });
        if (response.status !== 200) {
          if (response.status === 429 || response.status >= 500) this.retryLater();
          return;
        }
        await Promise.all(names.map((name) => unlink(join(this.directory, name)).catch(() => {})));
      }
      if ((await readdir(this.directory)).some((name) => FILE.test(name))) this.retryLater();
    } catch {
      // Durable records stay for a later connection. Never log the exception:
      // fetch errors and endpoint URLs can carry credentials.
      this.retryLater();
    }
  }
}
