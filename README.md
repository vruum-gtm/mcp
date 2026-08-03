# Vruum MCP (`@vruum/mcp`)

[![npm](https://img.shields.io/npm/v/@vruum/mcp)](https://www.npmjs.com/package/@vruum/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![registry](https://img.shields.io/badge/MCP%20registry-ai.vruum%2Fmcp-6E56CF)](https://registry.modelcontextprotocol.io)

Official MCP access to [**Vruum**](https://vruum.ai), the AI revenue platform. Give your agent the whole revenue motion — research prospects, build pipeline, run email and LinkedIn outreach, triage replies, manage deals through close, and read Stripe-backed revenue truth — through **29 compound tools** rather than a sprawl of endpoints.

This package is a **stdio bridge**: it serves the tool surface locally (no credentials needed to introspect) and proxies execution to `https://api.vruum.ai/mcp` under your token. Every call is authorized server-side — the bridge grants no authority your Vruum account doesn't already have.

> [!TIP]
> **Using a client that supports remote MCP? Connect directly instead.**
> Claude Code, Claude Desktop, Cursor, Codex and friends should point straight at `https://api.vruum.ai/mcp` (OAuth 2.1). Fewer moving parts and no token in an env var. This bridge exists for **stdio-only clients** and for **credential-free tool introspection**. See [vruum.ai/docs/mcp](https://vruum.ai/docs/mcp).

## Quickstart

You need Node 20+ and a Vruum account. Create a personal access token in the web app under **Settings → API tokens** (`vk_live_…`).

<details open>
<summary><b>Claude Desktop / Claude Code</b> — <code>claude_desktop_config.json</code> or <code>.mcp.json</code></summary>

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
</details>

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code></summary>

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
</details>

<details>
<summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.vruum]
command = "npx"
args = ["-y", "@vruum/mcp"]
env = { VRUUM_MCP_TOKEN = "vk_live_…" }
```
</details>

<details>
<summary><b>Already use the Vruum CLI?</b> — no token needed here</summary>

```sh
npx @vruum/cli
vruum login --token vk_live_…
```

Credentials land in `~/.vruum/credentials` and the bridge picks them up automatically — omit the `env` block entirely.
</details>

Verify it works without configuring anything:

```sh
npx -y @modelcontextprotocol/inspector --cli npx -y @vruum/mcp --method tools/list
```

## What you can ask for

Once connected, these are ordinary requests to your agent:

| You say | What happens |
| --- | --- |
| *"What should I work on today?"* | `get_daily_briefing` — pending approvals, new replies, stalled deals, warm paths, one recommended next action |
| *"Review my outreach drafts"* | `get_outreach_review` → you approve, edit, or reject each one |
| *"Research Acme Corp and tell me if they fit"* | `research` — website, funding, careers signals, ICP match with reasoning |
| *"Find a warm intro to this person"* | `find_warm_path` — separates verified paths from unverified connector candidates |
| *"Which campaigns are actually working?"* | `get_campaign_outcomes` — contacted, replies, meetings booked, cohort-consistent |
| *"What's at risk in my pipeline?"* | `inspect_pipeline` — the 5 most at-risk deals, risk-first |
| *"Draft a LinkedIn post about X"* | `manage_content` — your agent writes it, you approve, Vruum schedules and publishes |

> [!IMPORTANT]
> **Your agent writes the prose — the server never does.** Outreach copy, replies, LinkedIn posts and comments surface to your harness as work items. Vruum schedules, gates, persists and sends; it has no server-side message generation. That's a deliberate design position, not a gap.

## Tool surface

29 compound tools — one per decision, so an agent never disambiguates between overlapping verbs. `read` is safe to call freely; `write` mutates; `destructive` can delete or archive.

| Area | Tools |
| --- | --- |
| **Daily operating** | `get_daily_briefing` · `get_next_actions` · `inspect_pipeline` |
| **Search & research** | `search` · `fetch` · `research` · `import_prospects` · `find_warm_path` |
| **People** | `get_person_360` · `manage_person` |
| **Outreach** | `get_outreach_review` · `manage_messages` · `manage_outreach` · `manage_relationship_action` |
| **Engagement & content** | `get_engagement_review` · `manage_engagements` · `get_content_review` · `manage_content` |
| **Campaigns & performance** | `manage_campaign` · `get_campaign_outcomes` · `get_performance_metrics` |
| **Deals** | `get_deal_360` · `manage_deal` |
| **Revenue** | `get_revenue` · `manage_revenue` |
| **Accounts & knowledge** | `manage_account` · `manage_kb` |
| **Config & skills** | `manage_settings` · `skill` |

Full schemas, descriptions and MCP safety annotations live in [`tools.json`](tools.json) — generated from the live server definition, never hand-edited.

## Configuration

| Env var | Meaning | Default |
| --- | --- | --- |
| `VRUUM_MCP_TOKEN` | Vruum personal access token | falls back to `VRUUM_TOKEN`, then `~/.vruum/credentials` |
| `VRUUM_MCP_URL` | Hosted MCP endpoint | `https://api.vruum.ai/mcp` |
| `VRUUM_MCP_TIMEOUT_MS` | Per-call timeout — research and imports run long | `300000` |
| `VRUUM_CONFIG_DIR` | Credentials directory | `~/.vruum` |

## How it works

```
your agent  ──stdio/JSON-RPC──▶  @vruum/mcp
                                     │
                    tools/list ──────┤  served locally from tools.json
                                     │  (no network, no credentials)
                                     │
                    tools/call ──────┴──HTTPS+Bearer──▶  api.vruum.ai/mcp
                                                          (authorized server-side)
```

Listings are a **static snapshot** bundled at release. That's what makes credential-free introspection possible, and it means a newly added tool won't *appear* until the next release — calls still execute correctly, since they proxy through. A CI guard regenerates `tools.json` on every backend change, so the snapshot can be one release old but never silently wrong.

## Safety and credentials

- **Server-side authorization.** The bridge adds no permissions. Your token is exactly your Vruum account, and role/tenant checks happen on the server.
- **No automatic retries.** A failed `tools/call` is never replayed. Many of these tools send outreach or spend money, and an ambiguous failure may mean the server already executed — a silent retry could double-send. The connection is discarded, the error says so, and your agent decides whether re-running is safe.
- **Your token never leaves your machine** except as a `Bearer` header to `api.vruum.ai`.

> [!WARNING]
> **The bridge picks up ambient credentials.** With no `VRUUM_MCP_TOKEN` set it falls back to `~/.vruum/credentials`. If you are logged in with the Vruum CLI, then running this server — via the MCP Inspector, a client, or a script — executes **against your real account and real data**. Write tools will really write.
>
> To poke at it with no credentials, pass an explicit env that reaches the process:
>
> ```sh
> env -i PATH="$PATH" HOME=/tmp/empty node dist/index.js
> ```
>
> Note that MCP clients following the SDK default only forward an allowlist (`HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`) to spawned servers — so setting `VRUUM_CONFIG_DIR` in your shell may be **stripped before it reaches the bridge**, while `HOME` survives and the credentials file is found anyway. Set credentials in the client's own `env` block instead.

## Development

This repo is a **build artifact of the Vruum monorepo**, resynced automatically on release. `tools.json` is generated from the live server definition, so it cannot drift from what the hosted server exposes.

```
src/index.ts   the bridge — token resolution, static listings, proxied calls
tools.json     generated tool surface (do not edit by hand)
test/          black-box tests: spawn the built binary, speak raw JSON-RPC
```

```sh
npm install
npm test        # builds, then runs the black-box suite
npm run typecheck
```

Tests drive the built binary over stdin/stdout and assert **at the wire level** rather than through an SDK client — an SDK-mediated test hides protocol mistakes, since it will happily hand back a result object whether the server returned `result` or `error`. They cover the initialize handshake, credential-free listing, protocol-vs-execution error semantics, cursor rejection, capability declaration, and stdout hygiene.

**Issues and PRs are welcome here.** Maintainers apply accepted changes upstream in the monorepo and they flow back on the next sync — so a merged fix here may appear as part of a sync commit rather than your original one. Changes to `tools.json` must come from the generator, not by hand.

## Links

[Vruum](https://vruum.ai) · [MCP docs](https://vruum.ai/docs/mcp) · [Getting started](https://vruum.ai/docs/getting-started) · [CLI reference](https://vruum.ai/docs/cli-reference)

Registry entry `ai.vruum/mcp` · Claude & Codex plugin [`vruum-gtm/skills`](https://github.com/vruum-gtm/skills)

## License

[MIT](LICENSE)
