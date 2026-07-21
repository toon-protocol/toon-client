/**
 * `rig chain` — choose which chain (and therefore which USDC token) settles
 * paid `rig` writes.
 *
 * Each supported chain has its own USDC: EVM (Base Sepolia), Solana devnet, and
 * Mina devnet. "Which USDC is spent" == "which settlement chain rig picks", and
 * that is a session/config-level choice — there is no per-`rig push` flag. This
 * command persists the choice to the shared client config's `chain` field
 * (`~/.toon-client/config.json`) — the exact knob `resolveNetworkTopology`
 * reads (env `TOON_CLIENT_CHAIN` ?? config `chain`), so the next paid command
 * settles on the named chain.
 *
 *   rig chain               show the current preference (and what USDC it maps to)
 *   rig chain set <chain>   pin the settlement chain: evm | sol | mina (or a
 *                           full id like evm:base:84532)
 *   rig chain unset         clear the pin — revert to automatic selection
 *
 * A FREE command: it only reads/writes the local config file, never the relay
 * or a chain. When nothing is pinned, rig auto-selects (most-recent open
 * channel → first announced chain your wallet holds USDC on → first announced
 * EVM chain); `rig chain` reports that state.
 *
 * Precedence caveats surfaced to the user: the `TOON_CLIENT_CHAIN` env var
 * overrides the config field, and a `supportedChains` array (if set) takes
 * precedence over `chain` — writing `chain` while either is set warns that the
 * pin may not take effect until they are cleared/changed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import type { CliIo } from './output.js';

/** Canonical settlement families and the USDC each one spends. */
const FAMILY_USDC: Record<string, string> = {
  evm: 'EVM USDC (Base Sepolia on devnet)',
  solana: 'Solana USDC',
  mina: 'Mina USDC',
};

/**
 * Accepted `set` values → the canonical string written to config. Short aliases
 * mirror `rig fund` (`sol`, `eth`). A full chain id (with a `:`) is stored
 * verbatim; a bare family is stored as the canonical family, which the resolver
 * matches against the first announced chain of that family.
 */
const FAMILY_ALIASES: Record<string, string> = {
  evm: 'evm',
  eth: 'evm',
  sol: 'solana',
  solana: 'solana',
  mina: 'mina',
};

/** Human list of accepted `set` arguments (for usage/errors). */
const CHAIN_ARG_LIST = 'evm | sol | solana | mina (or a full id like evm:base:84532)';

export const CHAIN_USAGE = `Usage: rig chain [set <chain> | unset]

Choose which chain — and therefore which USDC token — settles paid \`rig\`
writes. The choice is saved to the client config's \`chain\` field and applies to
every subsequent paid command (there is no per-command chain flag). Free: only
the local config file is touched.

  rig chain               show the current settlement-chain preference
  rig chain set <chain>   pin the settlement chain / USDC:
                            evm   → EVM USDC (Base Sepolia on devnet)
                            sol   → Solana USDC
                            mina  → Mina USDC
                          (a full id like evm:base:84532 or solana:devnet also
                          works; \`solana\` is accepted for \`sol\`, \`eth\` for \`evm\`)
  rig chain unset         clear the pin — revert to automatic selection

When nothing is pinned, rig auto-selects: your most-recently-used open channel's
chain, else the first announced chain your wallet holds USDC on, else the first
announced EVM chain.

Options:
  --json               machine-readable envelope
  -h, --help           show this help`;

/** What `rig chain` needs from the command environment. */
export interface ChainDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

/** The slice of the shared client config `rig chain` reads/writes. */
interface ChainConfigFile {
  chain?: string;
  supportedChains?: string[];
  [key: string]: unknown;
}

