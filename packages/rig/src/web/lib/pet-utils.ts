/**
 * Pet display utilities for the Proof Status UI.
 *
 * Pure functions mapping numeric action/stage codes to human-readable names
 * and formatting brain hashes for display.
 *
 * @module lib/pet-utils
 */

const ACTION_NAMES: Record<number, string> = {
  0: 'Feed',
  1: 'Play',
  2: 'Clean',
  3: 'Rest',
  4: 'Warm',
  5: 'Check',
  6: 'Sing',
  7: 'Talk',
  8: 'Medicine',
  9: 'Cruzar',
  10: 'PlayMusic',
};

const STAGE_NAMES: Record<number, string> = {
  0: 'Egg',
  1: 'Baby',
  2: 'Adult',
};

/**
 * Maps a numeric actionType (0–10) to a human-readable name.
 * Returns 'Unknown' for out-of-range values.
 */
export function getActionName(actionType: number): string {
  return ACTION_NAMES[actionType] ?? 'Unknown';
}

/**
 * Maps a numeric stage (0–2) to a human-readable name.
 * Returns 'Unknown' for out-of-range values.
 */
export function getStageName(stage: number): string {
  return STAGE_NAMES[stage] ?? 'Unknown';
}

/**
 * Truncates a brain hash to `first8...last4` format for display.
 * Returns '...' if the hash is shorter than 12 characters.
 */
export function truncateBrainHash(hash: string): string {
  if (hash.length < 12) return '...';
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
}
