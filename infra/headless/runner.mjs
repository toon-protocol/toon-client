// Headless journey runner (SCAFFOLD) — Claude Agent SDK.
//
// Drives a journey against a live apex hub by connecting the Claude Agent SDK to the
// toon-mcp server (which proxies to the always-on toon-clientd daemon). Auth is inherited
// from the environment: the Agent SDK spawns the bundled Claude Code CLI, which reads
// CLAUDE_CODE_OAUTH_TOKEN (your Max plan) — the same auth the org's backlog loops use.
//
// STATUS: deploy-side scaffold. The deterministic SocialFi + DeFi journey orchestrator is
// WS5 + WS7 (toon-protocol/toon-client#21). Until that lands, this runs a SAFE read-only
// smoke by default (status/identity only, no spend). Set TOON_JOURNEY=full once the
// orchestrator + funded keystore are in place.
//
// Env:
//   CLAUDE_CODE_OAUTH_TOKEN       (required) Max-plan auth, read by the bundled CLI
//   CLAUDE_MODEL                  (optional) default "sonnet"
//   TOON_CLIENT_CONFIG            (required) path to the client config.json
//   TOON_CLIENT_KEYSTORE_PASSWORD (required for full) unlocks the encrypted keystore
//   TOON_JOURNEY                  smoke | full   (default: smoke)

import { query } from '@anthropic-ai/claude-agent-sdk'

const MODEL = process.env.CLAUDE_MODEL ?? 'sonnet'
const MODE = process.env.TOON_JOURNEY ?? 'smoke'

// MCP tools are namespaced mcp__<server>__<tool>. The server is named "toon" below.
const READ_TOOLS = [
  'mcp__toon__toon_status',
  'mcp__toon__toon_identity',
  'mcp__toon__toon_query',
  'mcp__toon__toon_read',
  'mcp__toon__toon_channels',
  'mcp__toon__toon_targets',
]
const WRITE_TOOLS = [
  'mcp__toon__toon_subscribe',
  'mcp__toon__toon_publish_unsigned',
  'mcp__toon__toon_upload_media',
  'mcp__toon__toon_open_channel',
  'mcp__toon__toon_swap',
]

const SMOKE_PROMPT = `You are validating connectivity to a TOON apex hub. Using only the
read-only tools, call toon_status and toon_identity and summarize: is the daemon
bootstrapped, is the relay connected, and what are the public addresses? Do not publish,
upload, swap, or spend anything.`

// Placeholder for the WS5 deterministic orchestrator — replace this free-form prompt with
// the real step-by-step journey + on-chain assertions once it lands.
const JOURNEY_PROMPT = `Run a combined SocialFi + DeFi user journey against the TOON apex,
using small testnet amounts only:
1. SocialFi: publish a short profile (kind 0) and a note (kind 1), follow one pubkey
   (kind 3), upload a tiny media blob to the store DVM, then read it all back.
2. DeFi: open/pre-open a payment channel and perform one tiny swap, then report the
   settlement receipt.
Confirm each step's result before moving on. Keep all amounts minimal.`

async function main() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required')
  }

  const allowedTools = MODE === 'full' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
  const prompt = MODE === 'full' ? JOURNEY_PROMPT : SMOKE_PROMPT
  console.log(`[toon-headless] mode=${MODE} model=${MODEL}`)

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      allowedTools,
      // Auto-approve the allow-listed MCP tools; anything else is denied (fail-safe in
      // this non-interactive context).
      permissionMode: 'default',
      mcpServers: {
        toon: {
          type: 'stdio',
          command: 'toon-mcp',
          args: [],
          env: {
            TOON_CLIENT_CONFIG: process.env.TOON_CLIENT_CONFIG ?? '',
            TOON_CLIENT_KEYSTORE_PASSWORD: process.env.TOON_CLIENT_KEYSTORE_PASSWORD ?? '',
          },
        },
      },
    },
  })) {
    if (message.type === 'assistant') {
      const text = message.message?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) console.log(`[toon-headless] ${text}`)
    } else if (message.type === 'result') {
      console.log(`[toon-headless] result (${message.subtype}):\n${message.result ?? ''}`)
    }
  }
}

main().catch((err) => {
  console.error('[toon-headless] failed:', err)
  process.exit(1)
})
