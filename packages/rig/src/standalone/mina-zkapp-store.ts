/**
 * Persistence for rig's auto-deployed per-pair Mina `PaymentChannel` zkApps.
 *
 * The Mina zkApp is single-pair (one deployment per client↔connector pair)
 * and costs ~1.1 MINA to deploy, so the zkApp's PRIVATE KEY must survive the
 * process: losing it strands the deployment (and any future co-signed zkApp
 * tx). Records live in `<TOON_CLIENT_HOME>/keys/rig-mina-zkapps.json`
 * (mode 0600 — it holds private keys), keyed `identity|chain`, next to the
 * hand-managed `mina-zkapp-*-deploy.json` records operators already keep.
 *
 * A stale record self-heals: the open path's ownership check (on-chain
 * channelHash vs the current pair) simply stops matching and a fresh zkApp is
 * deployed over a new record.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** One auto-deployed zkApp record (everything needed to reuse or audit it). */
export interface RigMinaZkAppRecord {
  /** The rig identity (nostr pubkey hex) that deployed it. */
  identity: string;
  /** The settlement chain the deployment serves (e.g. `mina:devnet`). */
  chain: string;
  /** Deployed zkApp B62 address (== the channel id). */
  zkAppAddress: string;
  /** The zkApp's `EK…` base58 private key. */
  zkAppPrivateKey: string;
  /** The fee payer (client Mina B62) that funded the deployment. */
  feePayer?: string;
  /** Deploy tx hash, when the send surfaced one. */
  deployTxHash?: string;
  /** Verification-key hash of the compiled contract that was deployed. */
  vkHash?: string;
  /** ISO timestamp of the deployment. */
  deployedAt: string;
  /** Provenance note (package/build the contract came from). */
  source?: string;
}

const FILENAME = 'rig-mina-zkapps.json';

/** `identity|chain` — one live deployment per identity per chain. */
function keyFor(identity: string, chain: string): string {
  return `${identity}|${chain}`;
}

export class MinaZkAppStore {
  constructor(readonly filePath: string) {}

  /** The store under a client home dir: `<dir>/keys/rig-mina-zkapps.json`. */
  static forHome(dir: string): MinaZkAppStore {
    return new MinaZkAppStore(join(dir, 'keys', FILENAME));
  }

  private readAll(): Record<string, RigMinaZkAppRecord> {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<
        string,
        RigMinaZkAppRecord
      >;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(
        `failed to read the Mina zkApp store at ${this.filePath}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** The recorded deployment for this identity/chain, if any. */
  lookup(identity: string, chain: string): RigMinaZkAppRecord | undefined {
    return this.readAll()[keyFor(identity, chain)];
  }

  /** Read-merge-write; the file holds private keys → 0600. */
  save(record: RigMinaZkAppRecord): void {
    const all = this.readAll();
    all[keyFor(record.identity, record.chain)] = record;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(all, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // writeFileSync's `mode` only applies on CREATE — re-tighten every save.
    chmodSync(this.filePath, 0o600);
  }
}
