/**
 * Error UX for the `rig` commands: map structured planner/publisher errors
 * to actionable terminal output (and a machine-readable envelope for
 * `--json`). The CLI is standalone-only (#248), so everything here is either
 * a local planner error, an identity/config-chain error, or a tagged error
 * surfaced from the embedded publisher (matched by name — those classes live
 * behind the lazy `@toon-protocol/client` dynamic import).
 */

import { MAX_OBJECT_SIZE } from '../objects.js';
import {
  NonFastForwardError,
  OversizeObjectsError,
  type OversizeObject,
  type RejectedRefUpdate,
} from '../push.js';
import { GitError } from '../repo-reader.js';
import { DaemonRouteError, DaemonUnreachableError } from './daemon-session.js';
import { MissingIdentityError } from './identity.js';
import type { CliIo } from './output.js';

/** Normalized error description: terminal lines + `--json` envelope. */
export interface DescribedError {
  /** Stable machine code. */
  code: string;
  /** Human-facing lines (message first, remediation after). */
  lines: string[];
  /** Machine envelope for `--json` output (structured payload included). */
  json: Record<string, unknown>;
}

/**
 * A command could not resolve the NIP-34 repo address
 * (`30617:<ownerPubkey>:<repoId>`) from flags or the `toon.*` git config
 * keys `rig init` writes.
 */
export class UnconfiguredRepoAddressError extends Error {
  constructor(
    /** Which half of the address is missing. */
    public readonly missing: 'repository id' | 'repository owner'
  ) {
    super(
      `no ${missing} configured — this command addresses the repo as ` +
        '30617:<ownerPubkey>:<repoId>. Run `rig init` once inside the repo ' +
        '(it writes toon.repoid/toon.owner to the local git config), or ' +
        `pass ${missing === 'repository id' ? '--repo-id <id>' : '--owner <pubkey>'} ` +
        "explicitly (use --owner for repos you don't own)."
    );
    this.name = 'UnconfiguredRepoAddressError';
  }
}

/** A relay URL (flag, `rig remote add`, or a remote's stored URL) is junk. */
export class InvalidRelayUrlError extends Error {
  constructor(
    public readonly url: string,
    /** What was being resolved, e.g. `remote "origin"`. */
    context: string
  ) {
    super(
      `${context}: ${JSON.stringify(url)} is not a relay URL — relays are ` +
        'ws://, wss://, http://, or https://'
    );
    this.name = 'InvalidRelayUrlError';
  }
}

/** A paid command addressed a git remote that is not configured. */
export class UnknownRemoteError extends Error {
  constructor(public readonly remote: string) {
    super(
      `no remote named ${JSON.stringify(remote)} is configured — ` +
        '`rig remote list` shows configured remotes; add it with ' +
        `\`rig remote add ${remote} <relay-url>\``
    );
    this.name = 'UnknownRemoteError';
  }
}

/**
 * The addressed git remote carries multiple URLs (`git remote set-url --add`
 * done by hand). rig publishes to exactly one relay per paid command, so this
 * is refused BEFORE anything is fetched, uploaded, or paid (the #243
 * single-relay guard, extended to remotes).
 */
export class MultiUrlRemoteError extends Error {
  constructor(
    public readonly remote: string,
    public readonly urls: string[]
  ) {
    super(
      `remote ${JSON.stringify(remote)} has ${urls.length} URLs ` +
        `(${urls.join(', ')}) — rig supports one relay URL per remote. ` +
        `Fix it with \`git remote set-url ${remote} <relay-url>\`. ` +
        'Nothing was uploaded, published, or paid.'
    );
    this.name = 'MultiUrlRemoteError';
  }
}

/** No relay resolved: no --relay, no usable remote, no legacy toon.relay. */
export class NoOriginConfiguredError extends Error {
  constructor(
    /** URL of an existing `origin` remote that is NOT a relay, if any. */
    nonRelayOriginUrl?: string
  ) {
    super(
      'no origin configured — run `rig remote add origin <relay-url>` ' +
        '(or pass --relay <url> for a one-off publish).' +
        (nonRelayOriginUrl !== undefined
          ? `\nThe existing "origin" remote (${nonRelayOriginUrl}) is not a ` +
            'relay URL, so rig ignores it — add the relay under another ' +
            'name (`rig remote add toon <relay-url>`) and target it ' +
            'explicitly (`rig push toon` / `--remote toon`).'
          : '')
    );
    this.name = 'NoOriginConfiguredError';
  }
}

