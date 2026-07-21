/**
 * `rig entry` — choose which network entry node (payment ingress + relay)
 * `rig` talks to.
 *
 * The entry node is where paid writes enter the network: the BTP/proxy
 * endpoint claims ride in on, plus the relay repo events publish to. On the
 * shared devnet there are two well-known entries:
 *
 *   apex     the default TOON apex — settles evm | sol | mina directly.
 *            Baked into core's genesis seed; `rig entry apex` simply clears
 *            the config override so the seed (or a live announce) applies.
 *   sandbox  the Mina-only demo entry for the cross-currency multihop path
 *            (you pay Mina USDC; the hops settle Base then Solana). Endpoints
 *            are baked here.
 *
 *   rig entry               show the effective entry endpoints + their source
 *   rig entry apex          revert to the default apex (clears the override)
 *   rig entry sandbox       point at the devnet sandbox entry
 *   rig entry <wss-url>     point at an explicit BTP endpoint
 *                           (--relay <url> to also set the relay)
 *
 * A FREE command: only the local config file is touched. Mutations write the
 * shared client config's `btpUrl`/`relayUrl` (read-merge-write), DELETE the
 * legacy `proxyUrl` spelling (it outranks `btpUrl` in the resolver — leaving
 * it would silently keep the old entry), and best-effort delete the topology
 * cache so the next paid command discovers the new entry's announce instead
 * of reusing the old one's.
 *
 * Two caveats every mutation surfaces:
 *   - env precedence: `TOON_CLIENT_BTP_URL`/`TOON_CLIENT_PROXY_URL`/
 *     `TOON_CLIENT_RELAY_URL` override the config write.
 *   - channels are per-entry-peer: existing channels (see `rig channels`)
 *     are not used with the new entry; the next paid command opens or
 *     resumes one with the new peer.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import type { CliIo } from './output.js';
import { TOPOLOGY_CACHE_FILENAME } from '../standalone/topology-cache.js';

/** The devnet sandbox entry (Mina-USDC-only; the multihop demo path). */
export const SANDBOX_BTP_URL = 'wss://proxy.sandbox.devnet.toonprotocol.dev:443';
export const SANDBOX_RELAY_URL = 'wss://relay-ws.sandbox.devnet.toonprotocol.dev';

export const ENTRY_USAGE = `Usage: rig entry [apex | sandbox | <wss-url>] [options]

Choose which network entry node (payment ingress + relay) rig talks to. Free:
only the local config file is touched.

  rig entry               show the effective entry endpoints and their source
  rig entry apex          revert to the default apex: clears the btpUrl/
                          relayUrl override so core's genesis seed (or a live
                          announce) applies — settles evm | sol | mina
  rig entry sandbox       the devnet sandbox entry (Mina USDC ONLY — the
                          cross-currency multihop demo path):
                            btp    ${SANDBOX_BTP_URL}
                            relay  ${SANDBOX_RELAY_URL}
  rig entry <wss-url>     an explicit BTP endpoint (ws:// or wss://); pass
                          --relay <url> to also set the relay

Switching entries deletes the cached topology (the next paid command
re-discovers the new entry's announce) and leaves existing payment channels
behind — channels are per-entry-peer; the next paid command opens or resumes
one with the new peer.

NOTE for repos: the relay a repo publishes to is its git \`origin\` remote,
which OVERRIDES the config relayUrl. After switching entries, point the repo
too: \`rig remote add origin <relay-url>\` (or use a fresh repo).

Options:
  --relay <url>        with <wss-url>: also set the relay URL
  --json               machine-readable envelope
  -h, --help           show this help`;

/** What `rig entry` needs from the command environment. */
export interface EntryDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  /**
   * Genesis-seed loader seam (the default-apex endpoints shown when nothing
   * is configured). Defaults to the lazy standalone network-bootstrap import;
   * tests inject.
   */
  loadGenesisSeed?: () => Promise<
    { relayUrl?: string; btpEndpoint?: string } | undefined
  >;
}

