/**
 * Human-facing rendering for `rig push`: the pre-push confirm table and the
 * post-push receipts. Machine consumers use `--json` instead (the raw wire
 * shapes from ../routes.ts) — nothing here is meant to be parsed.
 */

import type {
  GitEstimateResponse,
  GitPushResponse,
  GitRefUpdate,
} from '../routes.js';

/** Group thousands for readability: 1234567 → '1,234,567'. */
export function formatNumber(value: number | string | bigint): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '(none)';
}

function refLine(update: GitRefUpdate): string {
  const arrow = `${shortSha(update.remoteSha)} → ${shortSha(update.localSha)}`;
  return `  ${update.refname}  ${arrow}  (${update.kind})`;
}

/** The pre-push confirm table (refs, objects, itemized fees, warning). */
export function renderPlan(plan: GitEstimateResponse, mode: string): string[] {
  const lines: string[] = [];
  lines.push(
    `Push plan for repo "${plan.repoId}" (${mode} mode)` +
      (plan.announceNeeded ? ' — first push, will announce (kind:30617)' : '')
  );
  lines.push('Refs:');
  for (const update of plan.refUpdates) lines.push(refLine(update));

  const est = plan.estimate;
  const skipped = Object.keys(plan.knownShaToTxId).length;
  lines.push(
    `Objects: ${est.objectCount} to upload` +
      ` (${formatNumber(est.totalObjectBytes)} bytes)` +
      (skipped > 0 ? `; ${skipped} already on Arweave (free)` : '')
  );
  lines.push('Fees (base units):');
  lines.push(
    `  upload   ${est.objectCount} object(s), ${formatNumber(est.totalObjectBytes)} bytes` +
      `   ${formatNumber(est.uploadFee)}`
  );
  lines.push(`  events   ${est.eventCount} event(s)   ${formatNumber(est.eventFees)}`);
  lines.push(`  total    ${formatNumber(est.totalFee)}`);
  lines.push('Writes are permanent and non-refundable.');
  return lines;
}

/** Post-push receipts: per-object skipped/paid, event ids, paid-vs-estimate. */
export function renderResult(result: GitPushResponse): string[] {
  const lines: string[] = [];
  lines.push(`Pushed "${result.repoId}":`);
  const paid = result.uploads.filter((u) => !u.skipped);
  const skipped = result.uploads.filter((u) => u.skipped);
  for (const upload of result.uploads) {
    lines.push(
      `  object ${upload.sha.slice(0, 12)}  ${upload.skipped ? 'skipped (already stored)' : `paid ${formatNumber(upload.feePaid)}`}` +
        `  ar:${upload.txId}`
    );
  }
  lines.push(
    `Uploads: ${paid.length} paid, ${skipped.length} skipped (content-addressed).`
  );
  if (result.announceReceipt) {
    lines.push(
      `Announcement (kind:30617): ${result.announceReceipt.eventId}` +
        `  paid ${formatNumber(result.announceReceipt.feePaid)}`
    );
  }
  lines.push(
    `Refs event (kind:30618): ${result.refsReceipt.eventId}` +
      `  paid ${formatNumber(result.refsReceipt.feePaid)}`
  );
  lines.push(
    `Total paid: ${formatNumber(result.totalFeePaid)} base units` +
      ` (estimate was ${formatNumber(result.estimate.totalFee)})`
  );
  return lines;
}