/** A rig command ran outside any git repository. */
export class NotAGitRepositoryError extends Error {
  constructor(cwd: string) {
    super(
      `not a git repository: ${cwd}\n` +
        'rig can create one for you: re-run `rig init --git-init` (in a ' +
        'terminal, plain `rig init` offers the same via a prompt). Or run ' +
        '`git init` yourself first, then re-run.'
    );
    this.name = 'NotAGitRepositoryError';
  }
}

function nonFastForwardLines(refs: RejectedRefUpdate[]): string[] {
  return [
    'Push rejected: non-fast-forward update for:',
    ...refs.map(
      (r) =>
        `  ${r.refname}  remote ${r.remoteSha.slice(0, 7)} is not an ancestor of local ${r.localSha.slice(0, 7)}`
    ),
    'The remote moved since your last push. Re-run with --force to overwrite it',
    'WARNING: --force rewrites the published ref history for every reader of this repo.',
  ];
}

function oversizeLines(objects: OversizeObject[]): string[] {
  return [
    `Push rejected: ${objects.length} object(s) exceed the ${MAX_OBJECT_SIZE}-byte (95KB) upload limit:`,
    ...objects.map(
      (o) => `  ${o.path ?? o.sha}  ${o.type}, ${o.size} bytes`
    ),
    'Objects over 95KB are a hard error in v1 — split or remove the file(s) from history to push.',
    'Large-object support is tracked in toon-client#235.',
  ];
}

/**
 * Normalize any command-path error for rendering. `command` names the rig
 * subcommand for the generic "rig <command> failed" lines.
 */
