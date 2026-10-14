# @toon-protocol/client

Pay for an HTTP request, per request, in stablecoin, from code or a terminal. No account, no
API key, and no gas to open a channel or to pay.

## Three steps to a paid request

**1. Install.** One package gives you the library and the `toon-client` CLI.

```bash
npm install @toon-protocol/client
```

**2. Open one channel.** A wallet, devnet USDC from the faucet, then a 0.10 USDC deposit at the
devnet store. No ETH needed.

```bash
export TOON_CONNECTOR=https://proxy.ario.devnet.toonprotocol.dev
npx toon-client init                            # an encrypted keystore at ~/.toon/keystore.json
npx toon-client faucet                          # devnet USDC for that address
npx toon-client channel open --deposit 100000   # 100000 base units (0.10 USDC), no gas
```

**3. Send one request.** The devnet store answers a plain body with its own `422`. That cost
1010 base units, the same as a `200`.

```bash
npx toon-client send --body 'hello'
```

The same from the library:

```ts
import { ToonClient } from '@toon-protocol/client';

const client = await ToonClient.create({
  connector: 'https://proxy.ario.devnet.toonprotocol.dev',
  mnemonic: process.env.TOON_MNEMONIC,
  channelStore: `${process.env.HOME}/.toon/channels.json`,
});

await client.channel.open({ deposit: 100_000n }); // 100000 base units (0.10 USDC)

const answer = await client.send({ body: 'hello' });
if (answer.fulfilled) {
  console.log(answer.status, answer.text());       // the app's own HTTP response
  console.log(answer.claim.amount);                // 1010n base units: 1000 + 10 per KiB
} else {
  console.log(answer.code, answer.message);        // a refusal, not an exception
}

await client.close();
```

## What you can count on

- A request costs a signature, not a transaction. At the devnet store that is 1000 base units
  (0.001 USDC), plus 10 per kibibyte.
- A refusal is returned as a value with a code, never thrown.
- An x402 batch-settlement channel on Base or Solana, opened once. Your deposit minus what you
  signed for is yours to take back; only leaving costs gas.
- The wire is defined by [the connector's](https://github.com/toon-protocol/connector) committed
  vectors, which this package replays as its conformance suite.
- MIT.

Everything else is under [Documentation](#documentation) below.

## Documentation

| Document | What is in it |
| --- | --- |
| [Getting started](https://github.com/toon-protocol/toon-client/blob/main/docs/getting-started.md) | Nothing to a paid request, step by step |
| [Library API](https://github.com/toon-protocol/toon-client/blob/main/docs/api.md) | `ToonClient`, its configuration, and every type it returns |
| [CLI reference](https://github.com/toon-protocol/toon-client/blob/main/docs/cli.md) | Every command, resolution order, `--json`, exit codes |
| [Payment channels](https://github.com/toon-protocol/toon-client/blob/main/docs/channels.md) | Collateral, the lifecycle on both chains, the watermark |
| [How a paid packet works](https://github.com/toon-protocol/toon-client/blob/main/docs/how-a-paid-packet-works.md) | The wire, top to bottom |
| [Devnet reference](https://github.com/toon-protocol/toon-client/blob/main/docs/devnet.md) | Endpoints, routes, prices, contract addresses, faucet |
| [Errors and reject codes](https://github.com/toon-protocol/toon-client/blob/main/docs/errors.md) | What each code means and what to do about it |
| [Troubleshooting](https://github.com/toon-protocol/toon-client/blob/main/docs/troubleshooting.md) | Symptom, cause, fix |
