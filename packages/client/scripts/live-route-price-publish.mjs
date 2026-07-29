// Drive a real paid publish that does NOT state a price: the client must ask
// `GET /ilp/routes/price` for it (toon-client#452, ADR 0020). Not part of the
// suite — run by hand against a running connector:
//
//   EDGE=http://127.0.0.1:3000 DEST=g.local.app.write node scripts/live-route-price-publish.mjs
import { ToonClient } from '../dist/index.js';
import { privateKeyToAccount } from 'viem/accounts';

const EDGE = process.env.EDGE ?? 'http://127.0.0.1:3000';
const DEST = process.env.DEST ?? 'g.local.app.write';
const TARGET = process.env.TARGET ?? '/';

// anvil #0 — the local rehearsal stack's funded payer.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(PK);

const price = await (
  await fetch(`${EDGE}/ilp/routes/price?destination=${encodeURIComponent(DEST)}`)
).json();
console.log('route price:', JSON.stringify(price));

const client = new ToonClient({
  secretKey: new Uint8Array(32).fill(7),
  connectorUrl: EDGE,
  destinationAddress: DEST,
  ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.local.client' },
  toonEncoder: (e) => new TextEncoder().encode(JSON.stringify(e)),
  toonDecoder: (t) => JSON.parse(t),
});

// Wire the HTTP one-shot transport straight up: this script is about the
// packet, not about discovery.
const { HttpIlpClient } = await import('../dist/index.js');
const transport = new HttpIlpClient({ httpEndpoint: `${EDGE}/ilp` });
client.state = {
  bootstrapService: {},
  discoveryTracker: {},
  runtimeClient: transport,
  peersDiscovered: 0,
};

const nonce = Number(process.env.NONCE ?? Date.now() % 1_000_000);
const claim = {
  channelId: '0x' + '11'.repeat(32),
  nonce,
  transferredAmount: BigInt(price.price) * BigInt(nonce),
  lockedAmount: 0n,
  locksRoot: '0x' + '00'.repeat(64 / 2),
  chainId: 31337,
  tokenNetworkAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
};
claim.signature = await account.signTypedData({
  domain: {
    name: 'TokenNetwork',
    version: '1',
    chainId: claim.chainId,
    verifyingContract: claim.tokenNetworkAddress,
  },
  types: {
    BalanceProof: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
      { name: 'lockedAmount', type: 'uint256' },
      { name: 'locksRoot', type: 'bytes32' },
    ],
  },
  primaryType: 'BalanceProof',
  message: {
    channelId: claim.channelId,
    nonce: BigInt(claim.nonce),
    transferredAmount: claim.transferredAmount,
    lockedAmount: 0n,
    locksRoot: claim.locksRoot,
  },
});
claim.signerAddress = account.address;

const event = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  kind: 1,
  content: 'a real paid write over the sealed wire',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  sig: 'c'.repeat(128),
};

// Watch what the client asks for, and what amount it ends up sending.
const urls = [];
const origFetch = globalThis.fetch;
globalThis.fetch = (u, i) => {
  urls.push(String(u));
  return origFetch(u, i);
};
const realSend = transport.sendIlpPacketWithClaim.bind(transport);
let sentAmount;
transport.sendIlpPacketWithClaim = (p, c) => {
  sentAmount = p.amount;
  return realSend(p, c);
};

const result = await client.publishEvent(event, {
  destination: DEST,
  claim,
  // NO ilpAmount. The price has to come from the connector.
  proxyPath: TARGET,
});

console.log('asked GET /ilp/routes/price:', urls.some((u) => u.includes('/ilp/routes/price')));
console.log('amount the client chose:', sentAmount, '| route price:', String(price.price));
console.log('matches the route price:', sentAmount === String(price.price));

console.log('success:', result.success);
console.log('refusedBy:', result.refusedBy ?? '(none)');
console.log('error:', result.error ?? '(none)');
if (result.response) {
  console.log('answer status:', result.response.status);
  console.log('answer headers:', JSON.stringify(result.response.headers));
  console.log(
    'answer body:',
    new TextDecoder().decode(result.response.body).slice(0, 300)
  );
}
process.exit(result.success ? 0 : 1);
