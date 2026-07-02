/**
 * Relays as origins (#249): the `rig remote` subcommand and the relay
 * resolution every paid command shares.
 *
 * Remotes are stored as REAL git remotes (`git remote add/remove` under the
 * hood), so `git remote -v` shows them and plain git tooling round-trips the
 * config — no parallel store. Paid commands resolve their relay as:
 *
 *   1. `--relay <url>`               ad-hoc override, bypasses remotes
 *   2. a named remote                `rig push <remote>` / `--remote <name>`
 *   3. the `origin` remote           the default target
 *   4. git config `toon.relay`      DEPRECATED v0.1 fallback (one-line nudge;
 *                                    the key is removed in v0.3)
 *   5. error                         "no origin configured — run `rig remote
 *                                    add origin <relay-url>`"
 *
 * A remote with multiple URLs (`git remote set-url --add` done by hand) is
 * refused BEFORE anything is fetched, uploaded, or paid: rig publishes to
 * exactly one relay per paid command (the #243 single-relay guard). One
 * carve-out: a default `origin` whose URLs are ALL non-relay is a plain git
 * remote — it is skipped like any single non-relay origin, never refused.
 */

import { parseArgs } from 'node:util';
import {
  emitCliError,
  InvalidRelayUrlError,
  MultiUrlRemoteError,
  NoOriginConfiguredError,
  NotAGitRepositoryError,
  UnknownRemoteError,
} from './errors.js';
import {
  addGitRemote,
  getGitRemoteUrls,
  listGitRemotes,
  readToonConfig,
  removeGitRemote,
  resolveRepoRoot,
} from './git-config.js';
import type { CliIo } from './push.js';

// ---------------------------------------------------------------------------
// Relay URL validation
// ---------------------------------------------------------------------------

const RELAY_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:']);

