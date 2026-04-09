/**
 * Pet Interaction Result Parser (Kind 6900)
 *
 * Decodes base64-encoded JSON from IlpSendResult.data field.
 * Uses browser-safe atob() -- NOT Node.js Buffer -- for ditto React SPA compatibility.
 *
 * @module pet/parsePetInteractionResult
 */

import type { PetInteractionResultData, StatValues } from './types.js';

/** Required stat field names */
const STAT_FIELDS: readonly (keyof StatValues)[] = [
  'hunger',
  'happiness',
  'health',
  'hygiene',
  'energy',
];

/** Regex for validating 64-char hex string (BLAKE3 brain hash) */
const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Validate that an object has all required StatValues fields as numbers.
 */
function isValidStats(obj: unknown): obj is StatValues {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return STAT_FIELDS.every(
    (field) =>
      typeof record[field] === 'number' && Number.isFinite(record[field])
  );
}

/**
 * Parse base64-encoded JSON result data from a Kind 6900 DVM response.
 *
 * Uses atob() for browser compatibility (ditto React SPA).
 * Returns null for malformed/missing data (no throw).
 *
 * Validates:
 * - brainHash is 64-char hex
 * - stats has all 5 fields
 * - cycle >= 0
 * - stage 0-2
 *
 * @param data - Base64-encoded JSON string from IlpSendResult.data
 * @returns Parsed PetInteractionResultData or null if invalid
 */
export function parsePetInteractionResult(
  data: string
): PetInteractionResultData | null {
  if (!data) return null;

  let json: string;
  try {
    // Use atob() for browser compatibility; works in Node 16+ too
    json = atob(data);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Validate stats
  if (!isValidStats(record['stats'])) return null;

  // Validate stage (0-2)
  const stage = record['stage'];
  if (
    typeof stage !== 'number' ||
    !Number.isInteger(stage) ||
    stage < 0 ||
    stage > 2
  ) {
    return null;
  }

  // Validate cycle (>= 0)
  const cycle = record['cycle'];
  if (typeof cycle !== 'number' || !Number.isInteger(cycle) || cycle < 0) {
    return null;
  }

  // Validate lastInteraction
  const lastInteraction = record['lastInteraction'];
  if (
    typeof lastInteraction !== 'number' ||
    !Number.isFinite(lastInteraction)
  ) {
    return null;
  }

  // Validate brainHash (64-char hex)
  const brainHash = record['brainHash'];
  if (typeof brainHash !== 'string' || !HEX_64_RE.test(brainHash)) {
    return null;
  }

  // Validate cooldownTimestamps (array of numbers)
  const cooldownTimestamps = record['cooldownTimestamps'];
  if (!Array.isArray(cooldownTimestamps)) return null;
  if (
    !cooldownTimestamps.every(
      (t): t is number => typeof t === 'number' && Number.isFinite(t)
    )
  ) {
    return null;
  }

  // Construct clean stat object to prevent prototype pollution from JSON.parse
  const validatedStats = record['stats'] as StatValues;
  const stats: StatValues = {
    hunger: validatedStats.hunger,
    happiness: validatedStats.happiness,
    health: validatedStats.health,
    hygiene: validatedStats.hygiene,
    energy: validatedStats.energy,
  };

  return {
    stats,
    stage,
    cycle,
    lastInteraction,
    brainHash,
    cooldownTimestamps: [...cooldownTimestamps],
  };
}
