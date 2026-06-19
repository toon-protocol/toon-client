// Treasury top-up (Base Sepolia) — check the client wallet's balances and, if low, fund
// it from the treasury account. Both are derived from the same seed at different BIP-44
// account indices, so this is a treasury -> client transfer.
//
// EVM Base Sepolia only for now (the fully-real settlement chain). Solana/Mina top-ups
// are deferred until their on-chain settlement lands (epic toon-meta#22, WS3).
//
// Env:
//   TOON_CLIENT_MNEMONIC     (required) the treasury seed
//   TREASURY_ACCOUNT_INDEX   funded master account index (default 0)
//   CLIENT_ACCOUNT_INDEX     the client's index (default 1; MUST differ from treasury)
//   BASE_SEPOLIA_RPC         RPC URL (default https://sepolia.base.org)
//   USDC_ADDRESS             ERC-20 token the hub advertises for evm:base:84532 (optional)
//   MIN_ETH / TOPUP_ETH      gas floor / top-up amount in ETH (default 0.002 / 0.005)
//   MIN_USDC / TOPUP_USDC    USDC floor / top-up amount, human units (default 5 / 10)
//   TOPUP_DRY_RUN            'true' = report only, never send

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  formatUnits,
  parseUnits,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]

const env = (k, d) => process.env[k] ?? d
const MNEMONIC = process.env.TOON_CLIENT_MNEMONIC
const TREASURY_INDEX = Number(env('TREASURY_ACCOUNT_INDEX', '0'))
const CLIENT_INDEX = Number(env('CLIENT_ACCOUNT_INDEX', '1'))
const RPC = env('BASE_SEPOLIA_RPC', 'https://sepolia.base.org')
const USDC = process.env.USDC_ADDRESS
const MIN_ETH = env('MIN_ETH', '0.002')
const TOPUP_ETH = env('TOPUP_ETH', '0.005')
const MIN_USDC = env('MIN_USDC', '5')
const TOPUP_USDC = env('TOPUP_USDC', '10')
const DRY = env('TOPUP_DRY_RUN', 'false') === 'true'

function log(m) { console.log(`[topup] ${m}`) }

async function main() {
  if (!MNEMONIC) throw new Error('TOON_CLIENT_MNEMONIC is required')
  if (TREASURY_INDEX === CLIENT_INDEX) {
    throw new Error(`TREASURY_ACCOUNT_INDEX (${TREASURY_INDEX}) must differ from CLIENT_ACCOUNT_INDEX (${CLIENT_INDEX})`)
  }

  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: TREASURY_INDEX })
  const client = mnemonicToAccount(MNEMONIC, { addressIndex: CLIENT_INDEX }).address
  log(`treasury[${TREASURY_INDEX}] ${treasury.address}  ->  client[${CLIENT_INDEX}] ${client}`)
  if (DRY) log('DRY RUN — no transactions will be sent')

  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
  const wallet = createWalletClient({ account: treasury, chain: baseSepolia, transport: http(RPC) })

  // --- ETH (gas) ---
  const ethBal = await pub.getBalance({ address: client })
  log(`client ETH: ${formatEther(ethBal)} (floor ${MIN_ETH})`)
  if (ethBal < parseEther(MIN_ETH)) {
    const value = parseEther(TOPUP_ETH)
    const tBal = await pub.getBalance({ address: treasury.address })
    if (tBal < value) { log(`WARN treasury ETH ${formatEther(tBal)} < top-up ${TOPUP_ETH} — skipping`) }
    else if (DRY) { log(`would send ${TOPUP_ETH} ETH`) }
    else {
      const hash = await wallet.sendTransaction({ to: client, value })
      log(`sent ${TOPUP_ETH} ETH, tx ${hash}`)
      await pub.waitForTransactionReceipt({ hash })
    }
  } else log('ETH sufficient')

  // --- USDC ---
  if (!USDC) { log('USDC_ADDRESS unset — skipping USDC top-up (set it to the token the hub advertises)'); return }
  const decimals = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'decimals' }).catch(() => 6)
  const usdcBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [client] })
  log(`client USDC: ${formatUnits(usdcBal, decimals)} (floor ${MIN_USDC})`)
  if (usdcBal < parseUnits(MIN_USDC, decimals)) {
    const amount = parseUnits(TOPUP_USDC, decimals)
    const tBal = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [treasury.address] })
    if (tBal < amount) { log(`WARN treasury USDC ${formatUnits(tBal, decimals)} < top-up ${TOPUP_USDC} — skipping`) }
    else if (DRY) { log(`would send ${TOPUP_USDC} USDC`) }
    else {
      const hash = await wallet.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [client, amount] })
      log(`sent ${TOPUP_USDC} USDC, tx ${hash}`)
      await pub.waitForTransactionReceipt({ hash })
    }
  } else log('USDC sufficient')
}

main().then(() => log('done')).catch((e) => { console.error('[topup] failed:', e.shortMessage ?? e.message ?? e); process.exit(1) })
