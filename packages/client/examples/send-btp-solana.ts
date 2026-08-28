/**
 * Pay for one HTTP request over BTP, settling on Solana devnet.
 *
 * The node here is the devnet relay: it serves the route `g.toon.relay` at a
 * flat 1 base unit (0.000001 USDC) and accepts **BTP only**. An HTTP one-shot
 * to it is refused with the same terms document an unpaid request gets,
 * carrying `requiredTransport: 'btp'` — so this example asks for the websocket
 * carriage explicitly rather than letting `'auto'` discover it.
 *
 * Run it:
 *
 *   export TOON_MNEMONIC="your twelve words …"
 *   npx tsx examples/send-btp-solana.ts
 *
 * The wallet needs devnet SOL for the transactions that open and fund the
 * channel — the faucet's Solana leg drips USDC and no SOL, so get SOL from
 * `solana airdrop 1 <address> --url devnet` first.
 */
import { ToonClient, DEVNET } from '@toon-protocol/client';

const mnemonic = process.env['TOON_MNEMONIC'];
if (!mnemonic) throw new Error('Set TOON_MNEMONIC to a BIP-39 phrase.');

const client = await ToonClient.create({
  connector: DEVNET.relay.url, // https://proxy.relay.devnet.toonprotocol.dev
  mnemonic,
  chain: 'solana',
  // One ordered socket cannot race its own claim nonces, which parallel HTTP
  // requests can. It is also the only carriage this route accepts.
  transport: 'btp',
  channelStore: `${process.env['HOME'] ?? '.'}/.toon/channels.json`,
});

try {
  console.log('paying as', client.identity.solanaPublicKey);

  // Uncomment on a wallet that has never been funded. USDC only — see above.
  // await client.wallet.faucet('solana');

  const channel = await client.channel.open({ deposit: 100_000n });
  console.log(
    'channel', channel.channelId,
    'available', channel.available.toString(), 'base units'
  );

  // The route costs 1 base unit (0.000001 USDC), so one 0.10 USDC deposit
  // covers a hundred thousand of these before the channel needs a top-up.
  for (let i = 0; i < 3; i++) {
    const answer = await client.send(DEVNET.relay.route, {
      method: 'POST',
      body: { hello: 'from send-btp-solana.ts', i },
    });
    if (!answer.fulfilled) {
      console.error('refused by', answer.refusedBy, answer.code, answer.message);
      process.exitCode = 3;
      break;
    }
    console.log(
      `#${i}`, 'status', answer.status,
      'nonce', answer.claim.nonce,
      'cumulative', answer.claim.cumulative.toString()
    );
  }
} finally {
  // Releases the websocket session and flushes the channel store. It does not
  // close the channel — that is an on-chain act, `client.channel.close()`.
  await client.close();
}
