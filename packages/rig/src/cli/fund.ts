/**
 * `rig fund` — drip devnet test funds to the active identity's wallet (#263).
 *
 * A FREE command: no relay, no client start, no nonce guard, no payment
 * channel — just the identity chain (RIG_MNEMONIC precedence, ./identity.ts)
 * to derive the chain address, and one HTTP POST to the devnet faucet
 * (`@toon-protocol/client`'s `fundWallet`: `POST {faucet}/api/request` for
 * EVM, `/api/solana/request`, `/api/mina/request` — body `{ address }`; the
 * faucet drips FIXED amounts, so there is no --amount).
 *
 * Faucet resolution mirrors the toon-clientd conventions
 * (client-mcp/src/daemon/config.ts — no import, keep in sync):
 * `TOON_CLIENT_FAUCET_URL` env → `faucetUrl` in the shared client config →
 * the deployed devnet faucet when the configured network IS devnet. On any
 * other network there is no faucet: the command prints the derived wallet
 * address(es) to fund externally instead of failing silently.
 *
 * The drip is awaited synchronously (a CLI has no background): the Mina
 * faucet legitimately takes ~75s, so the per-chain timeout is generous
 * (daemon convention: 90s, mina 130s; `TOON_CLIENT_FAUCET_TIMEOUT_MS` /
 * config `faucetTimeoutMs` override).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import { resolveIdentity } from './identity.js';
import type { CliIo, IdentityReport } from './push.js';
import { renderIdentityLine } from './render.js';

/**
 * The deployed devnet faucet — the same edge the e2e suite drips from
 * (`client-mcp/src/e2e/devnet.ts`). Used only when the configured network is
 * `devnet` and no explicit faucet URL is set.
 */
export const DEVNET_FAUCET_URL = 'https://faucet.devnet.toonprotocol.dev';

/** Supported faucet chains (client `FaucetChain`). */
const CHAINS = ['evm', 'solana', 'mina'] as const;
type FundChain = (typeof CHAINS)[number];

export const FUND_USAGE = `Usage: rig fund [options]

Drip devnet test funds to the active identity's wallet — free (the faucet
pays). The identity comes from RIG_MNEMONIC (env or a project .env) or the
~/.toon-client keystore/config; the faucet from TOON_CLIENT_FAUCET_URL, the
faucetUrl config field, or the deployed devnet faucet when the configured
network is devnet. The faucet drips a FIXED amount per chain (there is no
--amount). On a network without a faucet, prints the wallet address(es) to
fund externally instead.

Options:
  --chain <chain>      evm | solana | mina (default: TOON_CLIENT_CHAIN, the
                       \`chain\` config field, else evm)
  --address <address>  fund this address instead of the identity's own
  --json               machine-readable envelope
  -h, --help           show this help`;

/** What `rig fund` needs from the command environment. */
export interface FundDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  /** Working directory (starts the project-local `.env` walk). */
  cwd: string;
  /** fetch used for the faucet call (tests inject; default global fetch). */
  fetchImpl?: typeof fetch;
}

/** The slice of the shared client config file `rig fund` consumes. */
interface FundConfigFile {
  network?: string;
  faucetUrl?: string;
  faucetTimeoutMs?: number;
  chain?: string;
  relayUrl?: string;
  proxyUrl?: string;
  btpUrl?: string;
}

/** `--json` envelope. */
interface FundJson {
  command: 'fund';
  identity: IdentityReport;
  /** True when a faucet drip was performed (and succeeded). */
  funded: boolean;
  network: string | null;
  chain: FundChain;
  address?: string;
  faucetUrl?: string;
  /** Raw faucet response body (shape is faucet-defined). */
  response?: unknown;
  /** Non-devnet path: the derived wallet addresses to fund externally. */
  addresses?: { evm: string | null; solana: string | null; mina: string | null };
  guidance?: string;
}

/** Hostname suffix of every shared-devnet edge (relay, proxy, faucet …). */
const SHARED_DEVNET_SUFFIX = '.devnet.toonprotocol.dev';

/**
 * The first configured relay/uplink URL that points at the shared devnet
 * (`*.devnet.toonprotocol.dev`), if any. When the user's endpoints already
 * target the shared devnet but `network` still says `custom`, the fix for a
 * failed `rig fund` is `TOON_CLIENT_NETWORK=devnet` — NOT hunting for a
 * faucet URL (the #280 UX-study trap). Exported for tests.
 */
export function sharedDevnetOrigin(
  env: NodeJS.ProcessEnv,
  file: FundConfigFile
): string | undefined {
  const candidates = [
    env['TOON_CLIENT_RELAY_URL'] ?? file.relayUrl,
    env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl,
    env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl,
  ];
  for (const url of candidates) {
    if (!url) continue;
    try {
      const { hostname } = new URL(url);
      if (
        hostname.endsWith(SHARED_DEVNET_SUFFIX) ||
        hostname === SHARED_DEVNET_SUFFIX.slice(1)
      ) {
        return url;
      }
    } catch {
      // junk URL — other commands surface that; fund only sniffs
    }
  }
  return undefined;
}

/**
 * Remediation for `rig fund` on a network without a faucet. Orders the
 * suggestions by likelihood (#280): the network preset FIRST — a fresh
 * config defaults to `custom`, and on the shared devnet the whole fix is
 * `TOON_CLIENT_NETWORK=devnet` — then the faucet-URL override for
 * self-hosted networks, then external funding. Exported for tests.
 */