export function describeError(err: unknown, command = 'push'): DescribedError {
  if (err instanceof UnconfiguredRepoAddressError) {
    return {
      code: 'unconfigured_repo_address',
      lines: err.message.split('\n'),
      json: { error: 'unconfigured_repo_address', detail: err.message },
    };
  }
  if (err instanceof NotAGitRepositoryError) {
    return {
      code: 'not_a_git_repository',
      lines: err.message.split('\n'),
      json: { error: 'not_a_git_repository', detail: err.message },
    };
  }
  if (err instanceof InvalidRelayUrlError) {
    return {
      code: 'invalid_relay_url',
      lines: err.message.split('\n'),
      json: { error: 'invalid_relay_url', detail: err.message, url: err.url },
    };
  }
  if (err instanceof UnknownRemoteError) {
    return {
      code: 'unknown_remote',
      lines: err.message.split('\n'),
      json: { error: 'unknown_remote', detail: err.message, remote: err.remote },
    };
  }
  if (err instanceof MultiUrlRemoteError) {
    return {
      code: 'multi_url_remote',
      lines: err.message.split('\n'),
      json: {
        error: 'multi_url_remote',
        detail: err.message,
        remote: err.remote,
        urls: err.urls,
      },
    };
  }
  if (err instanceof NoOriginConfiguredError) {
    return {
      code: 'no_origin_configured',
      lines: err.message.split('\n'),
      json: { error: 'no_origin_configured', detail: err.message },
    };
  }
  if (err instanceof MissingIdentityError) {
    return {
      code: 'missing_identity',
      lines: err.message.split('\n'),
      json: { error: 'missing_identity', detail: err.message },
    };
  }
  if (err instanceof NonFastForwardError) {
    return {
      code: 'non_fast_forward',
      lines: nonFastForwardLines(err.refs),
      json: { error: 'non_fast_forward', detail: err.message, refs: err.refs },
    };
  }
  if (err instanceof OversizeObjectsError) {
    return {
      code: 'oversize_objects',
      lines: oversizeLines(err.objects),
      json: {
        error: 'oversize_objects',
        detail: err.message,
        objects: err.objects,
      },
    };
  }
  if (err instanceof GitError) {
    return {
      code: 'git_error',
      lines: [`git failed: ${err.message}`],
      json: { error: 'git_error', detail: err.message },
    };
  }

  // Delegated-daemon path (#279): the daemon's /git/* error envelope carries
  // the same structured payloads the local planner throws — render them
  // identically so the two paths are indistinguishable to the user.
  if (err instanceof DaemonRouteError) {
    const envelope = err.envelope;
    if (envelope.error === 'non_fast_forward' && Array.isArray(envelope['refs'])) {
      return {
        code: 'non_fast_forward',
        lines: nonFastForwardLines(envelope['refs'] as RejectedRefUpdate[]),
        json: { ...envelope },
      };
    }
    if (
      envelope.error === 'oversize_objects' &&
      Array.isArray(envelope['objects'])
    ) {
      return {
        code: 'oversize_objects',
        lines: oversizeLines(envelope['objects'] as OversizeObject[]),
        json: { ...envelope },
      };
    }
    const retryHint =
      envelope.retryable === true
        ? ['The daemon reports this as retryable — re-run shortly.']
        : [];
    return {
      code: envelope.error,
      lines: [
        `daemon rejected the operation (HTTP ${err.status}): ` +
          (envelope.detail ?? envelope.error),
        ...retryHint,
      ],
      json: { ...envelope },
    };
  }
  if (err instanceof DaemonUnreachableError) {
    return {
      code: 'daemon_unreachable',
      lines: err.message.split('\n'),
      json: { error: 'daemon_unreachable', detail: err.message },
    };
  }

  // Standalone-path tagged errors (matched by name — the classes live behind
  // the optional dynamic import).
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'DaemonIdentityConflictError') {
    return {
      code: 'daemon_identity_conflict',
      lines: [
        message,
        'Paid writes delegate to a same-identity daemon automatically; ' +
          'seeing this means the daemon appeared mid-run or this operation ' +
          'has no daemon route — stop the daemon and re-run.',
      ],
      json: { error: 'daemon_identity_conflict', detail: message },
    };
  }
  if (name === 'MissingUplinkError') {
    return {
      code: 'missing_uplink',
      lines: [message],
      json: { error: 'missing_uplink', detail: message },
    };
  }
  // Peer→channel map corruption (#262) — matched by name so tsup chunk
  // duplication between the cli and standalone entries can't break instanceof.
  if (name === 'ChannelMapCorruptError') {
    return {
      code: 'channel_map_corrupt',
      lines: [message],
      json: { error: 'channel_map_corrupt', detail: message },
    };
  }
  // Settle attempted before the challenge window elapsed (#263) — the client
  // throws this retryable error BEFORE spending gas; surface when to retry.
  if (name === 'SettleTooEarlyError') {
    const settleableAt = (err as { settleableAt?: unknown }).settleableAt;
    return {
      code: 'settle_too_early',
      lines: [
        message,
        'The settlement challenge window is still open — nothing was spent. ' +
          'Re-run `rig channel settle` after the settleable time.',
      ],
      json: {
        error: 'settle_too_early',
        detail: message,
        ...(typeof settleableAt === 'string' ? { settleableAt } : {}),
      },
    };
  }

  // The #278 read path — matched by name (same tsup chunk-duplication
  // rationale as above; the classes live in clone.ts / object-fetch.ts /
  // materialize.ts).
  if (name === 'RepoNotFoundError') {
    return {
      code: 'repo_not_found',
      lines: message.split('\n'),
      json: { error: 'repo_not_found', detail: message },
    };
  }
  if (name === 'MissingRemoteObjectsError') {
    const missing = (err as { missing?: unknown }).missing;
    return {
      code: 'missing_remote_objects',
      lines: message.split('\n'),
      json: {
        error: 'missing_remote_objects',
        detail: message,
        ...(Array.isArray(missing) ? { missing } : {}),
      },
    };
  }
  if (name === 'ObjectIntegrityError' || name === 'ObjectWriteMismatchError') {
    return {
      code: 'object_integrity',
      lines: message.split('\n'),
      json: { error: 'object_integrity', detail: message },
    };
  }

  return {
    code: 'error',
    lines: [`rig ${command} failed: ${message}`],
    json: { error: 'error', detail: message },
  };
}

/**
 * The one command-error emitter (#265): the machine envelope (tagged with
 * the command name) goes to stdout via `emitJson` when `--json` is active,
 * and the human-facing lines ALWAYS go to stderr — so JSON consumers get the
 * parseable envelope while a human tailing stderr still sees the detail.
 * Returns the exit code (always 1) so callers can `return emitCliError(…)`.
 */
export function emitCliError(
  io: CliIo,
  json: boolean,
  command: string,
  err: unknown
): 1 {
  const described = describeError(err, command);
  if (json) io.emitJson({ command, ...described.json });
  for (const line of described.lines) io.err(line);
  return 1;
}
