// Headless mcp-use journey runner (SCAFFOLD).
//
// Connects a Claude agent (via mcp-use) to the toon-mcp server — which proxies to the
// always-on toon-clientd daemon — and drives a journey against a live apex hub.
//
// STATUS: this is the deploy-side scaffold. The deterministic SocialFi + DeFi journey
// orchestrator is WS5 (toon-client journey orchestrator) + WS7 (mcp-use harness). Until
// those land, this runs a SAFE smoke by default (read-only status/identity, no spend).
// Set TOON_JOURNEY=full only once the orchestrator + funded keystore are in place.
//
// Env:
//   ANTHROPIC_API_KEY            (required) Claude API key
//   ANTHROPIC_MODEL              (optional) default claude-sonnet-4-6
//   TOON_CLIENT_CONFIG           (required) path to the client config.json
//   TOON_CLIENT_KEYSTORE_PASSWORD(required for full) unlocks the encrypted keystore
//   TOON_JOURNEY                 smoke | full   (default: smoke)

import { ChatAnthropic } from '@langchain/anthropic'
import { MCPAgent, MCPClient } from 'mcp-use'

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
const MODE = process.env.TOON_JOURNEY ?? 'smoke'

const SMOKE_PROMPT = `You are validating connectivity to a TOON apex hub. Using only
READ-ONLY tools, call toon_status and toon_identity and summarize: is the daemon
bootstrapped, is the relay connected, and what are the public addresses? Do not publish,
upload, swap, or spend anything.`

// Placeholder for the WS5 deterministic orchestrator. When that lands, import and call
// it here instead of this free-form prompt.
const JOURNEY_PROMPT = `Run a combined SocialFi + DeFi user journey against the TOON
apex, using small testnet amounts only:
1. SocialFi: publish a short profile (kind 0) and a note (kind 1), follow one pubkey
   (kind 3), upload a tiny media blob to the store DVM, then read it all back.
2. DeFi: open/pre-open a payment channel and perform one tiny swap, then report the
   settlement receipt.
Confirm each step's result before moving on. Keep all amounts minimal.`

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required')

  const client = new MCPClient({
    mcpServers: {
      toon: {
        command: 'toon-mcp',
        args: [],
        env: {
          TOON_CLIENT_CONFIG: process.env.TOON_CLIENT_CONFIG ?? '',
          TOON_CLIENT_KEYSTORE_PASSWORD: process.env.TOON_CLIENT_KEYSTORE_PASSWORD ?? '',
        },
      },
    },
  })

  const agent = new MCPAgent({
    llm: new ChatAnthropic({ model: MODEL }),
    client,
    maxSteps: MODE === 'full' ? 40 : 8,
  })

  try {
    const prompt = MODE === 'full' ? JOURNEY_PROMPT : SMOKE_PROMPT
    console.log(`[toon-headless] mode=${MODE} model=${MODEL}`)
    const result = await agent.run({ prompt })
    console.log(`[toon-headless] result:\n${result}`)
  } finally {
    await client.closeAllSessions()
  }
}

main().catch((err) => {
  console.error('[toon-headless] failed:', err)
  process.exit(1)
})
