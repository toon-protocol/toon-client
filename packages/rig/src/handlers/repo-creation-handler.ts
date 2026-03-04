/**
 * Repository creation handler for @crosstown/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Handles kind:30617 repository announcement events and verifies
 * git availability at startup.
 */

export interface GitVerifyOptions {
  execFile: (...args: unknown[]) => unknown;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface GitVerifyResult {
  available: boolean;
  version?: string;
}

export interface RepoCreationHandlerConfig {
  repoDir: string;
}

/**
 * Verifies that git is available on the system.
 */
export async function verifyGitAvailable(
  _options: GitVerifyOptions
): Promise<GitVerifyResult> {
  throw new Error('verifyGitAvailable is not yet implemented');
}

/**
 * Creates a repository creation handler.
 */
export function createRepoCreationHandler(
  _config: RepoCreationHandlerConfig
): (ctx: unknown) => Promise<void> {
  throw new Error('createRepoCreationHandler is not yet implemented');
}
