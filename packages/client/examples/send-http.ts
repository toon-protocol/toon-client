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
 * The wallet needs devnet USDC for the channel's deposit (`toon faucet`, or
 * `wallet.faucet()` below) and no ETH at all: the devnet's x402 facilitator
 * relays the deposit and pays its gas, and paying for a request spends none.
 */
import { ToonClient, DEVNET } from '@toon-protocol/client';

const mnemonic = process.env['TOON_MNEMONIC'];
if (!mnemonic) throw new Error('Set TOON_MNEMONIC to a BIP-39 phrase.');

const client = await ToonClient.create({
  connector: DEVNET.store.url, // https://proxy.ario.devnet.toonprotocol.dev
  mnemonic,
  chain: 'evm',
  transport: 'http',
  // In the settlement token's base units: 100000 is 0.10 USDC.
  deposit: 100_000n,
  // Persist the channel and its voucher watermark. An x402 channel's config
  // cannot be read back from the chain, so without a store a restart opens a
  // fresh channel.
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

  // Optional: the first paid send opens the channel on its own. Opening it
  // here just makes the deposit visible first. Idempotent — it returns the
  // channel already open with this connector.
  const channel = await client.channel.open();
  console.log(
    'channel', channel.channel.channelId,
    'deposit', channel.depositTotal.toString(), 'base units'
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
      'spent', answer.claim?.amount.toString(),
      'base units; cumulative', answer.claim?.cumulative.toString()
    );
  }
} finally {
  await client.close();
}
