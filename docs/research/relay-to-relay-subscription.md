# Can one TOON relay subscribe to another, and what does a gossiped event cost?

Research note, 2026-10-01. Not user-facing documentation and not normative. Resolves
[toon-client#716](https://github.com/toon-protocol/toon-client/issues/716), a ticket on the map
[toon-client#715](https://github.com/toon-protocol/toon-client/issues/715).

**The question.** The agent-node design says discovery is gossip: every agent runs its own relay,
and relays subscribe to each other. A relay's writes are paid packets through a connector route. So
does a relay that copies an event from another relay pay to store it, get paid to store it, or
bypass payment? And can it do any of that today?

**How to read this.** §1 is the answer. §2 to §6 are sourced facts, each with a file and line, or
an experiment I ran. §7 is my analysis and is labelled as such. §8 lists what I did not verify.

## Citation conventions and versions

- **R:`path:lines`** is the relay, `/home/allidoizcode/Work/TOON-Protocol/relay`, at `main@1765503`
  (2026-09-29). The checkout is on `main` and 5 commits behind `origin/main`. Those 5 commits touch
  no file under `packages/` and only two tests and one script line under `deploy/`
  (`git diff --stat HEAD origin/main -- packages deploy`), so the source read here is current.
- **C:`path:lines`** is the connector, `/home/allidoizcode/Work/TOON-Protocol/connector`, at
  `main@8b938f9b` (2026-09-30), 2 behind `origin/main`.
- **I:`path:lines`** is infra, `/home/allidoizcode/Work/TOON-Protocol/infra`, at `b607340`
  (2026-09-29). **This checkout is not on `main`**: it is on `issue-42-dealer`. The two hidden-service
  lines this note relies on were re-checked against `origin/main@dcb4cb1` with `git grep` and are
  present there too.
- **NT:`lines`** is `nostr-tools@2.23.1`, `lib/esm/pool.js`, as installed in the relay checkout's
  `node_modules`. The published image carries `nostr-tools@2.25.0`.
- **Image** is `ghcr.io/toon-protocol/relay:release` as pulled on this machine: relay `2.1.0`,
  built 2026-08-28 from revision `f6a3354`, digest `2c628e86b05c`. It is the digest infra's sandbox
  pins (I:`sandbox/docker-compose.yml:807`). The live devnet relay reports `2.2.0`.
- **Experiment** means §6: two scripts I wrote and ran against the image and against the source.

## 1. Short answer

**One relay can pull another relay's events for free, and the code to do it is already in the
relay. It is not usable as shipped.** The verdict for the design: gossip between per-agent relays
does not work today, and what it takes to make it work is small and is all in the relay. Nothing in
the relay or the connector makes a gossiped event a paid write. This ticket does not kill the
design.

- **Outbound subscription exists as a library API only.** `RelaySubscriber` and
  `RelayInstance.subscribe(relayUrl, filter)` open a NIP-01 `REQ` to another relay and write what
  comes back straight into the local store. No CLI flag, environment variable or config field
  reaches it, and nothing in the relay repository calls it.
- **A gossiped event costs nothing and nobody is paid for the copy.** The pull is a free websocket
  read on the upstream relay, and the store call skips `POST /write` and the connector entirely.
  The only payment in the event's life is the author's write to the origin relay.
- **In the published image it silently does nothing.** The image runs Node 20, which has no global
  `WebSocket`, and the relay never gives `nostr-tools` one. `subscribe()` returns a handle that
  says it is active and no event ever arrives.
- **Where it does run, it is one hop and it does not heal.** Pulled events are stored but not
  fanned out to the local relay's live readers, so a third relay following the second never
  receives them live. A dropped upstream connection is never re-opened.
- **If each hop were a paid write instead**, one event to N relays costs N µUSDC at the devnet
  price, plus a fee for every forwarding hop on the way to each relay.
- **A relay is readable over an HS address in infra's sandbox today**, by a sidecar and not by
  anything in the relay. The relay has no way to dial an `.anyone` address itself.

## 2. Outbound subscription: what exists

**The class.** `RelaySubscriber` takes relay URLs and one filter, calls
`SimplePool.subscribeMany`, and on each event verifies the signature and calls
`eventStore.store(event)` (R:`packages/relay/src/subscriber/RelaySubscriber.ts:32-101`; the store
call is `:80`, the verify is `:75`). Its header says what it is for: "Subscribe to upstream relays
and propagate events into the local EventStore" (`:1-2`). It was added on 2026-02-17 in `b6427b5`
"feat: add RelaySubscriber for upstream relay event propagation" and has not been touched by any
later commit to that file.

**The launcher API.** `RelayInstance.subscribe(relayUrl, filter)` is declared at
R:`packages/relay/src/launcher/relay.ts:327-336` and implemented at `:840-850` by
`createSubscription` (`:478-515`), which requires a `ws://` or `wss://` URL, builds a
`RelaySubscriber` with a fresh pool, and tracks the handle so `stop()` closes it (`:856-859`).

**It is not reachable from a deployed relay.**

- `RelayConfig` has no subscription field (R:`relay.ts:84-285`).
- The CLI's option table has no subscription flag (R:`packages/relay/src/launcher/cli.ts:211-242`),
  no environment variable for one (`:124-150`), and `main()` calls `startRelay` and nothing else on
  the instance (`:520-563`).
- A search of the relay repository for `subscribe(`, `RelaySubscriber` and `createSubscription`
  outside tests finds only the definitions and exports
  (R:`packages/relay/src/index.ts:98-100`, `relay.ts:60,336,478,493,840,844`). Neither README
  describes it; `packages/relay/README.md:151` lists the export in a table.
- Tests cover the class against a mocked pool only
  (R:`packages/relay/src/subscriber/RelaySubscriber.test.ts:17-34`). `relay.test.ts` has no test of
  `subscribe()`.

**There is no other mechanism.** No negentropy (NIP-77), no sync job, no mirror. The read side
handles `REQ`, `EVENT` and `CLOSE` and nothing else
(R:`packages/relay/src/websocket/ConnectionHandler.ts:79-91`), and the relay claims NIPs
1, 9, 11, 16 and 40 (R:`packages/relay/src/nips/relay-information.ts:75,232-235`; live NIP-11
document, 2026-10-01). No open or closed issue in `toon-protocol/relay` mentions subscription,
mirroring, gossip or federation (`gh issue list --search`, 2026-10-01).

## 3. How an event gets into storage

There are four ways `store()` is reached. Only the first is the paid path, and it is paid by
topology, not by code.

1. **`POST /write`** on the write port. The handler parses `{ event }`, verifies the signature (or
   only the id, for ephemeral kinds), stores non-ephemeral kinds, and fires the broadcast hook
   (R:`packages/relay/src/launcher/handlers/write-handler.ts:137-207`; store at `:187-189`,
   broadcast at `:192`). It checks no payment. "By the time a request reaches this surface it is
   already proven paid" (`:7-10`). What makes that true is that the port is not published: the
   deploy bundle uses `expose:` and not `ports:` (R:`deploy/docker-compose.yml:242-244`), and the
   launcher warns when the port binds a public interface (R:`relay.ts:439-468`). The payment
   headers the connector states are recorded and echoed, never required
   (R:`packages/relay/src/launcher/handlers/payment-attribution.ts:66-70`). In §6 I wrote to this
   port directly with no connector and got `200`.
2. **`POST /write-ephemeral`**, the free lane. It accepts kinds 20000 to 29999 only, always
   verifies the signature, is rate-limited, and never stores
   (R:`packages/relay/src/launcher/handlers/write-ephemeral-handler.ts:213-236`). The connector
   route in front of it is priced `0` (R:`deploy/connector.toml:89-100`).
3. **`RelayInstance.subscribe()`**, §2. Stores directly. No payment, no connector.
4. **An injected `eventStore`.** A program embedding the relay can pass its own store and write to
   it (R:`relay.ts:127-133,607-616`).

A websocket `EVENT` is not a write path: it is always refused with a message naming where to pay
(R:`ConnectionHandler.ts:163-165`).

**What `store()` itself enforces**, on every path: the operator blocklist, NIP-09 tombstones,
replaceable and addressable replacement, and duplicate ids ignored
(R:`packages/relay/src/storage/SqliteEventStore.ts:288-326`). It returns `void`, so a caller
cannot tell a new event from a duplicate.

## 4. Free ingestion: does anything forbid it, and who has paid?

**Nothing in the relay forbids it.** The subscriber path is the relay's own code and performs no
payment check (R:`RelaySubscriber.ts:72-87`). The only filter is the Nostr filter the caller
passed and a signature check.

**Nothing in the connector can forbid it, because the connector is not on the path.** The
subscriber's connection is an outbound websocket from the relay process to another relay's read
port. A connector sees only packets addressed to its routes and delivers them to a `handler_url`
(R:`deploy/connector.toml:65-83`). It "never interprets the payload of a packet it forwards"
(C:`CONTEXT.md:17-22`), the app behind it is "payment-oblivious" (C:`CONTEXT.md:24-33`), and
discovery and policy live outside it by decision (C:`docs/adr/0006-the-connector-is-mechanism-not-policy.md:7-10`).
No connector record I read says an app may only hold what was paid for at that connector.

**Who has paid, and for what.** A price buys "the work the app does" at the route that terminates
the packet (C:`CONTEXT.md:441-453`). So the author paid the origin relay's operator the origin
route's price, once, for the origin relay to accept the event. The following relay's operator has
been paid nothing and has paid nothing. The upstream relay served the read for free, as it serves
every read: "Reads are free and speak plain NIP-01" (R:`README.md:3-4`), and the read port needs
no authentication (`auth_required: false` in the live NIP-11 document).

## 5. Cost if each hop were a paid write, and the hidden-service read

**The price today.** The devnet relay's paid route is `g.toon.relay`, price `1`, pinned to the
`btp` carriage (R:`deploy/connector.toml:66-83`). The unit is the settlement token's smallest:
1 µUSDC (`:74-77`). The live relay agrees: its NIP-11 document on 2026-10-01 reads
`"fees":{"publication":[{"amount":1,"unit":"uusdc"}]}` with `"carriage":"btp"` and
`"version":"2.2.0"`. A price is per packet and, on every route the fleet runs, flat
(C:`CONTEXT.md:441-453`).

**Cost of reaching N relays by paid writes.** A caller's cost for one packet is "the fees of every
hop that carries it, plus the charge of the route that terminates it" (C:`CONTEXT.md:465-468`). A
fee is flat per packet per peering (C:`CONTEXT.md:430-439`). So one event written to N relays
costs

    N × price            when the payer has a channel to each relay's connector
    N × (price + fees)   when each write is forwarded across one or more peerings

At the devnet price that is N µUSDC with no forwarding hop. The only fee figure in the fleet's
committed configs is infra's sandbox, 100 base units per peering
(I:`sandbox/scripts/peerings.mjs:49-51,76`), where a forwarding row is priced at the payee's price
plus the fee (`:57-59`). The sandbox relay itself is terminated at the hub and has no forwarding
row, so there is no committed example of a forwarded relay write.

**Reads over an HS address.**

- The relay has no hidden-service code. The only mention in its source is a comment that binding
  the read port to `127.0.0.1` is "for hidden service mode"
  (R:`packages/relay/src/types.ts:12`). Its deploy bundle fronts the read port with Caddy on a
  clearnet hostname (R:`deploy/Caddyfile:31-32`), and the devnet relay is
  `wss://relay-ws.devnet.toonprotocol.dev` (R:`README.md:35`).
- Infra's sandbox does publish the relay's read port on an `.anyone` address, under its opt-in
  `hs` profile. The `anon` daemon's config has `HiddenServicePort 7100 127.0.0.1:7100`
  (I:`sandbox/conf/anonrc:125`), and a `socat` sidecar forwards that to `relay:7100`
  (I:`sandbox/docker-compose.yml:1734`). The relay is unmodified; the address belongs to the
  sidecar. Both lines are on infra `origin/main`.
- A reader of that address exists: the hidden provider's relay set is
  `ws://<address>.anyone:7100`, dialled through a SOCKS proxy
  (I:`sandbox/conf/provider-hs.toml:52-60,119-122`).
- The relay cannot be that reader. `RelaySubscriber` builds `new SimplePool()` with no websocket
  implementation and no proxy (R:`RelaySubscriber.ts:50`), `createSubscription` passes no pool
  (R:`relay.ts:493-496`), and the relay's dependencies include no SOCKS client
  (R:`packages/relay/package.json:49-56`).

## 6. Experiment: what `subscribe()` does when it runs

I ran two scripts, with no network (`docker run --network none`), against (a) the published image
and (b) the relay source at `1765503` under Node 22 from a read-only mount. Each starts relays in
one process, writes signed events to a relay's `POST /write` directly, and reads each relay's
history with a one-shot `REQ`. Relay B calls `subscribe()` on relay A with filter
`{ kinds: [1, 20001] }`. A websocket reader is opened on B before anything is gossiped.

**(a) The image as published: nothing is pulled, and the handle says it is active.**

```
node v20.20.2 | relay 2.1.0 | global WebSocket: undefined | patched: false
1. write "old" to A before B subscribes -> 200
2. B.subscribe(A) returned; isActive = true
3. B history after subscribe: []
4. write "new" to A while subscribed -> 200
5. B history: []
```

The cause is in source. The image's base is `node:20-alpine`
(R:`packages/relay/Dockerfile:18,68`) although the repository's `package.json` requires Node 22 or
later (R:`package.json:37-38`) and CI runs Node 22 (R:`.github/workflows/ci.yml:47,71`).
`nostr-tools` takes the global `WebSocket` if there is one (NT:`937-941`) and otherwise passes
`undefined` down to `opts.websocketImplementation || WebSocket` (NT:`224`). That throws, and the
pool catches it and closes the subscription (NT:`789-799`). The relay never calls
`useWebSocketImplementation`
(no match in `packages/relay/src`), and `RelaySubscriber` passes no `onclose`, so the failure is
never reported.

**(b) With a websocket available** (the same image with `ws` handed to `nostr-tools`, and the
source under Node 22, which behaved identically):

```
node v22.23.3 | relay source@1765503 | global WebSocket: function | patched: false
1. write "old" to A before B subscribes -> 200
2. B.subscribe(A) returned; isActive = true
3. B history after subscribe: [ 'old' ]
4. write "new" to A while subscribed -> 200
5. B history: [ 'new', 'old' ]
6. B live reader saw (opened before any gossip): []
7. write EPHEMERAL kind 20001 "eph" to A -> 200
8. A history kind 20001 (A must not persist it): []
9. B history kind 20001 (did the subscriber persist it?): [ 'eph' ]
10. direct write "local" to B /write -> 200
11. B live reader saw: [ 'local' ]
12. A restarted; write "after-restart" to A -> 200
13. A history: [ 'after-restart', 'new', 'old' ]
14. B history (did B reconnect and pick it up?): [ 'local', 'new', 'old' ]
15. sub.isActive() = true
```

Read against the source:

- **Lines 3 and 5: the pull works, history and live, for free.** No connector was running.
- **Line 6: a pulled event is not fanned out.** The subscriber calls `store()` and nothing else
  (R:`RelaySubscriber.ts:80`). The broadcast hook is wired only into the two write handlers
  (R:`relay.ts:779-795,808-814`). Line 11 shows the same reader does receive a direct write.
- **Line 9: the following relay persists an ephemeral event the origin refused to persist.** The
  write handler skips the store for kinds 20000 to 29999 (R:`write-handler.ts:186-189`); the
  subscriber has no such check.
- **Line 14: no reconnect.** `SimplePool` defaults `enableReconnect` to false (NT:`226,669`), so a
  closed connection closes its subscriptions (NT:`268-273`). `isActive()` reports a local flag
  that only `close()` clears (R:`relay.ts:499-511`).

**Three relays in a chain**, B following A and C following B, on the source under Node 22:

```
write "x" to A -> 200
A: [ 'x' ] | B: [ 'x' ] | C: []
after C opens a NEW subscription to B -> C: [ 'x' ]
write "y" to B (A and B now follow each other) -> 200
A: [ 'y', 'x' ] | B: [ 'y', 'x' ]
```

The event stops at B. C gets it only by asking B again, because a subscription is a `REQ` and a
`REQ` reads history once and then only what B broadcasts. Two relays following each other do not
loop, for the same reason.

## 7. Analysis (mine, not sourced)

**The verdict.** Pull-based gossip is the natural fit for this relay: reads are free, the store
accepts any signed event, and the function already exists. It costs no money per event. The
design's worry, that a relay copying an event must pay or be paid, does not arise unless someone
chooses to gossip by pushing paid writes. So the design survives this ticket. What does not
survive is any assumption that the relay does this today.

**The smallest change that makes one-hop gossip work**, all in `toon-protocol/relay`:

1. Give `nostr-tools` a websocket: call `useWebSocketImplementation` with `ws`, which is already a
   dependency, or move the image to Node 22. One line either way. Without it nothing else matters.
2. Reach `subscribe()` from deployment config: an environment variable or flag naming upstream
   URLs and a filter, read in `cli.ts` and applied after `startRelay`. A few dozen lines.
3. Reconnect. Construct the pool with `enableReconnect: true`; `nostr-tools` then re-sends the
   `REQ` with `since` set past the last event it delivered (NT:`309-320`). Report a closed
   upstream instead of leaving `isActive()` true.
4. Skip the store for ephemeral kinds in the subscriber, as the write handler does.

**What the design needs beyond one hop**, and each is a decision, not a bug fix:

- **Transitive gossip.** For A's event to reach C through B, B must fan out what it pulled. That
  needs `store()` to say whether the event was new, or mutually following relays will echo. The
  alternative is to decide gossip is one hop: an agent sees exactly the relays it follows. That is
  simpler and changes what "discovery" can find.
- **Dialling an HS address.** A per-agent relay behind a hidden service must reach other relays
  over the overlay. Either the relay takes a SOCKS-capable websocket (the pool accepts a
  `websocketImplementation`, but `createSubscription` gives no way to pass one), or the node runs
  a transparent proxy for the relay container as infra's sandbox does for hidden workloads
  (I:`sandbox/conf/anonrc-hs`, section 3). The pool's connection timeout defaults to 3 seconds
  (NT:`674,947`), which I expect is too short for a first circuit; I did not measure it.
- **Changing the follow set at runtime.** The relay has no operator surface. If the agent is the
  controller and decides whom to follow, it needs a way to add and drop upstreams without
  restarting the relay.
- **Catch-up.** There is no stored cursor. Every start re-reads the upstream's whole matching
  history, which the relay serves with no default `limit`. Fine for a small directory; it grows
  with the upstream.

**What free gossip does to the payment gate.** On a single relay, payment is the spam gate: an
event is stored only if someone paid for it at that relay's connector. A following relay has no
such gate. It stores whatever its upstream admitted, and the upstream admitted it for 1 µUSDC paid
to somebody else. The follower's only defences are its filter (kinds, authors), its choice of
upstream, and the signature check. If upstreams are themselves followers, the gate is the weakest
price anywhere upstream. This belongs with the map's "Trusting what gossip says".

It also moves the money. With pull gossip, the only paid relay write in the system is an author
writing to an origin relay. If every agent publishes to its own relay through its own node's
operator surface, which the map records as unpaid, then no relay write is paid at all, and the
relay's price matters only when a stranger writes to your relay.

**Cost of the paid alternative, for scale.** Push gossip means someone pays each relay. Using the
devnet's announce cadence of one refresh every 240 seconds (R:`relay.ts:145-148`), that is 360
writes a day per relay per announcer. At 1 µUSDC and no forwarding hop, keeping one announce alive
on 100 relays costs 36,000 µUSDC a day, about 0.036 USDC. Behind one forwarding hop at the
sandbox's fee of 100, each write costs 101 and the same job costs about 3.6 USDC a day. The fee,
not the price, is the number that decides it. Push also needs the payer to hold a channel or a
path to every relay it writes to, and it needs to know all of them first, which is the problem
gossip was meant to solve. And if the relaying node pays rather than the author, it is paying to
carry someone else's event with nothing coming back.

## 8. What I could not verify

- **The current `:release` image.** The image on this machine is relay `2.1.0` from 2026-08-28;
  the live devnet relay reports `2.2.0`. I did not pull the newer image. The claim that the
  shipped relay runs Node 20 rests on the Dockerfile at `1765503`, which still says
  `node:20-alpine`, and on the older image I ran.
- **Any real `.anyone` circuit.** I read infra's configs; I did not start the `hs` profile, dial
  the relay over the overlay, or time a connection. Whether infra's hidden-service smoke passes
  today is unknown to me.
- **Callers outside the relay repository.** `rig`, `swap`, `simulation` and `toon` import
  `@toon-protocol/relay`. I did not check whether any of them calls `subscribe()`.
- **Behaviour at volume.** The experiment moved a handful of events. I did not test a large
  upstream history, a slow upstream, or the pool's memory growth over a long subscription.
- **Fees on the devnet.** The fee of 100 is the sandbox's. I did not find or read a peering that
  forwards to a relay on the live devnet, so I cannot say what a forwarded relay write costs
  there.
- **The earlier notes.** `toon-in-hermes-ecosystem.md` §3.2 and
  `nostr-kinds-for-app-discovery.md` §2.5 are consistent with the source on price, carriage, NIPs
  and the refused websocket `EVENT`. Neither mentions `RelaySubscriber`. The second says "any kind
  is stored after a signature check", which is not true of ephemeral kinds on `POST /write`
  (R:`write-handler.ts:186-189`). I re-checked nothing else in them.

## 9. Sources

- `toon-protocol/relay` at `1765503`: `packages/relay/src/subscriber/RelaySubscriber.ts`,
  `launcher/relay.ts`, `launcher/cli.ts`, `launcher/handlers/write-handler.ts`,
  `launcher/handlers/write-ephemeral-handler.ts`, `launcher/handlers/payment-attribution.ts`,
  `websocket/ConnectionHandler.ts`, `websocket/NostrRelayServer.ts`,
  `storage/SqliteEventStore.ts`, `nips/relay-information.ts`, `types.ts`, `index.ts`;
  `packages/relay/Dockerfile`, `packages/relay/package.json`, `package.json`;
  `deploy/connector.toml`, `deploy/docker-compose.yml`, `deploy/Caddyfile`; `README.md`.
- `toon-protocol/connector` at `8b938f9b`: `CONTEXT.md`;
  `docs/adr/0006-the-connector-is-mechanism-not-policy.md`,
  `0020-a-price-is-flat-and-attaches-to-a-handler.md`,
  `0040-a-verified-payment-is-stated-to-the-app.md`,
  `0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md`; `local/README.md:54-58`
  (the connector's local topologies contain no relay).
- `toon-protocol/infra` at `b607340` (`issue-42-dealer`) and `origin/main@dcb4cb1`:
  `sandbox/conf/anonrc`, `sandbox/conf/anonrc-hs`, `sandbox/conf/provider-hs.toml`,
  `sandbox/conf/connector-relay.toml`, `sandbox/docker-compose.yml`,
  `sandbox/scripts/peerings.mjs`.
- `nostr-tools@2.23.1`, `lib/esm/pool.js`.
- Live, 2026-10-01: `curl -H 'Accept: application/nostr+json' https://relay-ws.devnet.toonprotocol.dev/`.
- Image `ghcr.io/toon-protocol/relay:release` at digest `2c628e86b05c`.
