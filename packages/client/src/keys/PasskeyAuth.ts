import type {
  PasskeyAssertionResult,
  PasskeyRegistrationResult,
} from './types.js';

/**
 * WebAuthn Passkey authentication with PRF extension for key encryption.
 *
 * Handles credential registration (create) and assertion (get) with the
 * prf extension to derive a deterministic secret from the authenticator.
 * When PRF is unavailable, callers should fall back to password-based KEK.
 */

/**
 * Register a new Passkey credential with PRF extension.
 *
 * @param rpId - Relying party identifier (e.g., "example.com")
 * @param rpName - Human-readable relying party name
 * @param userId - Raw user ID bytes (Nostr pubkey, 32 bytes)
 * @param userName - Display name for the credential
 * @param prfSalt - Random salt for the PRF evaluation
 * @returns Registration result with PRF output and credential ID
 */
export async function registerPasskey(params: {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  prfSalt: Uint8Array;
}): Promise<PasskeyRegistrationResult> {
  const { rpId, rpName, userId, userName, prfSalt } = params;

  const publicKeyOptions: PublicKeyCredentialCreationOptions = {
    rp: { id: rpId, name: rpName },
    user: {
      id: userId as unknown as BufferSource,
      name: userName,
      displayName: userName,
    },
    challenge: crypto.getRandomValues(new Uint8Array(32)) as unknown as BufferSource,
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    extensions: {
      prf: {
        eval: {
          first: prfSalt as unknown as BufferSource,
        },
      },
    } as AuthenticationExtensionsClientInputs,
  };

  const credential = (await navigator.credentials.create({
    publicKey: publicKeyOptions,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error('Passkey registration was cancelled or failed');
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const extensionResults = credential.getClientExtensionResults();

  const prfResults = (extensionResults as Record<string, unknown>)['prf'] as
    | { enabled?: boolean; results?: { first: ArrayBuffer } }
    | undefined;

  if (!prfResults?.results?.first) {
    throw new Error(
      'PRF extension not supported by this authenticator. ' +
        'Passkey was created but cannot be used for key encryption. ' +
        'Use password-based encryption as fallback.'
    );
  }

  const credentialId = new Uint8Array(credential.rawId);

  // Verify attestation response is valid
  if (!response.attestationObject) {
    throw new Error('Invalid attestation response');
  }

  return {
    prfOutput: prfResults.results.first,
    credentialId,
  };
}

/**
 * Assert an existing Passkey credential with PRF extension.
 *
 * @param rpId - Relying party identifier
 * @param prfSalt - The same salt used during registration for this credential
 * @param allowCredentials - Optional list of credential IDs to filter
 * @returns Assertion result with PRF output, credential ID, and userHandle
 */
export async function assertPasskey(params: {
  rpId: string;
  prfSalt: Uint8Array;
  allowCredentials?: Uint8Array[];
}): Promise<PasskeyAssertionResult> {
  const { rpId, prfSalt, allowCredentials } = params;

  const publicKeyOptions = {
    rpId,
    challenge: crypto.getRandomValues(new Uint8Array(32)) as unknown as BufferSource,
    userVerification: 'required' as const,
    ...(allowCredentials && {
      allowCredentials: allowCredentials.map((id) => ({
        id: id as unknown as BufferSource,
        type: 'public-key' as const,
      })),
    }),
    extensions: {
      prf: {
        eval: {
          first: prfSalt as unknown as BufferSource,
        },
      },
    } as AuthenticationExtensionsClientInputs,
  } as PublicKeyCredentialRequestOptions;

  const credential = (await navigator.credentials.get({
    publicKey: publicKeyOptions,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error('Passkey assertion was cancelled or failed');
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  const extensionResults = credential.getClientExtensionResults();

  const prfResults = (extensionResults as Record<string, unknown>)['prf'] as
    | { results?: { first: ArrayBuffer } }
    | undefined;

  if (!prfResults?.results?.first) {
    throw new Error(
      'PRF extension did not return a result. ' +
        'The authenticator may not support PRF.'
    );
  }

  return {
    prfOutput: prfResults.results.first,
    credentialId: new Uint8Array(credential.rawId),
    userHandle: response.userHandle
      ? new Uint8Array(response.userHandle)
      : null,
  };
}

/**
 * Check whether the current browser supports WebAuthn with PRF extension.
 * Returns false in Node.js or browsers without PublicKeyCredential.
 */
export function isPrfSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  if (!navigator.credentials) return false;
  if (typeof PublicKeyCredential === 'undefined') return false;
  // PRF support cannot be feature-detected without actually creating a credential,
  // so we return true if WebAuthn is available and let registration handle the error.
  return true;
}

/**
 * Compute SHA-256 hash of a credential ID for use as a lookup key.
 */
export async function hashCredentialId(
  credentialId: Uint8Array
): Promise<string> {
  const arrayBuffer = credentialId.buffer.slice(credentialId.byteOffset, credentialId.byteOffset + credentialId.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
