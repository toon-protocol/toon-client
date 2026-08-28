/**
 * Pay for one HTTP request over ILP-over-HTTP, settling on Base Sepolia.
 *
 * The node here is the devnet store: it fronts an object store at the route
 * `g.toon.store` and charges a flat 1000 base units (0.001 USDC) per request,
 * over either carriage.
 *
 * Run it:
 *
 *   export TOON_MNEMONIC="your twelve words …"
 *   npx tsx examples/send-http.ts
 *
 * The wallet needs two things before this works: mock USDC to collateralize the
 * channel (`toon faucet`, or `wallet.faucet()` below) and a little Base Sepolia
 * ETH for the gas the channel open itself spends. Paying for a request spends
 * no gas — that is the point of a channel.
 */
import { ToonClient, DEVNET } from '@toon-protocol/client';

const mnemonic = process.env['TOON_MNEMONIC'];
if (!mnemonic) throw new Error('Set TOON_MNEMONIC to a BIP-39 phrase.');

const client = await ToonClient.create({
  connector: DEVNET.store.url, // https://proxy.ario.devnet.toonprotocol.dev
  mnemonic,
  chain: 'evm',
  transport: 'http',
  // Persist the claim watermark. In memory it is lost on restart, and every
  // claim signed after that is refused for not advancing the connector's nonce.
  channelStore: `${process.env['HOME'] ?? '.'}/.toon/channels.json`,
});

try {
  console.log('paying as', client.identity.evmAddress);

  // What the node says about itself: addresses, endpoints, the key a payload is
  // sealed to, and per chain what opening a channel takes. One free GET.
  const description = await client.describe();
  console.log('routes', description.routes.map((r) => `${r.prefix} @ ${r.price}`));

  // Uncomment on a wallet that has never been funded. Devnet only.
  // await client.wallet.faucet('evm');

  // Collateral, in the settlement token's base units: 100000 is 0.10 USDC.
  // Idempotent — it adopts the channel already open with this connector.
  const channel = await client.channel.open({ deposit: 100_000n });
  console.log(
    'channel', channel.channelId,
    'available', channel.available.toString(), 'base units'
  );

  const answer = await client.send(DEVNET.store.route, {
    method: 'POST',
    target: '', // the route's own handler
    headers: { 'content-type': 'text/plain' },
    body: 'hello from send-http.ts',
  });

  if (!answer.fulfilled) {
    // A refusal is an outcome, not an exception. See docs/errors.md.
    console.error('refused by', answer.refusedBy, answer.code, answer.message);
    if (answer.accumulatedCost !== undefined) {
      console.error('the path costs', answer.accumulatedCost.toString(), 'base units');
    }
    process.exitCode = 3;
  } else {
    console.log('status', answer.status);
    console.log('body', answer.text());
    console.log(
      'spent', answer.claim.amount.toString(),
      'base units at nonce', answer.claim.nonce
    );
  }
} finally {
  await client.close();
}