/** `--json` envelope. */
interface ChainJson {
  command: 'chain';
  /** The effective settlement-chain preference, or null when unset (auto). */
  chain: string | null;
  /** Where the effective value came from. */
  source: 'env' | 'config' | 'supportedChains' | 'auto';
  /** The USDC token family the effective chain spends (null when auto). */
  usdc: string | null;
  /** The value written to the config `chain` field (set/unset only). */
  wrote?: string | null;
  configPath: string;
  /** Precedence warnings that may keep the pin from taking effect. */
  warnings?: string[];
}

/** Resolve the client config directory + path (mirrors readFundConfig). */
function configPathFor(env: NodeJS.ProcessEnv): string {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(dir, 'config.json');
}

function readChainConfig(configPath: string): ChainConfigFile {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as ChainConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Read-merge-write: preserve every other field, only touch `chain`. */
function writeChainConfig(configPath: string, file: ChainConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * Normalize a `set` argument to the string stored in config. A value with a
 * `:` is a full chain id (family must be evm/solana/mina); otherwise it is a
 * family alias. Throws a usage error on anything else.
 */
function normalizeChain(raw: string): string {
  if (raw.includes(':')) {
    const family = raw.split(':')[0]?.toLowerCase() ?? '';
    if (!(family in FAMILY_USDC)) {
      throw new Error(
        `unknown chain family in ${JSON.stringify(raw)} — must start with evm:, solana:, or mina:`
      );
    }
    return raw;
  }
  const canonical = FAMILY_ALIASES[raw.toLowerCase()];
  if (!canonical) {
    throw new Error(`chain must be one of ${CHAIN_ARG_LIST}, got ${JSON.stringify(raw)}`);
  }
  return canonical;
}

/** The USDC family label for a stored chain value (family or full id). */
function usdcFor(chain: string): string {
  const family = (chain.includes(':') ? (chain.split(':')[0] ?? chain) : chain).toLowerCase();
  return FAMILY_USDC[family] ?? `${family} USDC`;
}

/** Run `rig chain`; returns the process exit code. */
export async function runChain(args: string[], deps: ChainDeps): Promise<number> {
  const { io, env } = deps;

  let positionals: string[];
  let json = false;
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (parsed.values.help) {
      io.out(CHAIN_USAGE);
      return 0;
    }
    positionals = parsed.positionals;
    json = parsed.values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CHAIN_USAGE);
    return 2;
  }

  const [sub, ...subRest] = positionals;
  if (sub !== undefined && sub !== 'set' && sub !== 'unset') {
    io.err(`unknown subcommand ${JSON.stringify(sub)} — expected \`set\`, \`unset\`, or no argument`);
    io.err(CHAIN_USAGE);
    return 2;
  }
  if (sub === 'set' && subRest.length !== 1) {
    io.err(
      subRest.length === 0
        ? `rig chain set needs a chain: ${CHAIN_ARG_LIST}`
        : `rig chain set takes exactly one chain, got ${subRest.length}: ${subRest.join(' ')}`
    );
    io.err(CHAIN_USAGE);
    return 2;
  }
  if (sub === 'unset' && subRest.length !== 0) {
    io.err(`rig chain unset takes no arguments, got: ${subRest.join(' ')}`);
    io.err(CHAIN_USAGE);
    return 2;
  }
  // Normalize the `set` value here (not inside the emitCliError-wrapped block)
  // so an unknown chain is a USAGE error (exit 2), not a runtime error.
  let setValue: string | undefined;
  if (sub === 'set') {
    try {
      setValue = normalizeChain(subRest[0] as string);
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      io.err(CHAIN_USAGE);
      return 2;
    }
  }

  try {
    const configPath = configPathFor(env);
    const file = readChainConfig(configPath);
    const envChain = env['TOON_CLIENT_CHAIN'];
    const supported0 = file.supportedChains?.[0];

    // Precedence warnings shared by set/unset: env overrides config, and a
    // supportedChains array overrides the plain `chain` field.
    const precedenceWarnings = (targetField: 'chain' | null): string[] => {
      const w: string[] = [];
      if (envChain !== undefined) {
        w.push(
          `TOON_CLIENT_CHAIN=${envChain} is set in the environment and overrides the config ` +
            `${targetField === 'chain' ? 'value you just wrote' : 'file'} — unset it for the config to take effect.`
        );
      }
      if (supported0 !== undefined) {
        w.push(
          `config \`supportedChains\` is set (first entry ${JSON.stringify(supported0)}) and takes ` +
            'precedence over `chain` — clear or reorder it for this pin to take effect.'
        );
      }
      return w;
    };

    // ── set ────────────────────────────────────────────────────────────────
    if (sub === 'set') {
      const value = setValue as string;
      file.chain = value;
      writeChainConfig(configPath, file);
      const warnings = precedenceWarnings('chain');
      if (json) {
        io.emitJson({
          command: 'chain',
          chain: envChain ?? value,
          source: envChain !== undefined ? 'env' : 'config',
          usdc: usdcFor(envChain ?? value),
          wrote: value,
          configPath,
          ...(warnings.length ? { warnings } : {}),
        } satisfies ChainJson);
        return 0;
      }
      io.out(`Settlement chain set to ${value} → spends ${usdcFor(value)}.`);
      io.out(`Saved to ${configPath}. Applies to the next paid command (e.g. \`rig push\`).`);
      for (const w of warnings) io.err(`warning: ${w}`);
      return 0;
    }

    // ── unset ──────────────────────────────────────────────────────────────
    if (sub === 'unset') {
      const had = file.chain;
      delete file.chain;
      writeChainConfig(configPath, file);
      // After unset, what still pins the chain (env / supportedChains), if any.
      const stillPinned = envChain ?? supported0;
      if (json) {
        io.emitJson({
          command: 'chain',
          chain: stillPinned ?? null,
          source: envChain !== undefined ? 'env' : supported0 !== undefined ? 'supportedChains' : 'auto',
          usdc: stillPinned ? usdcFor(stillPinned) : null,
          wrote: null,
          configPath,
          ...(precedenceWarnings(null).length ? { warnings: precedenceWarnings(null) } : {}),
        } satisfies ChainJson);
        return 0;
      }
      io.out(
        had !== undefined
          ? `Cleared the settlement-chain pin (was ${had}).`
          : 'No settlement-chain pin was set.'
      );
      if (stillPinned !== undefined) {
        io.out(`Still pinned to ${stillPinned} by ${envChain !== undefined ? 'TOON_CLIENT_CHAIN' : 'config supportedChains'} → ${usdcFor(stillPinned)}.`);
      } else {
        io.out('Reverted to automatic selection (most-recent channel → first funded announced chain → first EVM).');
      }
      return 0;
    }

    // ── show (no subcommand) ────────────────────────────────────────────────
    const effective = envChain ?? file.chain ?? supported0;
    const source: ChainJson['source'] =
      envChain !== undefined
        ? 'env'
        : file.chain !== undefined
          ? 'config'
          : supported0 !== undefined
            ? 'supportedChains'
            : 'auto';
    if (json) {
      io.emitJson({
        command: 'chain',
        chain: effective ?? null,
        source,
        usdc: effective ? usdcFor(effective) : null,
        configPath,
      } satisfies ChainJson);
      return 0;
    }
    if (effective !== undefined) {
      const via =
        source === 'env'
          ? 'TOON_CLIENT_CHAIN env'
          : source === 'config'
            ? `config \`chain\` (${configPath})`
            : `config \`supportedChains[0]\``;
      io.out(`Settlement chain: ${effective} → spends ${usdcFor(effective)} (from ${via}).`);
      io.out('Change it with `rig chain set <evm|sol|mina>`, or `rig chain unset` for auto.');
    } else {
      io.out('Settlement chain: (auto) — no pin set.');
      io.out('rig picks your most-recent open channel, else the first announced chain your');
      io.out('wallet holds USDC on, else the first announced EVM chain.');
      io.out('Pin one with `rig chain set <evm|sol|mina>`.');
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'chain', err);
  }
}
