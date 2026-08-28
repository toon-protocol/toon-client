# @toon-protocol/client

Pay for an HTTP request, per request, in stablecoin. A **connector** is a paid reverse proxy:
it fronts an ordinary HTTP app, charges a flat price per route, and hands that app a request
that was already paid for. This package is the payer, as a library and as the `toon` CLI.

## Install

```bash
npm install @toon-protocol/client
```

## Example

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
  console.log(answer.claim.amount);                // 1000n base units (0.001 USDC)
} else {
  console.log(answer.code, answer.message);        // a refusal, not an exception
}

await client.close();
```

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

The wire is defined by the Rust connector, not by this package:
[toon-protocol/connector](https://github.com/toon-protocol/connector) and its committed wire
vectors are the authority, and this client replays them as its own conformance suite.

MIT.
