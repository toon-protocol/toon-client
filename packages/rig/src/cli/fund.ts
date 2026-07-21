/**
 * `rig fund` — drip devnet test funds to the active identity's wallet (#263).
 *
 * A FREE command: no relay, no client start, no nonce guard, no payment
 * channel — just the identity chain (RIG_MNEMONIC precedence, ./identity.ts)
 * to derive the chain address(es), and an HTTP POST per chain to the devnet
 * faucet (`@toon-protocol/client`'s `fundWallet`, which hits the USDC-ONLY
 * legs: `POST {faucet}/api/base-sepolia/request` for EVM,
 * `/api/solana/usdc-request`, `/api/mina/usdc-request` — body `{ address }`;
 * the faucet drips a FIXED amount, so there is no --amount). Each per-chain
 * drip funds ONLY the settlement token (USDC) and ASSUMES the wallet already
 * holds enough native gas to transact — the EVM leg still best-effort tops up
 * Base Sepolia gas, but Solana/Mina expect the address to already hold SOL/MINA.
 *
 * MULTI-CHAIN BY DEFAULT: with no chain argument, `rig fund` funds ALL supported
 * chains (evm + solana + mina) so the wallet matches the multi-chain
 * `rig balance` view (#299) in one run instead of three. A chain argument —
 * positional (`rig fund sol`) or `--chain <one>` — narrows to a single chain;
 * `all` is the explicit alias for the default. The drips run in PARALLEL — the
 * Mina faucet legitimately takes
 * ~75s, so serializing would cost ~150s for a run that overlaps to ~75s — and
 * each chain's result is INDEPENDENT: one chain's faucet failing never aborts
 * the others. Exit code is 0 only when every targeted chain funded; if any
 * chain failed the exit code is 1 and the per-chain breakdown is always shown.
 *
 * Faucet resolution mirrors the toon-clientd conventions
 * (client-mcp/src/daemon/config.ts — no import, keep in sync):
 * `TOON_CLIENT_FAUCET_URL` env → `faucetUrl` in the shared client config →
 * the deployed devnet faucet when the network IS (or is inferred as) devnet.
 * A configured `*.devnet.toonprotocol.dev` origin infers devnet even when
 * `network` still reads its `custom` default (#288) — that origin is BOTH a
 * devnet-looking relay/proxy/btp endpoint in env/config AND the git `origin`
 * remote `rig remote` configures (resolved the same way push/fetch resolve
 * their relay), so a fresh user who only ran `rig remote add origin
 * wss://relay-ws.devnet.toonprotocol.dev` gets the drip from a plain
 * `rig fund` with no env var. On any other network there is no faucet: the
 * command prints the derived wallet address(es) to fund externally instead of
 * failing silently.
 *
 * The drips are awaited (a CLI has no background) but run concurrently: the
 * Mina faucet legitimately takes ~75s, so the per-chain timeout is generous
 * (daemon convention: 90s, mina 130s; `TOON_CLIENT_FAUCET_TIMEOUT_MS` /
 * config `faucetTimeoutMs` override) and a serial evm→solana→mina run would
 * stack those budgets — parallel drips overlap them.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import { resolveIdentity } from './identity.js';
import type { CliIo, IdentityReport } from './push.js';
import { renderIdentityLine } from './render.js';
import { resolveRelays } from './remote.js';

/**
 * The deployed devnet faucet — the same edge the e2e suite drips from
 * (`client-mcp/src/e2e/devnet.ts`). Used only when the configured network is
 * `devnet` and no explicit faucet URL is set.
 */
export const DEVNET_FAUCET_URL = 'https://faucet.devnet.toonprotocol.dev';

/** Supported faucet chains (client `FaucetChain`). */
const CHAINS = ['evm', 'solana', 'mina'] as const;
type FundChain = (typeof CHAINS)[number];

/**
 * Accepted chain arguments (positional `rig fund sol` or `--chain sol`), mapped
 * to the canonical selector. Short aliases (`sol`) are accepted alongside the
 * canonical names; `all` funds every supported chain (the default).
 */
const CHAIN_ALIASES: Record<string, FundChain | 'all'> = {
  evm: 'evm',
  eth: 'evm',
  sol: 'solana',
  solana: 'solana',
  mina: 'mina',
  all: 'all',
};

/** Human-readable list of accepted chain arguments (for usage/errors). */
const CHAIN_ARG_LIST = 'evm | sol | solana | mina | all';