/** True when `url` parses and uses a relay scheme (ws/wss/http/https). */
export function isRelayUrl(url: string): boolean {
  try {
    return RELAY_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Throw {@link InvalidRelayUrlError} unless `url` is a relay URL. */
export function assertRelayUrl(url: string, context: string): void {
  if (!isRelayUrl(url)) throw new InvalidRelayUrlError(url, context);
}

// ---------------------------------------------------------------------------
// Relay resolution (shared by push + the event commands)
// ---------------------------------------------------------------------------

/** Where the resolved relay came from. */
export type RelaySource = 'relay-flag' | 'remote' | 'toon.relay';

export interface ResolvedRelays {
  /** Relay URLs to publish to (paid commands still enforce exactly one). */
  relays: string[];
  source: RelaySource;
  /** The git remote that supplied the URL (source === 'remote'). */
  remoteName?: string;
  /** One-line stderr note (toon.relay deprecation), when applicable. */
  nudge?: string;
}

export interface ResolveRelaysOptions {
  /** `--relay` flag values (may be >1 — the command-level guard refuses). */
  relayFlags: string[];
  /** Explicitly requested remote (`rig push <remote>` / `--remote <name>`). */
  remoteName?: string | undefined;
  /** Repo worktree root; undefined when not inside a git repository. */
  repoRoot?: string | undefined;
  /** Deprecated `git config toon.relay` values (v0.1 fallback). */
  toonRelays: string[];
}

/**
 * Resolve the relay(s) for a paid command. Throws (before any payment):
 * {@link UnknownRemoteError}, {@link MultiUrlRemoteError},
 * {@link InvalidRelayUrlError}, {@link NoOriginConfiguredError}.
 */
export async function resolveRelays(
  opts: ResolveRelaysOptions
): Promise<ResolvedRelays> {
  // 1. Ad-hoc --relay override: bypasses the configured remotes entirely.
  if (opts.relayFlags.length > 0) {
    return { relays: opts.relayFlags, source: 'relay-flag' };
  }

  // 2. Explicitly named remote: must exist, carry ONE URL, and be a relay.
  if (opts.remoteName !== undefined) {
    const urls =
      opts.repoRoot !== undefined
        ? await getGitRemoteUrls(opts.repoRoot, opts.remoteName)
        : [];
    if (urls.length === 0) throw new UnknownRemoteError(opts.remoteName);
    if (urls.length > 1) throw new MultiUrlRemoteError(opts.remoteName, urls);
    const url = urls[0] as string;
    assertRelayUrl(url, `remote ${JSON.stringify(opts.remoteName)}`);
    return { relays: urls, source: 'remote', remoteName: opts.remoteName };
  }

  // 3. Default remote: origin — when it looks like a relay. A PURELY
  //    non-relay origin (e.g. a GitHub clone URL, even one with several
  //    mirror push URLs) is skipped, not an error: rig shares git's remote
  //    namespace, so pre-existing git origins must not break paid commands
  //    that can still resolve via toon.relay. But the moment ANY of a
  //    multi-URL origin's URLs is relay-shaped, the publish target is
  //    ambiguous — refuse before anything is fetched, uploaded, or paid
  //    (the #243 single-relay guard).
  let nonRelayOriginUrl: string | undefined;
  if (opts.repoRoot !== undefined) {
    const urls = await getGitRemoteUrls(opts.repoRoot, 'origin');
    if (urls.length === 1 && isRelayUrl(urls[0] as string)) {
      return { relays: urls, source: 'remote', remoteName: 'origin' };
    }
    if (urls.length > 1 && urls.some(isRelayUrl)) {
      throw new MultiUrlRemoteError('origin', urls);
    }
    // Reachable only when every remaining URL is non-relay (single relay URL
    // returned above; multi-URL with any relay URL threw above), so urls[0]
    // is guaranteed non-relay — NoOriginConfiguredError's message relies on
    // that ("the existing origin is not a relay URL").
    if (urls.length > 0) nonRelayOriginUrl = urls[0] as string;
  }

  // 4. Deprecated v0.1 fallback: git config toon.relay (nudges to migrate).
  if (opts.toonRelays.length > 0) {
    return {
      relays: opts.toonRelays,
      source: 'toon.relay',
      nudge:
        'note: git config toon.relay is deprecated (removed in v0.3) — ' +
        `migrate: rig remote add origin ${opts.toonRelays[0]}`,
    };
  }

  // 5. Nothing resolved.
  throw new NoOriginConfiguredError(nonRelayOriginUrl);
}

/**
 * Refusal line for >1 resolved relays: the StandalonePublisher publishes to
 * exactly one relay per paid command, and multiple can arrive without
 * explicit intent (repeated --relay flags, a multi-valued toon.relay).
 * `nothingHappened` names what was NOT done, e.g. 'Nothing was uploaded or
 * paid.'
 */
export function singleRelayRefusal(
  resolved: ResolvedRelays,
  nothingHappened: string
): string {
  const fix =
    resolved.source === 'relay-flag'
      ? 'pass exactly one --relay <url>'
      : 'trim git config toon.relay to one URL (better: migrate — ' +
        '`rig remote add origin <relay-url>`)';
  return (
    `rig publishes to a single relay, but ${resolved.relays.length} are ` +
    `configured (${resolved.relays.join(', ')}) — ${fix}. ${nothingHappened}`
  );
}

// ---------------------------------------------------------------------------
// rig remote <add|remove|list>
// ---------------------------------------------------------------------------

export const REMOTE_USAGE = `Usage: rig remote <add|remove|list> [args] [options]

Manage the relays this repo publishes to. Remotes are stored as REAL git
remotes (\`git remote -v\` shows them; plain git tooling round-trips). Paid
commands publish via the "origin" remote by default; \`rig push <remote>\`
and \`--remote <name>\` target another one. Free — nothing is published or
paid.

Commands:
  add <name> <relay-url>   add a remote pointing at a relay (the URL must be
                           ws://, wss://, http://, or https://)
  remove <name>            remove a remote
  list                     list remote names + URLs (the default subcommand)

Options:
  --json                   machine-readable envelope (all subcommands)
  -h, --help               show this help`;

/** Deps subset `rig remote` needs (free — no publisher, no identity). */
export interface RemoteDeps {
  io: CliIo;
  cwd: string;
}

/** Run `rig remote …`; returns the process exit code. */
export async function runRemote(
  args: string[],
  deps: RemoteDeps
): Promise<number> {
  const { io } = deps;

  let sub: string | undefined;
  let rest: string[];
  let json: boolean;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      io.out(REMOTE_USAGE);
      return 0;
    }
    json = values.json ?? false;
    [sub, ...rest] = positionals;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(REMOTE_USAGE);
    return 2;
  }

  // Argument-shape validation (exit 2) before touching the repository.
  switch (sub) {
    case undefined:
    case 'list':
      if (rest.length > 0) {
        io.err(`rig remote list takes no arguments (got ${rest.join(' ')})`);
        io.err(REMOTE_USAGE);
        return 2;
      }
      break;
    case 'add': {
      if (rest.length !== 2) {
        io.err('usage: rig remote add <name> <relay-url>');
        io.err(REMOTE_USAGE);
        return 2;
      }
      const url = rest[1] as string;
      if (!isRelayUrl(url)) {
        io.err(
          `cannot add remote: ${JSON.stringify(url)} is not a relay URL — ` +
            'relays are ws://, wss://, http://, or https://'
        );
        return 2;
      }
      break;
    }
    case 'remove':
      if (rest.length !== 1) {
        io.err('usage: rig remote remove <name>');
        io.err(REMOTE_USAGE);
        return 2;
      }
      break;
    default:
      io.err(`unknown rig remote subcommand: ${sub}`);
      io.err(REMOTE_USAGE);
      return 2;
  }

  try {
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
    } catch {
      throw new NotAGitRepositoryError(deps.cwd);
    }

    switch (sub) {
      case undefined:
      case 'list': {
        const remotes = await listGitRemotes(repoRoot);
        if (json) {
          io.emitJson({ command: 'remote', remotes });
          return 0;
        }
        if (remotes.length === 0) {
          io.out(
            'no remotes configured — add one: rig remote add origin <relay-url>'
          );
          return 0;
        }
        for (const remote of remotes) {
          for (const url of remote.urls) {
            io.out(
              `${remote.name}\t${url}` +
                (isRelayUrl(url) ? '' : '\t(not a relay URL — ignored by rig)')
            );
          }
          if (remote.urls.length > 1) {
            io.err(
              `warning: remote "${remote.name}" has ${remote.urls.length} ` +
                'URLs — rig supports one relay URL per remote (fix with ' +
                `\`git remote set-url ${remote.name} <relay-url>\`)`
            );
          }
        }
        return 0;
      }

      case 'add': {
        const [name, url] = rest as [string, string];
        const existing = await getGitRemoteUrls(repoRoot, name);
        if (existing.length > 0) {
          const detail =
            `remote ${JSON.stringify(name)} already exists ` +
            `(${existing.join(', ')}) — nothing changed. Point it ` +
            `somewhere else with \`git remote set-url ${name} <relay-url>\`, ` +
            `or \`rig remote remove ${name}\` first.`;
          if (json) {
            io.emitJson({
              command: 'remote',
              error: 'remote_exists',
              detail,
              remote: name,
              urls: existing,
            });
          }
          io.err(detail);
          return 1;
        }
        await addGitRemote(repoRoot, name, url);
        if (!json) io.out(`Added remote ${name} → ${url}`);
        if (name === 'origin') {
          if (!json) {
            io.out(
              '`rig push` and the event commands now publish here by default.'
            );
          }
          const toonConfig = await readToonConfig(repoRoot);
          if (toonConfig.relays.length > 0) {
            io.err(
              `note: git config toon.relay (${toonConfig.relays.join(', ')}) ` +
                'is deprecated and now shadowed by the origin remote — drop ' +
                'it with `git config --unset-all toon.relay` (the key is ' +
                'removed in v0.3).'
            );
          }
        }
        if (json) {
          io.emitJson({ command: 'remote', action: 'add', name, url });
        }
        return 0;
      }

      case 'remove': {
        const name = rest[0] as string;
        const existing = await getGitRemoteUrls(repoRoot, name);
        if (existing.length === 0) {
          const detail =
            `no remote named ${JSON.stringify(name)} — ` +
            '`rig remote list` shows configured remotes.';
          if (json) {
            io.emitJson({
              command: 'remote',
              error: 'unknown_remote',
              detail,
              remote: name,
            });
          }
          io.err(detail);
          return 1;
        }
        await removeGitRemote(repoRoot, name);
        if (json) {
          io.emitJson({ command: 'remote', action: 'remove', name });
        } else {
          io.out(`Removed remote ${name}`);
        }
        return 0;
      }

      /* v8 ignore next 2 -- unreachable: validated above */
      default:
        return 2;
    }
  } catch (err) {
    return emitCliError(io, json, 'remote', err);
  }
}
