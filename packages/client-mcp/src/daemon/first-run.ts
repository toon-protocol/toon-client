/**
 * First-run onboarding for `toon-clientd`.
 *
 * A brand-new user (`npx`/plugin install) has no identity and no config file.
 * Before the daemon resolves its config it calls {@link scaffoldFirstRun},
 * which makes a fresh install start with zero manual setup:
 *
 *   1. **Identity** — if no mnemonic source is configured (no
 *      `TOON_CLIENT_MNEMONIC`, no `keystorePath`, no `mnemonic`), generate a
 *      fresh BIP-39 mnemonic, encrypt it to `~/.toon-client/keystore.json`, and
 *      record `keystorePath` (+ `keystoreAutoPassword`) in `config.json`. The
 *      keystore is encrypted with `TOON_CLIENT_KEYSTORE_PASSWORD` when set, else
 *      a default password so the identity survives restarts with no env var.
 *      The mnemonic + derived addresses are printed ONCE for backup.
 *   2. **Transport scaffolding** — ensure `config.json` carries the transport
 *      knobs (`btpUrl`/`relayUrl`) plus a `_help` block documenting them, so the
 *      user can see what to point at.
 *
 * This is all idempotent: on later runs an identity already exists, so nothing
 * is regenerated and the config is left untouched.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveFullIdentity, generateKeystore } from '@toon-protocol/client';
import {
  configDir,
  defaultConfigPath,
  readConfigFile,
  DEFAULT_KEYSTORE_PASSWORD,
  type DaemonConfigFile,
} from './config.js';

/** Default keystore path: `~/.toon-client/keystore.json`. */
export function defaultKeystorePath(): string {
  return join(configDir(), 'keystore.json');
}

/**
 * True when SOME mnemonic source is already configured: the env var, a keystore
 * path, or an inline mnemonic. When false the daemon would otherwise hard-fail
 * with "No mnemonic configured".
 */
export function hasConfiguredIdentity(file: DaemonConfigFile): boolean {
  return Boolean(
    process.env['TOON_CLIENT_MNEMONIC']?.trim() ||
    file.keystorePath ||
    file.mnemonic
  );
}

/** The `_help` block written into a scaffolded config to document transport. */
const CONFIG_HELP = {
  transport:
    'Configure ONE uplink for paid writes: either `proxyUrl` (connector ' +
    'payment-proxy over ILP-over-HTTP, e.g. https://proxy.devnet.toonprotocol.dev) ' +
    'OR `btpUrl` (BTP WebSocket, e.g. ws://<host>:3000/btp). Reads are always ' +
    'free over relayUrl.',
  proxyUrl:
    'Connector-proxy base URL (deployed devnet/testnet edge). When set, paid ' +
    'writes route through `POST /ilp` and no BTP socket is needed. Set ' +
    '`destination` to the apex ILP address (e.g. g.proxy for devnet).',
  faucetUrl:
    'Devnet faucet base URL (e.g. https://faucet.devnet.toonprotocol.dev) used ' +
    'to drip test funds before publishing.',
  btpUrl:
    'BTP WebSocket URL of the apex/connector for paid writes. Optional when ' +
    '`proxyUrl` is set.',
  relayUrl:
    'Relay WebSocket URL for FREE reads. Default ws://localhost:7100.',
  destination:
    'Default ILP publish destination (apex address). Default g.proxy.',
  keystorePath:
    'Auto-generated encrypted identity. Do not hand-edit; back up your seed phrase.',
};

interface ScaffoldOptions {
  /** Config file path (defaults to `TOON_CLIENT_CONFIG` / `~/.toon-client/config.json`). */
  configPath?: string;
  /** Log sink (defaults to stderr, since stdout may carry MCP/JSON). */
  log?: (msg: string) => void;
}

/**
 * Generate + persist an identity and/or scaffold transport config on first run.
 * Safe to call on every startup — it only acts when something is missing.
 */
