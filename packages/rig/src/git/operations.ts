/**
 * Git operations for @toon-protocol/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * All git operations use execFile (never exec) to prevent command injection.
 */

export interface ExecFileOptions {
  execFile: (...args: unknown[]) => unknown;
}

export interface PatchValidationResult {
  valid: boolean;
  error?: string;
}

export interface ApplyPatchResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Initializes a bare git repository.
 */
export async function initBareRepo(
  _repoDir: string,
  _repoName: string,
  _options: ExecFileOptions
): Promise<void> {
  throw new Error('initBareRepo is not yet implemented');
}

/**
 * Applies a patch to a git repository.
 */
export async function applyPatch(
  _repoPath: string,
  _patchContent: string,
  _options: ExecFileOptions
): Promise<ApplyPatchResult> {
  throw new Error('applyPatch is not yet implemented');
}

/**
 * Validates a repository name for safety.
 */
export function validateRepoName(_name: string): void {
  throw new Error('validateRepoName is not yet implemented');
}

/**
 * Validates patch content for safety.
 */
export function validatePatchContent(_content: string): PatchValidationResult {
  throw new Error('validatePatchContent is not yet implemented');
}

/**
 * Validates patch file paths for traversal attacks.
 */
export function validatePatchPaths(
  _patchContent: string
): PatchValidationResult {
  throw new Error('validatePatchPaths is not yet implemented');
}

/**
 * Serves git-upload-pack requests (read-only).
 */
export async function serveUploadPack(
  _request: unknown,
  _response: unknown
): Promise<void> {
  throw new Error('serveUploadPack is not yet implemented');
}

/**
 * Detects whether a request is a git-receive-pack (push) request.
 */
export function isReceivePackRequest(_request: unknown): boolean {
  throw new Error('isReceivePackRequest is not yet implemented');
}
