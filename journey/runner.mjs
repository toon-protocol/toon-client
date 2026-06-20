// Headless SocialFi + DeFi journey orchestrator (WS5) — Claude Agent SDK.
//
// Drives a deterministic, phased journey against a live apex hub by connecting the Claude
// Agent SDK to the toon-mcp server (which proxies to the always-on toon-clientd daemon).
// The *sequence* of phases is fixed and each phase has an explicit success criterion; the
// agent executes each phase against the live MCP tools and reports a verdict, which the
// runner turns into a pass/fail exit code.
//
// Auth is inherited from the environment: the Agent SDK spawns the bundled Claude Code
// CLI, which reads CLAUDE_CODE_OAUTH_TOKEN (the org's Max-plan token).
//
// Modes:
//   smoke (default) — read-only: the connect phase only (no spend).
//   full            — onboard -> SocialFi (profile/note/follow + media) -> DeFi (channel
//                     + swap), each verified by read-back. Spends tiny testnet amounts.
//
// Env:
//   CLAUDE_CODE_OAUTH_TOKEN  (required) Max-plan auth
//   CLAUDE_MODEL             (optional) default "sonnet"
//   TOON_CLIENT_CONFIG       (required) path to the client config.json
//   TOON_CLIENT_MNEMONIC     (required) seed the daemon derives the funded wallet from
//   TOON_JOURNEY             smoke | full   (default: smoke)

import { query } from '@anthropic-ai/claude-agent-sdk'

const MODEL = process.env.CLAUDE_MODEL ?? 'sonnet'
const MODE = process.env.TOON_JOURNEY ?? 'smoke'

const T = (n) => `mcp__toon__toon_${n}`
const READ = [T('status'), T('identity'), T('query'), T('read'), T('channels'), T('targets')]

// Each phase: a fixed step the agent executes against the live tools, ending with an
// explicit `RESULT: PASS` / `RESULT: FAIL: <reason>` line the runner parses.
const PHASES = [
  {
    name: 'connect',
    when: 'always',
    tools: READ,
    goal: `Validate connectivity to the TOON apex. Call toon_status and toon_identity and
report: is the daemon bootstrapped, is the relay connected, and what are the public Nostr
+ EVM/Solana/Mina addresses? Read-only — do not publish, upload, swap, or spend.`,
  },
  {
    name: 'socialfi',
    when: 'full',
    tools: [...READ, T('subscribe'), T('publish_unsigned')],
    goal: `SocialFi leg (pay-to-write, tiny fees). In order:
1. Publish a profile (kind 0) with a short name + about.
2. Publish a note (kind 1) with a short message.
3. Follow one pubkey (kind 3) — you may follow your own/apex pubkey.
Then read back via toon_query (kinds [0,1,3] for your pubkey) and CONFIRM the note and
profile are present. Report the published event ids.`,
  },
  {
    name: 'store',
    when: 'full',
    tools: [...READ, T('upload_media')],
    goal: `Store leg. Upload a TINY media blob (a few bytes, e.g. a small text or 1x1 PNG
as base64) via toon_upload_media, then read it back and CONFIRM an Arweave URL / tx id was
returned and the media event is retrievable. Report the URL/tx.`,
  },
  {
    name: 'defi',
    when: 'full',
    tools: [...READ, T('open_channel'), T('swap'), T('channels')],
    goal: `DeFi leg (tiny amounts only). Open or pre-open a payment channel
(toon_open_channel), then perform ONE minimal swap (toon_swap). Read back via
toon_channels and CONFIRM the channel exists and report the swap's settlement receipt /
chain claim. If no swap counterparty is available, say so explicitly.`,
  },
]

const MCP_ENV = {
  TOON_CLIENT_CONFIG: process.env.TOON_CLIENT_CONFIG ?? '',
  TOON_CLIENT_MNEMONIC: process.env.TOON_CLIENT_MNEMONIC ?? '',
}

const RUBRIC = `When done, end your reply with exactly one line:
"RESULT: PASS" if every step and its read-back verification succeeded, otherwise
"RESULT: FAIL: <short reason>". Keep all amounts/fees minimal.`

async function runPhase(phase) {
  console.log(`\n========== phase: ${phase.name} ==========`)
  let transcript = ''
  for await (const message of query({
    prompt: `${phase.goal}\n\n${RUBRIC}`,
    options: {
      model: MODEL,
      allowedTools: phase.tools,
      permissionMode: 'default', // allow-listed tools auto-approved; others denied (fail-safe)
      mcpServers: { toon: { type: 'stdio', command: 'toon-mcp', args: [], env: MCP_ENV } },
    },
  })) {
    if (message.type === 'assistant') {
      const text = message.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text) { transcript += text + '\n'; console.log(`[${phase.name}] ${text}`) }
    } else if (message.type === 'result') {
      const text = message.result ?? ''
      transcript += text
      console.log(`[${phase.name}] result (${message.subtype})`)
    }
  }
  const pass = /RESULT:\s*PASS/i.test(transcript)
  console.log(`[${phase.name}] -> ${pass ? 'PASS' : 'FAIL'}`)
  return { name: phase.name, pass }
}

async function main() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required')
  console.log(`[journey] mode=${MODE} model=${MODEL}`)

  const phases = PHASES.filter((p) => p.when === 'always' || MODE === 'full')
  const results = []
  for (const phase of phases) {
    try {
      results.push(await runPhase(phase))
    } catch (err) {
      console.error(`[${phase.name}] error:`, err?.message ?? err)
      results.push({ name: phase.name, pass: false })
    }
  }

  console.log('\n========== journey summary ==========')
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
  const failed = results.filter((r) => !r.pass)
  if (failed.length) {
    console.error(`[journey] ${failed.length}/${results.length} phase(s) failed`)
    process.exit(1)
  }
  console.log(`[journey] all ${results.length} phase(s) passed`)
}

main().catch((err) => {
  console.error('[journey] failed:', err?.message ?? err)
  process.exit(1)
})