export function noFaucetGuidance(
  network: string | undefined,
  devnetOrigin: string | undefined
): string {
  const head = `no faucet is configured for network ${JSON.stringify(network ?? 'custom')}`;
  const external =
    'To fund the wallet externally instead, send the settlement token plus ' +
    'native gas to the address below for the chain your channels settle on.';
  if (devnetOrigin !== undefined) {
    return (
      `${head} — but your configured origin (${devnetOrigin}) looks like ` +
      'the shared devnet. Set TOON_CLIENT_NETWORK=devnet (or "network": ' +
      '"devnet" in the client config) and re-run `rig fund` — no faucet ' +
      `URL is needed there. ${external}`
    );
  }
  return (
    `${head}. If you meant the shared devnet, set TOON_CLIENT_NETWORK=devnet ` +
    'and re-run `rig fund` — no faucet URL is needed there. If this is a ' +
    'self-hosted network with its own faucet, set TOON_CLIENT_FAUCET_URL ' +
    `(or the faucetUrl config field). ${external}`
  );
}

function readFundConfig(env: NodeJS.ProcessEnv): {
  file: FundConfigFile;
  configPath: string;
} {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  const configPath = join(dir, 'config.json');
  try {
    return {
      file: JSON.parse(readFileSync(configPath, 'utf8')) as FundConfigFile,
      configPath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: {}, configPath };
    }
    throw new Error(
      `failed to read client config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Run `rig fund`; returns the process exit code. */
export async function runFund(args: string[], deps: FundDeps): Promise<number> {
  const { io, env } = deps;

  let chainFlag: string | undefined;
  let addressFlag: string | undefined;
  let json = false;
  try {
    const { values } = parseArgs({
      args,
      options: {
        chain: { type: 'string' },
        address: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      io.out(FUND_USAGE);
      return 0;
    }
    chainFlag = values.chain;
    addressFlag = values.address;
    json = values.json ?? false;
    if (chainFlag !== undefined && !CHAINS.includes(chainFlag as FundChain)) {
      throw new Error(
        `--chain must be one of ${CHAINS.join(' | ')}, got ${JSON.stringify(chainFlag)}`
      );
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(FUND_USAGE);
    return 2;
  }

  try {
    const { file } = readFundConfig(env);
    const chain = (chainFlag ??
      env['TOON_CLIENT_CHAIN'] ??
      file.chain ??
      'evm') as FundChain;
    if (!CHAINS.includes(chain)) {
      throw new Error(
        `configured settlement chain ${JSON.stringify(chain)} has no faucet — pass --chain ${CHAINS.join(' | ')}`
      );
    }
    const network = env['TOON_CLIENT_NETWORK'] ?? file.network;
    const faucetUrl =
      env['TOON_CLIENT_FAUCET_URL'] ??
      file.faucetUrl ??
      (network === 'devnet' ? DEVNET_FAUCET_URL : undefined);

    // ── Identity chain → wallet addresses (never the phrase) ────────────────
    const resolved = await resolveIdentity({
      env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
    });
    const identity: IdentityReport = {
      pubkey: resolved.pubkey,
      source: resolved.source,
      sourceLabel: resolved.sourceLabel,
    };
    // Dynamic import: `@toon-protocol/client` is heavy; runs that fail
    // earlier (usage errors) never pay its startup cost.
    const client = await import('@toon-protocol/client');
    const derived = await client.deriveFullIdentity(
      resolved.mnemonic,
      resolved.accountIndex
    );
    const addresses = {
      evm: derived.evm.address || null,
      solana: derived.solana.publicKey || null,
      mina: derived.mina.publicKey || null,
    };

    // ── No faucet on this network: name the ACTUAL knob first (#280) ────────
    if (!faucetUrl) {
      const guidance = noFaucetGuidance(network, sharedDevnetOrigin(env, file));
      if (json) {
        io.emitJson({
          command: 'fund',
          identity,
          funded: false,
          network: network ?? null,
          chain,
          addresses,
          guidance,
        } satisfies FundJson);
        return 0;
      }
      io.out(renderIdentityLine(identity));
      io.out(guidance);
      io.out('Wallet addresses:');
      io.out(`  evm     ${addresses.evm ?? '(no key derived)'}`);
      io.out(`  solana  ${addresses.solana ?? '(no key derived)'}`);
      io.out(`  mina    ${addresses.mina ?? '(no key derived — optional mina-signer dependency missing)'}`);
      return 0;
    }

    // ── Devnet faucet drip ───────────────────────────────────────────────────
    const address = addressFlag ?? addresses[chain];
    if (!address) {
      throw new Error(
        `no ${chain} address could be derived for this identity — pass an ` +
          'explicit --address (for mina, install the optional mina-signer dependency)'
      );
    }
    // Generous, chain-aware timeout (daemon convention): the drip is awaited
    // here, and a Mina drip routinely takes >75s server-side.
    const timeoutEnv = env['TOON_CLIENT_FAUCET_TIMEOUT_MS'];
    const timeout =
      timeoutEnv && Number.isFinite(Number(timeoutEnv))
        ? Number(timeoutEnv)
        : (file.faucetTimeoutMs ?? (chain === 'mina' ? 130_000 : 90_000));

    if (!json) {
      io.out(
        `Requesting ${chain} drip from ${faucetUrl} for ${address} …` +
          (chain === 'mina' ? ' (mina settles slowly; this can take ~2 minutes)' : '')
      );
    }
    const { response } = await client.fundWallet(faucetUrl, address, chain, {
      timeout,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    if (json) {
      io.emitJson({
        command: 'fund',
        identity,
        funded: true,
        network: network ?? null,
        chain,
        address,
        faucetUrl,
        response,
      } satisfies FundJson);
      return 0;
    }
    io.out(`Faucet drip succeeded: ${chain} → ${address}`);
    io.out(renderIdentityLine(identity));
    io.out('Re-check with `rig balance` (a drip can take a few blocks to land).');
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'fund', err);
  }
}
