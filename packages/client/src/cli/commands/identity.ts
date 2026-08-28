/**
 * `toon identity [--all-derivations]` — the addresses this keystore holds.
 *
 * Entirely offline: no connector, no chain, no channel. The addresses are a
 * property of the phrase and the derivation path, so answering needs nothing but
 * the keystore — which is exactly when you want an answer, since the usual
 * reason to run this is that something else could not reach the network.
 *
 * `--all-derivations` exists for one specific, confusing morning: a channel
 * opened before 1.0 appears to have vanished, because the EVM key moved from
 * Nostr's coin type to BIP-44's standard `m/44'/60'/0'/0/i`. The old address is
 * still derivable from the same phrase, and this is how you see it. (The Solana
 * key never moved, so it is the same under both.)
 */
import { boolOption } from '../args.js';
import { resolveKeyMaterial, type CommandContext } from '../context.js';
import {
  deriveFullIdentity,
  evmDerivationPath,
  type KeyDerivationScheme,
} from '../../keys/KeyDerivation.js';
import { MNEMONIC_ENV } from '../keystore.js';

/** SLIP-0010 path for the Solana key. The same under either scheme. */
const SOLANA_PATH = "m/44'/501'/0'/0'";

export async function run(ctx: CommandContext): Promise<number> {
  const keys = await resolveKeyMaterial(ctx.settings, ctx.deps);
  if (keys.kind !== 'mnemonic') {
    // `resolveKeyMaterial` only returns `ephemeral` when asked to, and identity
    // never asks: showing a randomly generated address would be a lie.
    throw new Error('identity requires real keys');
  }

  const showAll = boolOption(ctx.values, 'all-derivations');
  const identity = deriveFullIdentity(keys.mnemonic, { scheme: keys.derivation });
  const source = keys.from === 'env' ? MNEMONIC_ENV : ctx.settings.keystorePath;

  const derivations: { scheme: KeyDerivationScheme; path: string; evmAddress: string }[] = (
    ['standard', 'legacy'] as const
  ).map((scheme) => ({
    scheme,
    path: evmDerivationPath(scheme),
    evmAddress: deriveFullIdentity(keys.mnemonic, { scheme }).evm.address,
  }));

  ctx.out.render(
    {
      source,
      derivation: keys.derivation,
      evmAddress: identity.evm.address,
      evmPath: evmDerivationPath(keys.derivation),
      solanaPublicKey: identity.solana.publicKey,
      solanaPath: SOLANA_PATH,
      ...(showAll ? { derivations } : {}),
    },
    () => {
      ctx.out.rows([
        ['evm', `${identity.evm.address}  ${evmDerivationPath(keys.derivation)}`],
        ['solana', `${identity.solana.publicKey}  ${SOLANA_PATH}`],
        ['derivation', keys.derivation],
        ['keys from', source],
      ]);
      if (showAll) {
        ctx.out.line();
        ctx.out.line('EVM address under each derivation:');
        ctx.out.rows(
          derivations.map((d): [string, string] => [
            d.scheme === keys.derivation ? `${d.scheme} (in use)` : d.scheme,
            `${d.evmAddress}  ${d.path}`,
          ])
        );
      }
    }
  );

  return 0;
}