export async function scaffoldFirstRun(
  opts: ScaffoldOptions = {}
): Promise<void> {
  const log = opts.log ?? ((m: string): void => console.error(m));
  const configPath =
    opts.configPath ?? process.env['TOON_CLIENT_CONFIG'] ?? defaultConfigPath();

  // Ensure the config directory exists before writing the keystore/config.
  mkdirSync(dirname(configPath), { recursive: true });

  const file = readConfigFile(configPath);
  let updated: DaemonConfigFile = { ...file };
  let changed = false;

  // --- 1. Identity ----------------------------------------------------------
  if (!hasConfiguredIdentity(file)) {
    const keystorePath = defaultKeystorePath();
    const envPassword = process.env['TOON_CLIENT_KEYSTORE_PASSWORD'];
    const password = envPassword ?? DEFAULT_KEYSTORE_PASSWORD;

    // Reuse an existing keystore file if one is already on disk (e.g. config
    // was deleted but the keystore survived); otherwise mint a new mnemonic.
    let mnemonic: string;
    if (existsSync(keystorePath)) {
      // Leave the existing keystore untouched; just relink it in config.
      mnemonic = '';
      log(
        `[toon-clientd] first run: relinking existing keystore at ${keystorePath}`
      );
    } else {
      const generated = generateKeystore(keystorePath, password);
      mnemonic = generated.mnemonic;
    }

    updated = {
      ...updated,
      keystorePath,
      // Only flag auto-password when WE chose it, so a user-imported keystore
      // (custom password) still requires the env var.
      ...(envPassword ? {} : { keystoreAutoPassword: true }),
    };
    changed = true;

    if (mnemonic) {
      await printNewIdentity(mnemonic, keystorePath, Boolean(envPassword), log);
    }
  }

  // --- 2. Transport scaffolding --------------------------------------------
  if (!existsSync(configPath)) {
    // Fresh install: surface the transport knobs with guidance.
    updated = {
      _help: CONFIG_HELP,
      proxyUrl: '',
      btpUrl: '',
      relayUrl: 'ws://localhost:7100',
      ...updated,
    } as DaemonConfigFile;
    changed = true;
    log(
      `[toon-clientd] wrote starter config at ${configPath} — set "proxyUrl" (connector proxy, ILP-over-HTTP) or "btpUrl" (BTP) to your apex before publishing.`
    );
  }

  if (changed) writeConfigFile(configPath, updated);
}

/** Derive + print the new identity's addresses and a one-time backup notice. */
async function printNewIdentity(
  mnemonic: string,
  keystorePath: string,
  hasEnvPassword: boolean,
  log: (msg: string) => void
): Promise<void> {
  const id = await deriveFullIdentity(mnemonic);
  const lines = [
    '',
    '════════════════════════════════════════════════════════════════',
    '  TOON client: generated a new identity (first run)',
    '════════════════════════════════════════════════════════════════',
    `  Nostr pubkey : ${id.nostr.pubkey}`,
    `  EVM address  : ${id.evm.address}`,
    ...(id.solana.publicKey ? [`  Solana       : ${id.solana.publicKey}`] : []),
    ...(id.mina.publicKey ? [`  Mina         : ${id.mina.publicKey}`] : []),
    '',
    '  Seed phrase (BACK THIS UP — shown only once):',
    `    ${mnemonic}`,
    '',
    `  Encrypted keystore: ${keystorePath}`,
    hasEnvPassword
      ? '  Encrypted with TOON_CLIENT_KEYSTORE_PASSWORD.'
      : '  Encrypted with the default password (set TOON_CLIENT_KEYSTORE_PASSWORD\n' +
        '  + re-import to use your own). Identity reloads automatically on restart.',
    '════════════════════════════════════════════════════════════════',
    '',
  ];
  log(lines.join('\n'));
}

/** Write the config file as pretty JSON with mode 0o600. */
function writeConfigFile(path: string, file: DaemonConfigFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}
