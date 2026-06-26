// One-shot: build a kind:5094 Arweave-blob DVM job and POST it through the
// running toon-clientd daemon (the same /publish path the plugin's toon_publish
// tool drives). The caller signs the Nostr event; the daemon signs the claim.
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const DAEMON = 'http://127.0.0.1:8787';
const DEST = 'g.townhouse.store';

const blob = Buffer.from(
  `TOON client-mcp live DVM exercise — issue #197\n` +
    `uploaded ${new Date().toISOString()} via the toon plugin\n`,
  'utf8'
);

const sk = generateSecretKey();
const event = buildBlobStorageRequest(
  { blobData: blob, contentType: 'text/plain', bid: '1000' },
  sk
);

console.log(
  `kind:${event.kind} id ${event.id.slice(0, 16)}… author ${getPublicKey(sk).slice(0, 16)}… blobBytes ${blob.length} tags ${JSON.stringify(event.tags.map((t) => t[0]))}`
);

const res = await fetch(`${DAEMON}/publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event, destination: DEST }),
});

const body = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));

if (body && body.data) {
  // FULFILL data is base64 — decode to reveal the Arweave tx id / receipt.
  try {
    console.log('FULFILL data (decoded):', Buffer.from(body.data, 'base64').toString('utf8'));
  } catch {
    /* leave as-is */
  }
}
process.exit(res.ok ? 0 : 1);
