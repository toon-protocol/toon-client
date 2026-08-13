/**
 * Operator notices (issue #544, part of toon-meta#252): a kind:10032
 * announce's optional `notice` field (toon#183) is client-mcp's channel to
 * surface an operator notice through `toon_status`.
 *
 * Trust rule: mirrors toon-protocol/rig#78 (the sibling ticket for rig).
 * Anyone can publish a kind:10032, so a notice — and its operator-controlled
 * `url` — is only honoured when it comes from an announcer whose pubkey is a
 * committed genesis-seed pubkey (`GenesisPeerLoader.loadGenesisPeers()` in
 * `@toon-protocol/core`, wired in by the caller). An unbounded "surface
 * whatever any announce says" is a phishing surface pointed at the user.
 *
 * Lenient parsing mirrors core's own contract for the field (toon#183): a
 * malformed notice is dropped, never fatal; an unrecognized `severity`
 * degrades to `'info'` rather than being rejected; unknown keys are ignored.
 */

export interface OperatorNotice {
  id: string;
  severity: 'info' | 'action-required';
  summary: string;
  url: string;
}

/**
 * Validate + normalize a raw `notice` value read off an announce's content.
 * Returns `undefined` for anything malformed, rather than throwing — an
 * operator's typo in a notice must never cost this daemon its ability to
 * report status.
 */
export function normalizeNotice(value: unknown): OperatorNotice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, severity, summary, url } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof summary !== 'string' || summary.length === 0) return undefined;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return {
    id,
    summary,
    url,
    severity: severity === 'action-required' ? 'action-required' : 'info',
  };
}

/**
 * The notice to trust from an announce, or `undefined`. Trust is checked
 * BEFORE normalization: an announce from a pubkey outside `trustedPubkeys`
 * never has its `rawNotice` inspected, regardless of what it contains.
 */
export function trustedNoticeFrom(
  pubkey: string,
  rawNotice: unknown,
  trustedPubkeys: readonly string[]
): OperatorNotice | undefined {
  if (!trustedPubkeys.includes(pubkey)) return undefined;
  return normalizeNotice(rawNotice);
}
