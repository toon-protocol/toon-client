# Errors and reject codes

**A refusal is returned, never thrown.** `send()` resolves with `fulfilled: false` for anything
the network refused — a bad claim, a route that does not exist, a carriage the route will not
accept. Everything this client *throws* happened before the packet went out, or on chain.

That split is the whole of the rule. A thrown error means you have a configuration or a wallet to
fix; a returned refusal means the network answered, and the answer was no.

```ts
const answer = await client.send('g.toon.store', { body: 'hello' });
if (!answer.fulfilled) {
  answer.code;             // 'F03', 'F01', 'PAYMENT_REQUIRED', 'TRANSPORT_REQUIRED', …
  answer.message;          // diagnostic text. Never branch on it — branch on the code.
  answer.refusedBy;        // 'destination' | 'path' | 'edge'
  answer.accumulatedCost;  // what the path costs, when the connector stated it
}
```

## Who refused

| `refusedBy` | What it means |
| --- | --- |
| `destination` | The reject came back **sealed**. Only the terminating connector holds the secret to seal one, so this is proof the destination itself said no. |
| `path` | The reject arrived in plaintext. That identifies nobody: a hop short of the termination refused, or the termination could not open the wrap. |
| `edge` | The connector you are attached to refused before routing at all — a greeting, or a wrong carriage. |

Sealed identifies the destination; unsealed identifies nobody. Do not read a plaintext reject as
an accusation against any particular node.

## Reject codes

| Code | Means | The client does | You do |
| --- | --- | --- | --- |
| `F00` | Bad request: the envelope's `target` escaped the route's handler path — an absolute path, a `..` segment, a scheme or an authority. | Nothing. It is a request the app was never asked. | Fix `target`. It is resolved *beneath* the handler; `''` and `'/'` both mean the handler itself. |
| `F01` | Malformed claim, a nonce that does not advance, or a channel the connector has no record of. | Rolls the local cumulative back so the amount is not lost. On "unknown channel", evicts the stale binding and retries once with a fresh channel. | If it persists: run `claim-state` and compare nonces. A nonce behind the connector's watermark usually means a lost channel store — see [channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable). |
| `F02` | No route to that destination — including "no route over *this* carriage", which is how the BTP side answers a route restricted to HTTP. | Surfaces the terms when the reject carried them. | Check the destination against `describe()`. If it carries `requiredTransport`, send over that carriage. |
| `F03` | Either the claim **underpaid** the route, or its cumulative amount exceeded the channel's deposit, or the declared `amount` exceeded the price on a forwarded route. | Rolls the local cumulative back. | Underpayment: `accumulatedCost` **is the route's price** — pay that. Over deposit: `accumulatedCost` is `0`; deposit more and resend the same nonce. Forwarded route: send exactly the price, not more. |
| `F06` | No claim was attached, on the BTP carriage. This is the greeting: the route's terms instead of the work. | Surfaces `terms` on the result, with the price and the settlements offered. | Open or fund a channel, then send with a claim. |
| `T00` | The connector hit an internal error. Temporary. | Nothing automatic. | Retry with backoff. |
| `T01` | A peer on the path is unreachable, or the client session addressed is gone. Temporary. | Nothing automatic. | Retry with backoff. The packet is fine; the path currently is not. |
| `T04` | The packet exceeds the cap a connector will forward to one peer in a single packet. Never carried, never split. | Nothing. | The reject's message states the cap. Send a smaller packet — this is the only way the cap is published. |
| `T05` | Rate limited. | Nothing automatic. | Back off. On `POST /ilp/probe` this is the probe rate limit, per channel. |
| `R00` | The packet expired before it arrived. | Nothing automatic. | Retry. Persistent expiry means a slow path or a clock well out of step. |

`accumulatedCost` rides beside the packet — an HTTP header, or a BTP protocolData entry — and only
on a REJECT. It is one figure: every hop's flat fee plus the price of the route that terminated.
Never a breakdown. It is `0` when nothing was traversed and nothing terminated.

## Client-side codes on a refusal

Two `code` values do not come from the wire. They are refusals this client names when the
connector answered with a greeting rather than a packet:

| Code | Means | You do |
| --- | --- | --- |
| `PAYMENT_REQUIRED` | The connector answered the route's terms instead of the work — HTTP `402`, or `F06` over BTP. `answer.terms` carries the price and the settlements it accepts. | Open or fund a channel on one of the offered chains. |
| `TRANSPORT_REQUIRED` | The route does not accept the carriage you used. `answer.terms.requiredTransport` names the one it does. | Resend over that carriage: `transport: 'btp'`, or `--transport btp`. |

## HTTP statuses

An ILP-level outcome is always HTTP `200`, whether the packet fulfilled or was rejected. A non-2xx
is a transport-level failure and never carries a packet body.