/**
 * Resolve a raw chain argument (positional or `--chain`) to the canonical
 * selector, accepting short aliases. Throws a usage error on an unknown value.
 * Returns `undefined` when no chain was given (→ the all-chains default).
 */
function resolveChainArg(raw: string | undefined): FundChain | 'all' | undefined {
  if (raw === undefined) return undefined;
  const canonical = CHAIN_ALIASES[raw.toLowerCase()];
  if (!canonical) {
    throw new Error(
      `chain must be one of ${CHAIN_ARG_LIST}, got ${JSON.stringify(raw)}`
    );
  }
  return canonical;
}

export const FUND_USAGE = `Usage: rig fund [chain] [options]

Drip devnet USDC to the active identity's wallet — free (the faucet pays). Each
drip funds ONLY the settlement token (USDC) and assumes the wallet already holds
enough native gas to transact. By default funds ALL supported chains (evm +
solana + mina) so the wallet matches the multi-chain \`rig balance\` view in one
run; name a chain — positional (\`rig fund sol\`) or \`--chain\` — to narrow to
one. The per-chain drips run in parallel and are independent — one chain's
faucet failing does not abort the others (exit 0 only when every targeted chain
funded; exit 1 if any failed, with the per-chain breakdown always shown).

The identity comes from RIG_MNEMONIC (env or a project .env) or the
~/.toon-client keystore/config; the faucet from TOON_CLIENT_FAUCET_URL, the
faucetUrl config field, or the deployed devnet faucet when the network is
devnet — including when a configured *.devnet.toonprotocol.dev origin infers
it (a devnet relay/proxy/btp endpoint, or the git origin remote from
\`rig remote add origin <devnet relay>\`). The faucet drips a FIXED amount per
chain (there is no --amount). On a network without a faucet, prints the wallet
address(es) to fund externally instead.

Options:
  [chain]              evm | sol | solana | mina | all — positional chain to
                       fund (default: all supported chains)
  --chain <chain>      same as the positional chain argument
  --address <address>  fund this address instead of the identity's own
                       (requires an explicit single chain)
  --json               machine-readable envelope (per-chain results array)
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
  relayUrl?: string;
  proxyUrl?: string;
  btpUrl?: string;
}

/** One chain's drip outcome — the parallel, independent unit of work. */
interface ChainDripResult {
  chain: FundChain;
  /** True when this chain's faucet drip succeeded. */
  funded: boolean;
  /** The address that was (or would have been) funded; null if none derived. */
  address: string | null;
  /** Raw faucet response body on success (shape is faucet-defined). */
  response?: unknown;
  /** Failure reason when `funded` is false. */
  error?: string;
  /** Wall-clock duration of this chain's drip in ms (present once attempted). */
  elapsedMs?: number;
}

/** `--json` envelope. */
interface FundJson {
  command: 'fund';
  identity: IdentityReport;
  /** True only when EVERY targeted chain funded (overall success). */
  funded: boolean;
  network: string | null;
  faucetUrl?: string;
  /** The per-chain drip results (one entry per targeted chain). */
  results?: ChainDripResult[];
  /**
   * Set when `network` was inferred as `devnet` from a configured
   * `*.devnet.toonprotocol.dev` origin (#288) rather than an explicit
   * `TOON_CLIENT_NETWORK`/config value — carries the origin that triggered it.
   */
  inferredDevnetFrom?: string;
  /** Non-devnet path: the derived wallet addresses to fund externally. */
  addresses?: { evm: string | null; solana: string | null; mina: string | null };
  guidance?: string;
}

/** Hostname suffix of every shared-devnet edge (relay, proxy, faucet …). */
const SHARED_DEVNET_SUFFIX = '.devnet.toonprotocol.dev';

/** `url` when its host is a shared-devnet edge (`*.devnet.toonprotocol.dev`). */
function devnetHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
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
  return undefined;
}

/**
 * The first configured relay/uplink URL that points at the shared devnet
 * (`*.devnet.toonprotocol.dev`), if any. When the user's endpoints already
 * target the shared devnet but `network` still says `custom`, the fix for a
 * failed `rig fund` is `TOON_CLIENT_NETWORK=devnet` — NOT hunting for a
 * faucet URL (the #280 UX-study trap).
 *
 * The candidate endpoints are the env/config relay/proxy/btp URLs PLUS the
 * relay(s) resolved from the git `origin` remote (`originRelays`, resolved by
 * the same `rig remote`/git-config path push and fetch use — see
 * {@link resolveOriginRelays}). The git origin is the endpoint a fresh user
 * actually configures with `rig remote add origin <devnet relay>`; keying off
 * only env/config (#291) missed it, so plain `rig fund` still refused to drip
 * (#288 reopened). Exported for tests.
 */
export function sharedDevnetOrigin(
  env: NodeJS.ProcessEnv,
  file: FundConfigFile,
  originRelays: string[] = []
): string | undefined {
  const candidates = [
    env['TOON_CLIENT_RELAY_URL'] ?? file.relayUrl,
    env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl,
    env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl,
    ...originRelays,
  ];
  for (const url of candidates) {
    const hit = devnetHost(url);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The relay URL(s) the git `origin` remote resolves to — the SAME resolution
 * `rig push`/`rig fetch` use (`resolveRelays` over the repo's real git
 * remotes + the deprecated `toon.relay` fallback). `rig fund` only sniffs the
 * host for the devnet suffix, so every failure mode is swallowed to `[]`: not
 * a git repo, no `origin`, a non-relay `origin` (a GitHub clone URL), or an
 * ambiguous multi-URL origin all mean "no origin relay to infer from" — never
 * an error out of a free command.
 */
export async function resolveOriginRelays(cwd: string): Promise<string[]> {
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(cwd);
  } catch {
    return [];
  }
  try {
    const toonConfig = await readToonConfig(repoRoot);
    const resolved = await resolveRelays({
      relayFlags: [],
      remoteName: undefined,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    return resolved.relays;
  } catch {
    return [];
  }
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

  let resolvedChain: FundChain | 'all' | undefined;
  let addressFlag: string | undefined;
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
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
    // The chain can be given positionally (`rig fund sol`) OR with `--chain`,
    // but not both, and at most one positional is accepted.
    if (positionals.length > 1) {
      throw new Error(
        `rig fund takes at most one chain argument, got ${positionals.length}: ${positionals.join(' ')}`
      );
    }
    const positionalChain = positionals[0];
    if (positionalChain !== undefined && values.chain !== undefined) {
      throw new Error(
        'give the chain as a positional argument (`rig fund sol`) OR with --chain, not both'
      );
    }
    resolvedChain = resolveChainArg(positionalChain ?? values.chain);
    addressFlag = values.address;
    json = values.json ?? false;
    // A per-chain address (`--address`) is meaningless across chains — an EVM
    // 0x address cannot fund Solana or Mina. Require an explicit single chain.
    if (addressFlag !== undefined && (resolvedChain === undefined || resolvedChain === 'all')) {
      throw new Error(
        `--address requires an explicit single chain (${CHAIN_ARG_LIST}) — ` +
          'a single address cannot fund every chain'
      );
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(FUND_USAGE);
    return 2;
  }

  try {
    const { file } = readFundConfig(env);
    // MULTI-CHAIN BY DEFAULT (#299 parity): no chain argument (or `all`) funds
    // every supported chain; a specific chain narrows to one. The env/config
    // `chain` settlement preference no longer narrows `rig fund` — funding all
    // chains is a strict superset and matches `rig balance`.
    const targetChains: FundChain[] =
      resolvedChain === undefined || resolvedChain === 'all'
        ? [...CHAINS]
        : [resolvedChain];
    const network = env['TOON_CLIENT_NETWORK'] ?? file.network;
    // A configured `*.devnet.toonprotocol.dev` origin means the shared devnet
    // even when `network` still reads its `custom` default (#288): the host
    // already encodes it, so infer devnet and let the faucet "just work"
    // instead of making the user also export TOON_CLIENT_NETWORK=devnet. The
    // origin can be an env/config relay/proxy/btp endpoint OR the git `origin`
    // remote `rig remote add origin …` configured (resolved like push/fetch);
    // a fresh user who only ran that must still get the drip. An EXPLICIT
    // non-`custom` network stays authoritative — it is never coerced.
    //
    // Only an unset/`custom` network can be inferred to devnet; when the
    // network is explicit and non-`custom` the inference is a no-op, so skip
    // the git-origin resolution (several `git` subprocesses) entirely.
    const canInfer = network === undefined || network === 'custom';
    const originRelays = canInfer ? await resolveOriginRelays(deps.cwd) : [];
    const devnetOrigin = sharedDevnetOrigin(env, file, originRelays);
    const inferredDevnet =
      devnetOrigin !== undefined &&
      (network === undefined || network === 'custom');
    const effectiveNetwork = inferredDevnet ? 'devnet' : network;
    const faucetUrl =
      env['TOON_CLIENT_FAUCET_URL'] ??
      file.faucetUrl ??
      (effectiveNetwork === 'devnet' ? DEVNET_FAUCET_URL : undefined);

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
      const guidance = noFaucetGuidance(network, devnetOrigin);
      if (json) {
        io.emitJson({
          command: 'fund',
          identity,
          funded: false,
          network: network ?? null,
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

    // ── Devnet faucet drips (parallel, independent per chain) ───────────────
    // Chain-aware timeout (daemon convention): a Mina drip routinely takes
    // >75s server-side. Env/config override applies uniformly.
    const timeoutEnv = env['TOON_CLIENT_FAUCET_TIMEOUT_MS'];
    const timeoutFor = (chain: FundChain): number => {
      if (timeoutEnv && Number.isFinite(Number(timeoutEnv))) return Number(timeoutEnv);
      if (file.faucetTimeoutMs !== undefined) return file.faucetTimeoutMs;
      return chain === 'mina' ? 130_000 : 90_000;
    };

    if (!json && inferredDevnet) {
      io.out(
        `Inferred network 'devnet' from the configured origin ${devnetOrigin} ` +
          `(network was ${JSON.stringify(network ?? 'custom')}). ` +
          'Set TOON_CLIENT_NETWORK explicitly to override.'
      );
    }
    if (!json) {
      const list = targetChains.join(', ');
      io.out(
        `Requesting ${targetChains.length === 1 ? '' : 'parallel '}USDC drip${targetChains.length === 1 ? '' : 's'} ` +
          `from ${faucetUrl} for ${list} …` +
          (targetChains.includes('mina')
            ? ' (mina settles slowly; this can take ~2 minutes)'
            : '')
      );
    }

    // Each chain is an INDEPENDENT unit: derive-or-fail and drip-or-fail are
    // both captured into a ChainDripResult so one chain's failure never
    // rejects the batch. Kicking every drip off before awaiting makes them
    // genuinely concurrent (the Mina ~75s overlaps evm/solana, not stacks).
    const singleChain = targetChains.length === 1;
    const drips = targetChains.map(async (chain): Promise<ChainDripResult> => {
      const address = (singleChain ? addressFlag : undefined) ?? addresses[chain];
      if (!address) {
        return {
          chain,
          funded: false,
          address: null,
          error:
            `no ${chain} address could be derived for this identity` +
            (chain === 'mina'
              ? ' (install the optional mina-signer dependency)'
              : ''),
        };
      }
      const started = Date.now();
      try {
        const { response } = await client.fundWallet(faucetUrl, address, chain, {
          timeout: timeoutFor(chain),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        return {
          chain,
          funded: true,
          address,
          response,
          elapsedMs: Date.now() - started,
        };
      } catch (err) {
        return {
          chain,
          funded: false,
          address,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - started,
        };
      }
    });
    const results = await Promise.all(drips);
    const allFunded = results.every((r) => r.funded);

    if (json) {
      io.emitJson({
        command: 'fund',
        identity,
        funded: allFunded,
        network: effectiveNetwork ?? null,
        faucetUrl,
        results,
        ...(inferredDevnet ? { inferredDevnetFrom: devnetOrigin } : {}),
      } satisfies FundJson);
      return allFunded ? 0 : 1;
    }

    for (const r of results) {
      const label = r.chain.padEnd(6);
      // Always echo the funded (or attempted) address so a human can confirm
      // WHERE the funds went — essential when `--address` targets an arbitrary,
      // non-derived address a typo could misdirect (only shown via --json
      // otherwise).
      const addr = r.address ? ` → ${r.address}` : '';
      if (r.funded) {
        // The faucet drips USDC only (gas is assumed); annotate the token, and
        // the wall time for slow chains (mina) so a >1-minute wait reads as normal.
        const slow = r.elapsedMs !== undefined && r.elapsedMs >= 5_000;
        const time = slow ? ` (${Math.round((r.elapsedMs as number) / 1000)}s)` : '';
        io.out(`  ${label} ✓ funded (USDC)${addr}${time}`);
      } else {
        io.out(`  ${label} ✗${addr} — ${r.error ?? 'failed'}`);
      }
    }
    io.out(renderIdentityLine(identity));
    io.out('Re-check with `rig balance` (a drip can take a few blocks to land).');
    return allFunded ? 0 : 1;
  } catch (err) {
    return emitCliError(io, json, 'fund', err);
  }
}
