/**
 * Pet Interaction Event Parser (Kind 14919)
 *
 * Parses Kind 14919 optimistic/proven pet interaction events.
 * Detects proof status from presence of 'proof' + 'mina_tx' tags.
 *
 * @module pet/parsePetInteractionEvent
 */

import type {
  PetInteractionEventData,
  InteractionResultContent,
  ProofStatus,
} from './types.js';

/**
 * Minimal Nostr event shape needed for parsing.
 */
interface NostrEventLike {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  id: string;
  sig: string;
  created_at: number;
}

/**
 * Extract the first value for a given tag name from a tags array.
 */
function getTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) {
      return tag[1];
    }
  }
  return undefined;
}

/**
 * Attempt to parse content JSON into InteractionResultContent.
 * Returns null if content is malformed.
 */
function parseContent(content: string): InteractionResultContent | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Basic structural check -- must have priorStats, decayedStats, finalStats
    if (!parsed.priorStats || !parsed.decayedStats || !parsed.finalStats) return null;
    return parsed as InteractionResultContent;
  } catch {
    return null;
  }
}

/**
 * Parse a Kind 14919 pet interaction event.
 *
 * Extracts all tag values and detects proof status:
 * - 'optimistic': no 'proof' tag
 * - 'proven': has 'proof' + 'mina_tx' tags
 *
 * Returns null if required tags are missing.
 *
 * @param event - A Nostr event (Kind 14919)
 * @returns Parsed PetInteractionEventData or null if malformed
 */
export function parsePetInteractionEvent(
  event: NostrEventLike
): PetInteractionEventData | null {
  const tags = event.tags;

  // Extract required tags
  const blobbiId = getTagValue(tags, 'd');
  if (!blobbiId) return null;

  const actionStr = getTagValue(tags, 'action');
  if (!actionStr) return null;
  const actionType = Number(actionStr);
  if (!Number.isFinite(actionType)) return null;

  const itemStr = getTagValue(tags, 'item');
  if (!itemStr) return null;
  const itemId = Number(itemStr);
  if (!Number.isFinite(itemId)) return null;

  const costStr = getTagValue(tags, 'cost');
  if (!costStr) return null;
  const tokenCost = Number(costStr);
  if (!Number.isFinite(tokenCost)) return null;

  const cycleStr = getTagValue(tags, 'cycle');
  if (!cycleStr) return null;
  const cycle = Number(cycleStr);
  if (!Number.isFinite(cycle)) return null;

  const stageStr = getTagValue(tags, 'stage');
  if (!stageStr) return null;
  const stage = Number(stageStr);
  if (!Number.isFinite(stage)) return null;

  const brainHash = getTagValue(tags, 'brain_hash');
  if (!brainHash) return null;

  // Detect proof status
  const proof = getTagValue(tags, 'proof');
  const minaTx = getTagValue(tags, 'mina_tx');
  const proofStatus: ProofStatus = proof && minaTx ? 'proven' : 'optimistic';

  // Parse content
  const content = parseContent(event.content);

  const result: PetInteractionEventData = {
    blobbiId,
    actionType,
    itemId,
    tokenCost,
    cycle,
    stage,
    brainHash,
    proofStatus,
    content,
  };

  if (proof) result.proof = proof;
  if (minaTx) result.minaTx = minaTx;

  return result;
}
