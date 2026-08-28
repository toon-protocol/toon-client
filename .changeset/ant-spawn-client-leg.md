---
'@toon-protocol/client': minor
---

**An ArNS name is now buyable holding nothing but ILP credit.**

`kind:5095 op=buy` needs a `processId` — the MPL Core asset pubkey of an ANT the caller already
owns. Spawning one costs ~0.012 SOL of rent, and this client holds stablecoin credit on a payment
channel, not SOL, so that job shipped with a precondition none of its callers could satisfy. The
work now splits across three parties, and no single one has to be able to do all of it: the
**store** composes the transaction, the **client** signs it, the **gas station** pays for it and
broadcasts it.

```ts
const outcome = await buyArnsNameWithNewAnt({
  store: { client, destination: 'g.toon.store' },
  gas:   { client, destination: 'g.toon.gas' },
  owner: solanaKeypair(secret),
  name:  'my-name',
  years: 1,
});
```

Two quotes and two signings, because the gas station prices the job from a **signed** draft — that
is what makes the free quote a full policy dry run — and then requires the executed transaction to
carry the blockhash **it** chose. Everything after the pricing quote runs inside one merged
quote/blockhash deadline, so the client patches those 32 bytes locally rather than paying for a
second `op=prepare`; pass `reprepare` to take that round trip anyway.

New API:

- `spawnAnt`, `buyArnsName`, `buyArnsNameWithNewAnt` and the `ARNS_KIND` / `SOLANA_GAS_KIND`
  constants, with the store's and the gas station's receipt types.
- `buildJobEvent`, `jobEventParam` and `sendJob` — a signed, kind-tagged NIP-90 event as the body
  of an ordinary paid request. The signature is **integrity, not identity**: who paid is the
  connector's `X-TOON-Payer` header, proved against a claim, so the event key is generated per
  event and this client still carries no Nostr identity.
- `solanaKeypair(secret)` reads a stored 32-byte seed or 64-byte secret key back into a signer,
  deriving the public half rather than trusting a 64-byte secret's tail.

The signing primitives themselves — `parseSolanaWireTransaction`, `signSolanaWireTransaction`,
`patchSolanaRecentBlockhash` — are exported for anyone holding a compiled transaction they did not
build. They fill slots in place and never recompile: signature order is the compiled header order,
and rebuilding the message invalidates every signature already in it.

A refusal is returned, never thrown — `{ spawned: false, step, reason, idempotencyKey }`, with
`reason` from the gas station's own vocabulary wherever the verdict is one the gas station would
give. That includes the two checks made locally before the execute is paid for, so
`missing_client_signature` means the same thing whichever side caught it. A `confirmation_timeout`
carries back the `idempotencyKey`, `quoteId` and transaction bytes needed to re-send that execute,
which is the only correct recovery from a transaction that is broadcast and may yet land.
