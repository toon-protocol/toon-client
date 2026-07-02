/**
 * Publisher-mode selection for the `rig` CLI (#229).
 *
 * Two ways to pay for a push:
 *
 *   daemon      — a running `toon-clientd` control API on loopback; the CLI
 *                 drives its `/git/*` routes with plain fetch (this package
 *                 must NOT import `@toon-protocol/client-mcp` — that package
 *                 depends on this one, the import would be circular; the
 *                 loopback conventions are mirrored here the same way
 *                 `standalone/nonce-guard.ts` mirrors them).
 *   standalone  — an embedded ToonClient built from the caller's own
 *                 mnemonic (`@toon-protocol/git/standalone`).
 *
 * Selection: explicit `--daemon` / `--standalone` flags win; otherwise probe
 * the daemon `/status` — reachable AND reporting an identity ⇒ daemon; else
 * standalone when a mnemonic source exists (`TOON_CLIENT_MNEMONIC` or the
 * shared `~/.toon-client/config.json`); else a hard error naming both options.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DAEMON_PORT } from '../standalone/nonce-guard.js';

export type PushMode = 'daemon' | 'standalone';

/** Result of probing the toon-clientd loopback `/status`. */
export interface DaemonProbe {
  /** Control API base URL probed, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** True when `/status` answered 200 with parseable JSON. */
  reachable: boolean;
  /** `identity.nostrPubkey` from the status body (when reachable). */
  identity?: string;
  /** `ready` from the status body (channel open, publish-ready). */
  ready?: boolean;
  /** Daemon's default relay URL (`relay.url`), for git-config persistence. */
  relayUrl?: string;
}

/** Availability of standalone mode (a mnemonic source exists). */
export interface StandaloneAvailability {
  available: boolean;
  /** Where the mnemonic would come from. */
  source?: 'env' | 'config';
  /** The client config path consulted (for error messages). */
  configPath: string;
}

/** Loopback control API base URL (port: `TOON_CLIENT_HTTP_PORT`, else 8787). */
export function daemonBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['TOON_CLIENT_HTTP_PORT'];
  const parsed = raw ? Number(raw) : NaN;
  const port =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Probe `GET /status` on the loopback control API. Anything short of a 200
 * with JSON (no listener, timeout, other service) reports unreachable — the
 * caller then falls back to standalone or errors with remediation.
 */
export async function probeDaemon(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  timeoutMs = 1500
): Promise<DaemonProbe> {
  const baseUrl = daemonBaseUrl(env);
  try {
    const res = await fetchImpl(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { baseUrl, reachable: false };
    const body = (await res.json()) as {
      ready?: unknown;
      identity?: { nostrPubkey?: unknown };
      relay?: { url?: unknown };
    };
    const probe: DaemonProbe = { baseUrl, reachable: true };
    const pubkey = body?.identity?.nostrPubkey;
    if (typeof pubkey === 'string' && pubkey !== '') probe.identity = pubkey;
    if (typeof body?.ready === 'boolean') probe.ready = body.ready;
    if (typeof body?.relay?.url === 'string' && body.relay.url !== '') {
      probe.relayUrl = body.relay.url;
    }
    return probe;
  } catch {
    return { baseUrl, reachable: false };
  }
}

/** Shared client state dir (duplicated convention: `TOON_CLIENT_HOME`, else `~/.toon-client`). */
export function clientConfigPath(env: NodeJS.ProcessEnv): string {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(dir, 'config.json');
}

/**
 * True when standalone mode has an identity to work with: the
 * `TOON_CLIENT_MNEMONIC` env var, or a `mnemonic`/`keystorePath` entry in the
 * shared client config file. Deliberately import-free of
 * `@toon-protocol/client` — this runs during mode selection, before the
 * (optional) standalone dependency is ever loaded.
 */
export function standaloneAvailability(
  env: NodeJS.ProcessEnv
): StandaloneAvailability {
  const configPath = clientConfigPath(env);
  if (env['TOON_CLIENT_MNEMONIC']) {
    return { available: true, source: 'env', configPath };
  }
  if (existsSync(configPath)) {
    try {
      const file = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mnemonic?: unknown;
        keystorePath?: unknown;
      };
      if (
        (typeof file.mnemonic === 'string' && file.mnemonic !== '') ||
        (typeof file.keystorePath === 'string' && file.keystorePath !== '')
      ) {
        return { available: true, source: 'config', configPath };
      }
    } catch {
      // Unreadable config → no standalone identity from it.
    }
  }
  return { available: false, configPath };
}

/** Raised when neither mode is usable; message carries both remediations. */
export class NoPublisherError extends Error {
  constructor(probe: DaemonProbe, standalone: StandaloneAvailability) {
    super(
      'no way to pay for this push — neither publisher mode is available:\n' +
        `  • daemon: no toon-clientd control API at ${probe.baseUrl}/status — ` +
        'start it (`toon-clientd`, shipped by @toon-protocol/client-mcp) and re-run, ' +
        'or pass --daemon once it is up\n' +
        '  • standalone: no identity found — set TOON_CLIENT_MNEMONIC (BIP-39 seed ' +
        `phrase) or configure ${standalone.configPath} (mnemonic / keystorePath), ` +
        'then re-run (or pass --standalone)'
    );
    this.name = 'NoPublisherError';
  }
}

export interface SelectModeOptions {
  /** Explicit `--daemon` flag. */
  daemon: boolean;
  /** Explicit `--standalone` flag. */
  standalone: boolean;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}

export interface SelectedMode {
  mode: PushMode;
  /** Probe result (always populated in daemon mode; best-effort otherwise). */
  probe: DaemonProbe;
}

/**
 * Pick the publisher mode. Explicit flags win (an unreachable `--daemon`
 * still selects daemon — the push then fails with the exact "start
 * toon-clientd" remediation); default is probe-daemon-first with a
 * standalone fallback.
 */
export async function selectMode(
  options: SelectModeOptions
): Promise<SelectedMode> {
  const { env, fetchImpl } = options;
  if (options.daemon && options.standalone) {
    throw new Error('--daemon and --standalone are mutually exclusive');
  }
  if (options.standalone) {
    return {
      mode: 'standalone',
      probe: { baseUrl: daemonBaseUrl(env), reachable: false },
    };
  }
  const probe = await probeDaemon(env, fetchImpl);
  if (options.daemon) return { mode: 'daemon', probe };

  if (probe.reachable && probe.identity) return { mode: 'daemon', probe };

  const standalone = standaloneAvailability(env);
  if (standalone.available) return { mode: 'standalone', probe };

  throw new NoPublisherError(probe, standalone);
}