/** The slice of the shared client config `rig entry` reads/writes. */
interface EntryConfigFile {
  btpUrl?: string;
  relayUrl?: string;
  proxyUrl?: string;
  chain?: string;
  supportedChains?: string[];
  [key: string]: unknown;
}

/** Where an effective endpoint value came from. */
type EndpointSource = 'env' | 'config' | 'genesis-seed' | null;

/** `--json` envelope. */
interface EntryJson {
  command: 'entry';
  /** The named entry this matches: apex (genesis default), sandbox, custom. */
  entry: 'apex' | 'sandbox' | 'custom' | null;
  btpUrl: string | null;
  btpSource: EndpointSource;
  relayUrl: string | null;
  relaySource: EndpointSource;
  /** What was written to config (mutations only). */
  wrote?: { btpUrl: string | null; relayUrl: string | null };
  /** True when the cached topology file was deleted by this mutation. */
  clearedTopologyCache?: boolean;
  configPath: string;
  warnings?: string[];
}

/** Resolve the client config directory + path (mirrors `rig chain`). */
function configPathFor(env: NodeJS.ProcessEnv): string {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(dir, 'config.json');
}

function readEntryConfig(configPath: string): EntryConfigFile {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as EntryConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Read-merge-write: preserve every other field. */
function writeEntryConfig(configPath: string, file: EntryConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Default genesis-seed loader (lazy, failure ⇒ no seed — never an error). */
async function loadGenesisSeedDefault(): Promise<
  { relayUrl?: string; btpEndpoint?: string } | undefined
> {
  try {
    const { loadGenesisSeed } = await import(
      '../standalone/network-bootstrap.js'
    );
    return loadGenesisSeed();
  } catch {
    return undefined;
  }
}

/** Classify effective endpoints as a named entry for the envelope/labels. */
function classifyEntry(
  btpUrl: string | null,
  seedBtp: string | undefined,
  btpSource: EndpointSource
): EntryJson['entry'] {
  if (btpUrl === null) return null;
  if (btpUrl === SANDBOX_BTP_URL) return 'sandbox';
  if (btpSource === 'genesis-seed' || btpUrl === seedBtp) return 'apex';
  return 'custom';
}

/** Run `rig entry`; returns the process exit code. */
export async function runEntry(args: string[], deps: EntryDeps): Promise<number> {
  const { io, env } = deps;

  let positionals: string[];
  let relayFlag: string | undefined;
  let json = false;
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        relay: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (parsed.values.help) {
      io.out(ENTRY_USAGE);
      return 0;
    }
    positionals = parsed.positionals;
    relayFlag = parsed.values.relay;
    json = parsed.values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(ENTRY_USAGE);
    return 2;
  }

  if (positionals.length > 1) {
    io.err(
      `rig entry takes at most one argument, got ${positionals.length}: ${positionals.join(' ')}`
    );
    io.err(ENTRY_USAGE);
    return 2;
  }
  const target = positionals[0];

  // Usage-validate the target OUTSIDE the runtime-error wrapper (exit 2).
  let mutation:
    | { kind: 'apex' }
    | { kind: 'sandbox' }
    | { kind: 'url'; btpUrl: string; relayUrl?: string }
    | undefined;
  if (target !== undefined) {
    if (target === 'apex') {
      if (relayFlag !== undefined) {
        io.err('--relay only applies to an explicit <wss-url> entry');
        io.err(ENTRY_USAGE);
        return 2;
      }
      mutation = { kind: 'apex' };
    } else if (target === 'sandbox') {
      if (relayFlag !== undefined) {
        io.err('--relay only applies to an explicit <wss-url> entry');
        io.err(ENTRY_USAGE);
        return 2;
      }
      mutation = { kind: 'sandbox' };
    } else if (/^wss?:\/\/.+/.test(target)) {
      if (relayFlag !== undefined && !/^wss?:\/\/.+/.test(relayFlag)) {
        io.err(
          `--relay must be a ws(s) URL, got ${JSON.stringify(relayFlag)}`
        );
        io.err(ENTRY_USAGE);
        return 2;
      }
      mutation = {
        kind: 'url',
        btpUrl: target,
        ...(relayFlag !== undefined ? { relayUrl: relayFlag } : {}),
      };
    } else {
      io.err(
        `unknown entry ${JSON.stringify(target)} — expected \`apex\`, \`sandbox\`, or a ws(s):// URL`
      );
      io.err(ENTRY_USAGE);
      return 2;
    }
  }

  try {
    const configPath = configPathFor(env);
    const file = readEntryConfig(configPath);
    const seed = await (deps.loadGenesisSeed ?? loadGenesisSeedDefault)();

    const effective = (): {
      btpUrl: string | null;
      btpSource: EndpointSource;
      relayUrl: string | null;
      relaySource: EndpointSource;
    } => {
      // Mirrors resolveNetworkTopology's explicit precedence: the proxy
      // spelling outranks btp; env outranks config; genesis seed is last.
      const btpExplicit =
        env['TOON_CLIENT_PROXY_URL'] ??
        env['TOON_CLIENT_BTP_URL'] ??
        file.proxyUrl ??
        file.btpUrl;
      const btpFromEnv =
        env['TOON_CLIENT_PROXY_URL'] ?? env['TOON_CLIENT_BTP_URL'];
      const relayExplicit = env['TOON_CLIENT_RELAY_URL'] ?? file.relayUrl;
      return {
        btpUrl: btpExplicit ?? seed?.btpEndpoint ?? null,
        btpSource: btpExplicit
          ? btpFromEnv
            ? 'env'
            : 'config'
          : seed?.btpEndpoint
            ? 'genesis-seed'
            : null,
        relayUrl: relayExplicit ?? seed?.relayUrl ?? null,
        relaySource: env['TOON_CLIENT_RELAY_URL']
          ? 'env'
          : file.relayUrl
            ? 'config'
            : seed?.relayUrl
              ? 'genesis-seed'
              : null,
      };
    };

    // ── show (no argument) ─────────────────────────────────────────────────
    if (mutation === undefined) {
      const state = effective();
      const entry = classifyEntry(state.btpUrl, seed?.btpEndpoint, state.btpSource);
      if (json) {
        io.emitJson({
          command: 'entry',
          entry,
          btpUrl: state.btpUrl,
          btpSource: state.btpSource,
          relayUrl: state.relayUrl,
          relaySource: state.relaySource,
          configPath,
        } satisfies EntryJson);
        return 0;
      }
      const label = (source: EndpointSource): string =>
        source === 'env'
          ? 'env'
          : source === 'config'
            ? `config (${configPath})`
            : source === 'genesis-seed'
              ? 'default apex — genesis seed'
              : 'not configured';
      io.out(
        `Entry: ${entry ?? '(none)'}${entry === 'sandbox' ? ' (Mina USDC only — multihop demo path)' : ''}`
      );
      io.out(`  btp    ${state.btpUrl ?? '(none)'}  [${label(state.btpSource)}]`);
      io.out(`  relay  ${state.relayUrl ?? '(none)'}  [${label(state.relaySource)}]`);
      io.out(
        'Switch with `rig entry apex`, `rig entry sandbox`, or `rig entry <wss-url>`.'
      );
      return 0;
    }

    // ── mutations ──────────────────────────────────────────────────────────
    const warnings: string[] = [];
    for (const envVar of [
      'TOON_CLIENT_BTP_URL',
      'TOON_CLIENT_PROXY_URL',
      'TOON_CLIENT_RELAY_URL',
    ]) {
      if (env[envVar] !== undefined) {
        warnings.push(
          `${envVar}=${env[envVar]} is set in the environment and overrides ` +
            'the config value you just wrote — unset it for this entry to take effect.'
        );
      }
    }
    warnings.push(
      'Payment channels are per-entry-peer: existing channels (see `rig channels`) ' +
        'are not used with the new entry — the next paid command opens or resumes ' +
        'a channel with the new peer.'
    );

    const hadProxyUrl = file.proxyUrl !== undefined;
    let wroteBtp: string | null;
    let wroteRelay: string | null;
    if (mutation.kind === 'apex') {
      wroteBtp = null;
      wroteRelay = null;
      delete file.btpUrl;
      delete file.relayUrl;
      delete file.proxyUrl;
    } else if (mutation.kind === 'sandbox') {
      wroteBtp = SANDBOX_BTP_URL;
      wroteRelay = SANDBOX_RELAY_URL;
      file.btpUrl = SANDBOX_BTP_URL;
      file.relayUrl = SANDBOX_RELAY_URL;
      delete file.proxyUrl;
    } else {
      wroteBtp = mutation.btpUrl;
      wroteRelay = mutation.relayUrl ?? null;
      file.btpUrl = mutation.btpUrl;
      if (mutation.relayUrl !== undefined) file.relayUrl = mutation.relayUrl;
      delete file.proxyUrl;
    }
    if (hadProxyUrl) {
      warnings.push(
        'Removed the legacy `proxyUrl` config field — it outranks `btpUrl` and ' +
          'would have silently kept the old entry.'
      );
    }
    writeEntryConfig(configPath, file);

    // Delete the cached topology so the next paid command re-discovers the
    // new entry's announce instead of reusing the old one within its TTL.
    let clearedTopologyCache = false;
    try {
      unlinkSync(join(dirname(configPath), TOPOLOGY_CACHE_FILENAME));
      clearedTopologyCache = true;
    } catch {
      // best-effort: usually ENOENT (no cache yet)
    }

    if (mutation.kind === 'sandbox') {
      const effectiveChain = env['TOON_CLIENT_CHAIN'] ?? file.chain ?? file.supportedChains?.[0];
      if (effectiveChain === undefined || !effectiveChain.startsWith('mina')) {
        warnings.push(
          'The sandbox entry settles ONLY mina:devnet — run `rig chain set mina` ' +
            (effectiveChain !== undefined
              ? `(currently ${effectiveChain}).`
              : 'to pin it.')
        );
      }
      warnings.push(
        'Repos publish to their git `origin` relay, which OVERRIDES the config ' +
          `relayUrl — for the sandbox demo run \`rig remote add origin ${SANDBOX_RELAY_URL}\` ` +
          'in the repo (or use a fresh repo).'
      );
    }

    const state = effective();
    if (json) {
      io.emitJson({
        command: 'entry',
        entry:
          mutation.kind === 'url'
            ? 'custom'
            : mutation.kind,
        btpUrl: state.btpUrl,
        btpSource: state.btpSource,
        relayUrl: state.relayUrl,
        relaySource: state.relaySource,
        wrote: { btpUrl: wroteBtp, relayUrl: wroteRelay },
        clearedTopologyCache,
        configPath,
        ...(warnings.length ? { warnings } : {}),
      } satisfies EntryJson);
      return 0;
    }
    if (mutation.kind === 'apex') {
      io.out('Entry reverted to the default apex (cleared btpUrl/relayUrl/proxyUrl).');
      io.out(`  btp    ${state.btpUrl ?? '(genesis seed unavailable)'}`);
      io.out(`  relay  ${state.relayUrl ?? '(genesis seed unavailable)'}`);
    } else if (mutation.kind === 'sandbox') {
      io.out('Entry set to the devnet sandbox (Mina USDC only — multihop demo path).');
      io.out(`  btp    ${SANDBOX_BTP_URL}`);
      io.out(`  relay  ${SANDBOX_RELAY_URL}`);
    } else {
      io.out(`Entry set to ${mutation.btpUrl}.`);
      if (mutation.relayUrl !== undefined) io.out(`  relay  ${mutation.relayUrl}`);
    }
    io.out(
      `Saved to ${configPath}.` +
        (clearedTopologyCache ? ' Cleared the cached topology.' : '')
    );
    for (const w of warnings) io.err(`warning: ${w}`);
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'entry', err);
  }
}
