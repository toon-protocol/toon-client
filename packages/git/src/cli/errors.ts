/**
 * Error UX for `rig push`: map structured planner/daemon errors to actionable
 * terminal output (and a machine-readable envelope for `--json`).
 *
 * The daemon and standalone paths surface the SAME failures in different
 * clothing — HTTP envelopes (409 `non_fast_forward`, 413 `oversize_objects`,
 * 503 `bootstrapping`, 402 `insufficient_gas`) vs. thrown planner errors
 * (`NonFastForwardError`, `OversizeObjectsError`) — so both are normalized
 * here to one rendering per failure class.
 */

import { MAX_OBJECT_SIZE } from '../objects.js';
import {
  NonFastForwardError,
  OversizeObjectsError,
  type OversizeObject,
  type RejectedRefUpdate,
} from '../push.js';
import { GitError } from '../repo-reader.js';
import { DaemonRouteError, DaemonUnreachableError } from './daemon.js';
import { NoPublisherError } from './mode.js';

/** Normalized error description: terminal lines + `--json` envelope. */
export interface DescribedError {
  /** Stable machine code (mirrors the daemon envelope's `error` field). */
  code: string;
  /** Human-facing lines (message first, remediation after). */
  lines: string[];
  /** Machine envelope for `--json` output (structured payload included). */
  json: Record<string, unknown>;
}

const FUNDING_REMEDIATION = [
  'Remediation:',
  '  • fund the settlement wallet: run the toon_fund_wallet MCP tool (devnet faucet), or send gas/tokens to the wallet yourself',
  '  • open (or top up) a payment channel: toon_open_channel / toon_channel_deposit',
  '  • then re-run rig push',
];

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

function fromDaemonEnvelope(err: DaemonRouteError): DescribedError {
  const { envelope, status } = err;
  const json: Record<string, unknown> = { ...envelope, status };
  switch (envelope.error) {
    case 'non_fast_forward': {
      const refs = Array.isArray(envelope['refs'])
        ? (envelope['refs'] as RejectedRefUpdate[])
        : [];
      return { code: 'non_fast_forward', lines: nonFastForwardLines(refs), json };
    }
    case 'oversize_objects': {
      const objects = Array.isArray(envelope['objects'])
        ? (envelope['objects'] as OversizeObject[])
        : [];
      return { code: 'oversize_objects', lines: oversizeLines(objects), json };
    }
    case 'bootstrapping':
      return {
        code: 'bootstrapping',
        lines: [
          `toon-clientd is still bootstrapping: ${envelope.detail ?? 'transport/channel coming up'}`,
          'Retry in a few seconds. If it never becomes ready, check the toon-clientd logs.',
        ],
        json,
      };
    case 'insufficient_gas':
      return {
        code: 'insufficient_gas',
        lines: [
          `Payment failed: ${envelope.detail ?? 'the settlement wallet cannot fund the channel'}`,
          ...FUNDING_REMEDIATION,
        ],
        json,
      };
    default:
      return {
        code: envelope.error,
        lines: [
          `Push failed (${envelope.error}, HTTP ${status})` +
            (envelope.detail ? `: ${envelope.detail}` : ''),
          ...(envelope.retryable ? ['This error is retryable — try again shortly.'] : []),
        ],
        json,
      };
  }
}

/** Normalize any push-path error for rendering. */
export function describeError(err: unknown): DescribedError {
  if (err instanceof DaemonRouteError) return fromDaemonEnvelope(err);

  if (err instanceof DaemonUnreachableError) {
    return {
      code: 'daemon_unreachable',
      lines: [err.message],
      json: { error: 'daemon_unreachable', detail: err.message },
    };
  }
  if (err instanceof NoPublisherError) {
    return {
      code: 'no_publisher',
      lines: err.message.split('\n'),
      json: { error: 'no_publisher', detail: err.message },
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

  // Standalone-path tagged errors (matched by name — the classes live behind
  // the optional dynamic import).
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'DaemonIdentityConflictError') {
    return {
      code: 'daemon_identity_conflict',
      lines: [message, 'Re-run without --standalone (or with --daemon) to push through the running daemon.'],
      json: { error: 'daemon_identity_conflict', detail: message },
    };
  }
  if (name === 'MissingMnemonicError' || name === 'MissingUplinkError') {
    return {
      code: name === 'MissingMnemonicError' ? 'missing_mnemonic' : 'missing_uplink',
      lines: [message],
      json: { error: 'standalone_unavailable', detail: message },
    };
  }

  return {
    code: 'error',
    lines: [`rig push failed: ${message}`],
    json: { error: 'error', detail: message },
  };
}
