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
  StatValues,
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
 * Check that an object has the expected stat fields as numbers.
 */
function isStatLike(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r['hunger'] === 'number' &&
    Number.isFinite(r['hunger']) &&
    typeof r['happiness'] === 'number' &&
    Number.isFinite(r['happiness']) &&
    typeof r['health'] === 'number' &&
    Number.isFinite(r['health']) &&
    typeof r['hygiene'] === 'number' &&
    Number.isFinite(r['hygiene']) &&
    typeof r['energy'] === 'number' &&
    Number.isFinite(r['energy'])
  );
}

/**
 * Construct a clean StatValues object from a validated stat-like object.
 * Prevents prototype pollution by extracting only known fields.
 */
function cleanStats(obj: Record<string, unknown>): StatValues {
  return {
    hunger: obj['hunger'] as number,
    happiness: obj['happiness'] as number,
    health: obj['health'] as number,
    hygiene: obj['hygiene'] as number,
    energy: obj['energy'] as number,
  };
}

/**
 * Attempt to parse content JSON into InteractionResultContent.
 * Returns null if content is malformed.
 */
function parseContent(content: string): InteractionResultContent | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Structural check -- must have stat objects with correct numeric fields
    if (
      !isStatLike(parsed.priorStats) ||
      !isStatLike(parsed.decayedStats) ||
      !isStatLike(parsed.finalStats)
    ) {
      return null;
    }
    if (
      typeof parsed.cycle !== 'number' ||
      typeof parsed.stage !== 'number' ||
      typeof parsed.tokenCost !== 'number'
    ) {
      return null;
    }
    // Construct clean object to prevent prototype pollution from JSON.parse
    return {
      priorStats: cleanStats(parsed.priorStats),
      decayedStats: cleanStats(parsed.decayedStats),
      finalStats: cleanStats(parsed.finalStats),
      cycle: parsed.cycle,
      stage: parsed.stage,
      tokenCost: parsed.tokenCost,
    };
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
