/**
 * `toon init [--import] [--legacy-derivation]` — create or import a keystore.
 *
 * The first command a new user runs, and the only one that writes a secret. Two
 * refusals here are deliberate:
 *
 * - **It never overwrites an existing keystore.** The file it would replace may
 *   be the only copy of a phrase holding an open channel's collateral, and there
 *   is no undo for that.
 * - **A phrase is only ever read from stdin.** Not from an argument, which shell
 *   history records and `ps` shows to every user on the machine.
 *
 * `--legacy-derivation` records that this phrase's EVM key lives at Nostr's coin
 * type — what to use when importing a phrase whose channels were opened before
 * 1.0, so the addresses come back where the money is.
 */
import { boolOption } from '../args.js';
import { CliConfigError } from '../args.js';
import type { CommandContext } from '../context.js';
import {
  ensureKeystoreDirectory,
  keystoreExists,
  resolvePassword,
} from '../keystore.js';
import { deriveFullIdentity, evmDerivationPath } from '../../keys/KeyDerivation.js';
import { generateKeystore, importKeystore } from '../../keys/keystore-node.js';

export async function run(ctx: CommandContext): Promise<number> {
  const path = ctx.settings.keystorePath;
  const derivation = boolOption(ctx.values, 'legacy-derivation') ? 'legacy' : 'standard';
  const importing = boolOption(ctx.values, 'import');

  if (keystoreExists(path)) {
    throw new CliConfigError(
      `a keystore already exists at ${path}`,
      'Move it aside first — overwriting it would destroy the only copy of its phrase, ' +
        'and any channel collateral that phrase controls.'
    );
  }

  // The phrase is read before the password so that a piped run consumes stdin
  // in a predictable order.
  let imported: string | undefined;
  if (importing) {
    const readStdin = ctx.deps.readStdin;
    if (readStdin === undefined) {
      throw new CliConfigError('--import reads the phrase from stdin, and stdin is unavailable');
    }
    ctx.out.warn('Reading the BIP-39 recovery phrase from stdin.');
    const bytes = await readStdin();
    imported = Buffer.from(bytes).toString('utf8').trim();
    if (imported.length === 0) throw new CliConfigError('no phrase arrived on stdin');
  }

  const { password, source } = await resolvePassword({
    message: `Choose a password for ${path}: `,
    passwordFile: ctx.settings.passwordFile,
    env: ctx.deps.env,
    ...(ctx.deps.readFile !== undefined ? { readFile: ctx.deps.readFile } : {}),
    prompt: ctx.deps.prompt,
  });
  // A typo in a password chosen at a prompt is unrecoverable — nothing else
  // knows what was meant — so it is asked for twice. A password supplied by file
  // or environment can be re-read, so it is not.
  if (source === 'prompt' && ctx.deps.prompt !== undefined) {
    const again = await ctx.deps.prompt('Confirm the password: ');
    if (again !== password) throw new CliConfigError('the two passwords did not match');
  }

  ensureKeystoreDirectory(path);

  let mnemonic: string;
  let generated: boolean;
  if (imported !== undefined) {
    try {
      importKeystore(path, imported, password, { derivation });
    } catch (err) {
      throw new CliConfigError(err instanceof Error ? err.message : String(err));
    }
    mnemonic = imported;
    generated = false;
  } else {
    mnemonic = generateKeystore(path, password, { derivation }).mnemonic;
    generated = true;
  }

  const identity = deriveFullIdentity(mnemonic, { scheme: derivation });

  ctx.out.render(
    {
      keystore: path,
      derivation,
      evmAddress: identity.evm.address,
      evmPath: evmDerivationPath(derivation),
      solanaPublicKey: identity.solana.publicKey,
      // Only ever present for a phrase this command just invented: there is one
      // chance to copy it down, and after that only the keystore has it.
      ...(generated ? { mnemonic } : {}),
    },
    () => {
      if (generated) {
        ctx.out.line('Write this recovery phrase down. It is shown once, and it is the only');
        ctx.out.line('way back to these addresses if the keystore file is lost.');
        ctx.out.line();
        ctx.out.line(`  ${mnemonic}`);
        ctx.out.line();
      }
      ctx.out.rows([
        ['keystore', path],
        ['derivation', derivation],
        ['evm', `${identity.evm.address}  ${evmDerivationPath(derivation)}`],
        ['solana', identity.solana.publicKey],
      ]);
      ctx.out.line();
      ctx.out.line('Next: fund it, then open a channel.');
      ctx.out.line('  toon faucet');
      ctx.out.line('  toon channel open --deposit 100000');
    }
  );

  return 0;
}
