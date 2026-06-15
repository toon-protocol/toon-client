/**
 * Persists DYNAMIC targets — relays added via `toon_add_relay` and apexes added
 * via `toon_add_apex` — to `~/.toon-client/targets.json` so they survive a
 * daemon restart. The config file's single `relayUrl`/`btpUrl` remain the
 * permanent "default" target and are NOT stored here; only runtime additions are.
 *
 * On boot the `ClientRunner` seeds the default from config, then replays this
 * store to re-instantiate every dynamically-added relay/apex. Add/remove tool
 * calls write straight back here (last-write-wins, mode 0o600), mirroring the
 * `apex-channel-store.ts` pattern.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';
import type { ApexNegotiationConfig } from './config.js';

/** A persisted relay read target. */
export interface PersistedRelayTarget {
  /** Relay WS URL (the map key). */
  relayUrl: string;
}

/** A persisted apex write target with its discovered settlement negotiation. */
export interface PersistedApexTarget {
  /** BTP WS endpoint of the apex (the map key). */
  btpUrl: string;
  /** Settlement negotiation, discovered from the apex's kind:10032 announcement. */
  negotiation: ApexNegotiationConfig;
  /** Child peers reached via this apex's channel (e.g. `["dvm","mill"]`). */
  apexChildPeers?: string[];
  /** Per-write fee override (base units). Falls back to the daemon default. */
  feePerEvent?: string;
  /** Relay the negotiation was discovered on (re-discovery / provenance). */
  discoveredFrom?: string;
}

export interface TargetsFile {
  relays: PersistedRelayTarget[];
  apexes: PersistedApexTarget[];
}

const EMPTY: TargetsFile = { relays: [], apexes: [] };

/** Default targets-store path: `~/.toon-client/targets.json`. */
export function defaultTargetsPath(): string {
  return join(configDir(), 'targets.json');
}

/** Read + parse the targets store, returning empty arrays when absent/invalid. */
export function loadTargets(path = defaultTargetsPath()): TargetsFile {
  let parsed: Partial<TargetsFile>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TargetsFile>;
  } catch {
    return { relays: [], apexes: [] };
  }
  return {
    relays: Array.isArray(parsed.relays) ? parsed.relays : [],
    apexes: Array.isArray(parsed.apexes) ? parsed.apexes : [],
  };
}

function write(path: string, data: TargetsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Upsert a relay target (idempotent by `relayUrl`). */
export function saveRelayTarget(
  relayUrl: string,
  path = defaultTargetsPath()
): void {
  const store = loadTargets(path);
  if (!store.relays.some((r) => r.relayUrl === relayUrl)) {
    store.relays.push({ relayUrl });
    write(path, store);
  }
}

/** Remove a relay target. Returns true if it was present. */
export function removeRelayTarget(
  relayUrl: string,
  path = defaultTargetsPath()
): boolean {
  const store = loadTargets(path);
  const next = store.relays.filter((r) => r.relayUrl !== relayUrl);
  if (next.length === store.relays.length) return false;
  store.relays = next;
  write(path, store);
  return true;
}

/** Upsert an apex target (last-write-wins by `btpUrl`). */
export function saveApexTarget(
  target: PersistedApexTarget,
  path = defaultTargetsPath()
): void {
  const store = loadTargets(path);
  store.apexes = store.apexes.filter((a) => a.btpUrl !== target.btpUrl);
  store.apexes.push(target);
  write(path, store);
}

/** Remove an apex target. Returns true if it was present. */
export function removeApexTarget(
  btpUrl: string,
  path = defaultTargetsPath()
): boolean {
  const store = loadTargets(path);
  const next = store.apexes.filter((a) => a.btpUrl !== btpUrl);
  if (next.length === store.apexes.length) return false;
  store.apexes = next;
  write(path, store);
  return true;
}

export { EMPTY as EMPTY_TARGETS };
