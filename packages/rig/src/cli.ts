/**
 * CLI flag parser for @toon-protocol/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 */

export interface CliConfig {
  mnemonic: string;
  relayUrl: string;
  httpPort?: number;
  repoDir?: string;
}

/**
 * Parses CLI flags into a CliConfig object.
 * Stub implementation -- will be filled in when the rig is implemented.
 */
export function parseCliFlags(_args: string[]): CliConfig {
  throw new Error('parseCliFlags is not yet implemented');
}