| Status | Means | The client does | You do |
| --- | --- | --- | --- |
| `400` | The body was not a decodable PREPARE, or was oversized. | Raises `ConnectorError`. | This is a bug in whatever formed the packet — or an encoder that is not TOON's dialect. See [how-a-paid-packet-works.md](how-a-paid-packet-works.md#the-packet-is-ilpv4s-semantics-in-toons-encoding). |
| `401` | An `ILP-Peer-Id` was presented and did not authenticate. | Raises `ConnectorError`. | Drop the peer id, or fix the credential. Anonymous payers need neither: the claim identifies you. |
| `402` | Unpaid request to a priced route, or a request over a carriage the route refuses. The body is the terms document. | Returns `fulfilled: false`, `code: 'PAYMENT_REQUIRED'` (or `'TRANSPORT_REQUIRED'`), with `terms` parsed. | Pay, or switch carriage. |
| `403` | A probe from a sender with no channel the connector recognizes, or over the probe rate limit. | Raises `ConnectorError`. | Open and use a channel first. Probing is free traversal, gated on having paid before. |
| `413` | The body exceeded the 2 MiB limit. | Raises `ConnectorError`. | Send less. There is no configuration knob for this on the connector. |

## Errors this client throws

All of them extend `ToonClientError`, which carries a stable `code` string. Branch on the class or
on `code`, never on the message.

| Class | `code` | Thrown when |
| --- | --- | --- |
| `ConfigError` | `CONFIG` | The configuration cannot be used as given — a token network that does not match the registry, a missing required field. |
| `ValidationError` | `VALIDATION_ERROR` | An argument is invalid. Thrown before anything is sent. |
| `NetworkError` | `NETWORK_ERROR` | A connection failed or timed out. Distinct from a refusal: nobody answered. |
| `ConnectorError` | `CONNECTOR_ERROR` | The connector answered with a transport-level failure — the non-2xx statuses above. |
| `ChainUnavailableError` | `CHAIN_UNAVAILABLE` | The chain you asked to settle on is not among the node's settlements, or you hold no key for any it offers. The error lists what it does offer. |
| `RouteNotPricedError` | `ROUTE_NOT_PRICED` | The connector serves no route matching the destination, so there is no price to pay. |
| `ChannelNotOpenError` | `CHANNEL_NOT_OPEN` | A request needed a channel and none exists, with `autoOpenChannel` off. |
| `ChannelFundingError` | `CHANNEL_FUNDING` | The on-chain open reverted for want of **native gas**. Retryable once the wallet is funded. |
| `ChannelResumeError` | `CHANNEL_RESUME` | A persisted binding names a channel whose watermark is missing from the store. Deliberately fatal — see [channels.md](channels.md#the-watermark-and-why-the-store-must-be-durable). |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | A transfer or an open cannot be covered. A preflight check, so it never costs gas. |
| `StaleRpcReadError` | `STALE_RPC_READ` | An EVM RPC never converged on a just-confirmed open. Retryable; the cure is a consistent RPC. |
| `InvalidAddressError` | `INVALID_ADDRESS` | A destination address is malformed for its chain. Checked before any transaction is built. |
| `UnknownChainError` | `UNKNOWN_CHAIN` | A chain identifier is unrecognized, or this client has no configuration for it. |
| `TransferNotDeliveredError` | `TRANSFER_NOT_DELIVERED` | A transfer's transaction landed and did not revert, but the destination's observed balance never moved. Real: the devnet faucet's Solana leg has returned a genuine signature having delivered nothing. |
| `TransferUnsupportedError` | `TRANSFER_UNSUPPORTED` | The chain and asset combination has no configuration — an `asset: 'token'` send with no token address or mint. |
| `SealedResponseError` | — | A FULFILL came back that is not a readable sealed response. `kind` is `'not-sealed'`, `'unopenable'` or `'malformed-envelope'`. Value moved, so this is a broken counterparty, not an outcome. |
| `PaymentRequiredError` | `PAYMENT_REQUIRED` | Raised by the low-level HTTP transport on a `402`. `send()` catches it and returns a refusal instead; you see it only when driving the transport directly. |
| `TransportRequiredError` | `TRANSPORT_REQUIRED` | You asked for a carriage the node does not expose, or the route requires the other one. `send()` returns a refusal for the route case. |

## Reading a fulfilled answer that is not a success

`fulfilled: true` means the packet reached the app and you paid for it. It says nothing about what
the app thought of the request. A `404` or a `500` from the app rides home on a FULFILL and costs
exactly what a `200` costs.

```ts
if (answer.fulfilled && answer.status >= 400) {
  // Paid for, and the app said no. Read the body; the money is spent.
}
```

The `claim` on the result tells you exactly what was spent: `amount` for this request,
`cumulative` for the channel, and the `nonce` it advanced to.
