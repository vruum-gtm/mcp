# Vruum MCP (`@vruum/mcp`)

Official MCP access to [Vruum](https://vruum.ai) — the AI revenue platform. Operate outbound, deals, pipeline, and CRM automation from your agent: people, deals, outreach, engagement, and research tools over one MCP.

This package is the **stdio bridge** to the hosted Vruum MCP server. It serves the advertised tool surface locally (no credentials needed to introspect) and proxies tool execution to `https://api.vruum.ai/mcp` under your Vruum token. Every call is authorized server-side; the bridge grants no authority beyond what your Vruum account can already do.

> **Connecting a modern client? Prefer the remote server directly.**
> Clients that support remote MCP (Claude Code, Claude Desktop, Cursor, Codex, …) should connect straight to `https://api.vruum.ai/mcp` (OAuth 2.1, or `Authorization: Bearer vk_live_…`). This bridge exists for stdio-only clients and for tool-surface introspection. See [vruum.ai/docs/mcp](https://vruum.ai/docs/mcp).

## Install & connect

```json
{
  "mcpServers": {
    "vruum": {
      "command": "npx",
      "args": ["-y", "@vruum/mcp"],
      "env": { "VRUUM_MCP_TOKEN": "vk_live_…" }
    }
  }
}
```

Get a token in the Vruum web app under **Settings → API tokens**. A Vruum account is required to execute tools; listing tools works without one.

Already using the CLI? `npx @vruum/cli` → `vruum login --token vk_live_…` stores credentials in `~/.vruum/credentials`, and the bridge picks them up automatically.

### Configuration

| Env var | Meaning | Default |
| --- | --- | --- |
| `VRUUM_MCP_TOKEN` | Vruum personal access token | — (falls back to `VRUUM_TOKEN`, then `~/.vruum/credentials`) |
| `VRUUM_MCP_URL` | Hosted MCP endpoint | `https://api.vruum.ai/mcp` |
| `VRUUM_MCP_TIMEOUT_MS` | Per-call timeout (research/import tools run long) | `300000` |
| `VRUUM_CONFIG_DIR` | Credentials directory | `~/.vruum` |

## What's inside

- **[`tools.json`](tools.json)** — the client-advertised tool surface: **29 curated compound tools** (`search`, `fetch`, `research`, `skill`, and the `manage_*` / `get_*` families covering people, deals, outreach, engagement, content, campaigns, and revenue), each carrying MCP safety annotations. This is exactly what a real Vruum session is advertised — one tool per decision rather than a sprawl of granular endpoints, so an agent never has to disambiguate between overlapping legacy verbs. Generated from the live server definition and served verbatim for `tools/list`.
- **[`src/index.ts`](src/index.ts)** — the bridge: static listings, proxied calls, and structured errors
  (a missing token is an explanation, not a crash). **A failed call is never automatically
  retried** — many of these tools send outreach or spend money, and an ambiguous failure may
  mean the server already executed, so a silent replay could double-send. The dead connection
  is discarded, the error says so, and your agent decides whether the tool is safe to re-run.

The distinctive design position of the Vruum MCP: **your AI harness authors all sales and marketing prose.** The server schedules, gates, persists, and sends — it has no server-side message generation. Outreach drafts surface to your agent as work items rather than being written for you.

## Development

This repository is a **build artifact of the Vruum monorepo**, resynced automatically on release — `tools.json` is regenerated from the live server definition, so it never drifts from what the hosted server actually exposes.

Issues and PRs are welcome here: maintainers upstream accepted changes into the monorepo, and they flow back on the next sync.

```sh
npm install
npm test        # builds, then black-box JSON-RPC tests against the built binary
```

## Links

- [Vruum](https://vruum.ai) · [MCP docs](https://vruum.ai/docs/mcp) · [Getting started](https://vruum.ai/docs/getting-started)
- Official registry entry: `ai.vruum/mcp` · Claude/Codex plugin: [`vruum-gtm/skills`](https://github.com/vruum-gtm/skills)

## License

[MIT](LICENSE)
