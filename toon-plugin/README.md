# toon (Claude Code plugin)

One-step install of the **TOON Protocol client** for a Claude agent: the
`toon-client` skill **plus** the `toon-mcp` MCP server, bundled together. TOON is
**pay-to-write Nostr over Interledger** — pay per publish, read for free.

After install, the `toon_*` tools are available and the `toon-client` skill
auto-activates when you ask to publish/read/pay/swap on TOON.

## What's in here

| Part | Path | Role |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Plugin name/version/metadata |
| Marketplace entry | `.claude-plugin/marketplace.json` | Lets this repo act as a one-plugin marketplace |
| Skill | `skills/toon-client/SKILL.md` (+ `references/`, `evals/`) | Teaches pay-to-write / free-read / settlement |
| MCP server | `.mcp.json` | Declares the `toon` MCP server, run via `npx @toon-protocol/client-mcp` |

The MCP server itself is published separately to npm as
[`@toon-protocol/client-mcp`](https://www.npmjs.com/package/@toon-protocol/client-mcp)
(bins `toon-mcp` + `toon-clientd`); this plugin just declares it, so the plugin
stays tiny and the heavy code is versioned on npm. The `toon-clientd` daemon is
auto-spawned by `toon-mcp` — the plugin only declares the one server.

## Install

**Try it locally (no marketplace):**
```bash
claude --plugin-dir /path/to/town/toon-plugin
```

**Via marketplace (this repo doubles as one):**
```text
/plugin marketplace add toon-protocol/town
/plugin install toon@toon
```

> The marketplace points at `toon-plugin/` in the `toon-protocol/town` repo. To
> ship it standalone, copy this directory into its own repo and add that repo as
> the marketplace source instead.

## Prerequisites

The MCP server needs Node ≥ 20 (`npx` fetches `@toon-protocol/client-mcp` on
first run) and a configured TOON client identity. Configure the daemon via
`~/.toon-client/config.json` and a mnemonic/keystore — see the
[`@toon-protocol/client-mcp` README](https://www.npmjs.com/package/@toon-protocol/client-mcp)
for the config schema, the `toon_*` tool reference, and a usage example.

## Tools (8)

`toon_status`, `toon_identity`, `toon_publish`, `toon_subscribe`, `toon_read`,
`toon_open_channel`, `toon_channels`, `toon_swap`. Namespaced under the plugin,
e.g. the skill is invocable as `/toon:toon-client`.

> **Note on schemas:** Claude Code's plugin/marketplace formats evolve; verify
> `plugin.json` / `marketplace.json` fields and the `/plugin` commands against
> the current docs (https://code.claude.com/docs) before publishing.
