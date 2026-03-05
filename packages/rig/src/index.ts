/**
 * @crosstown/rig
 *
 * Git forge rig for Crosstown - NIP-34 based code collaboration.
 * Stub: Will be implemented as part of the rig epic.
 */

export interface RigConfig {
  mnemonic: string;
  relayUrl: string;
  httpPort?: number;
  repoDir?: string;
}

/**
 * Starts the rig server.
 * Stub implementation -- will be filled in when the rig is implemented.
 */
export async function startRig(_config: RigConfig): Promise<void> {
  throw new Error('startRig is not yet implemented');
}
