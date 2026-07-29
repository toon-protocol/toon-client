// Drive a real PAID h402 fetch through the compiled Http402Client at a REAL
// Rust connector. A throwaway local origin answers 402 with the connector's own
// x402 terms shape (relative "/ilp", price under `extra`); the adapter then
// seals the request envelope to the connector's identity and pays.
//
//   node scripts/live-h402-sealed.mjs
import { createServer } from 'node:http';
import { Http402Client, EvmSigner } from '../dist/index.js';
import { privateKeyToAccount } from 'viem/accounts';

const EDGE = process.env.EDGE ?? 'http://127.0.0.1:3000';
const DEST = process.env.DEST ?? 'g.local.app.write';
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

const price = await (
  await fetch(`${EDGE}/ilp/routes/price?destination=${encodeURIComponent(DEST)}`)
).json();
console.log('route price:', JSON.stringify(price));

// An origin that demands payment, in exactly the connector's own terms shape.
const origin = createServer((req, res) => {
  res.writeHead(402, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      x402Version: 2,
      resource: { url: DEST },
      accepts: [
        {
          scheme: 'toon-channel',
          network: DEST,
          amount: String(price.price),
          payTo: DEST,
          maxTimeoutSeconds: 60,
          httpEndpoint: `${EDGE}/ilp`,
          extra: { ilpAddress: DEST, endpoint: '/ilp', price: String(price.price) },
        },
      ],
    })
  );
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originUrl = `http://127.0.0.1:${origin.address().port}${process.env.TARGET ?? '/'}`;

const nonce = Number(process.env.NONCE ?? Math.floor(Date.now() / 1000));
async function resolveClaim(destination, amount) {
  const claim = {
    channelId: '0x' + '11'.repeat(32),
    nonce,
    transferredAmount: BigInt(amount) * BigInt(nonce),
    lockedAmount: 0n,
    locksRoot: '0x' + '00'.repeat(32),
    chainId: 31337,
    tokenNetworkAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  };
  claim.signature = await account.signTypedData({
    domain: { name: 'TokenNetwork', version: '1', chainId: 31337, verifyingContract: claim.tokenNetworkAddress },
    types: { BalanceProof: [
      { name: 'channelId', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' }, { name: 'lockedAmount', type: 'uint256' },
      { name: 'locksRoot', type: 'bytes32' }] },
    primaryType: 'BalanceProof',
    message: { channelId: claim.channelId, nonce: BigInt(nonce),
      transferredAmount: claim.transferredAmount, lockedAmount: 0n, locksRoot: claim.locksRoot },
  });
  claim.signerAddress = account.address;
  console.log(`resolveClaim(${destination}, ${amount}) -> signed`);
  // Same wire shape ToonClient.resolveClaimForDestination produces.
  return EvmSigner.buildClaimMessage(claim, '00'.repeat(32));
}

const h = new Http402Client({ resolveClaim });
try {
  const res = await h.fetch(originUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'paid h402 over the sealed wire' }),
  });
  console.log('status:', res.status);
  console.log('statusText:', JSON.stringify(res.statusText), '(no reason phrase on this wire)');
  console.log('content-type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('body:', text.slice(0, 240));
  process.exit(res.status === 200 ? 0 : 1);
} catch (e) {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
} finally {
  origin.close();
}
