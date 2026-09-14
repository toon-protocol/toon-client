# Reaching a connector that is a hidden service

A connector is ordinarily a clearnet host: `https://proxy.ario.devnet.toonprotocol.dev`. It can
also be a **hidden service** — a node reachable only inside the [Anyone
Protocol](https://github.com/anyone-protocol) overlay, at a `.anyone` address that public DNS
cannot resolve and no certificate authority can certify.

Paying such a node needs one extra thing: a running `anon` daemon, and its SOCKS5h port.

```text
  you ──► anon (SOCKS5h) ──► the overlay ──► connector.anyone ──► app
              ▲
              └── chain RPC goes here too, not around it
```

Nothing else changes. Sealing, pricing, claims, channels and refusals are identical — the packet
does not know what carried it.

## From the CLI

Nothing, if you let it: point `toon` at a `.anyone` address and it starts a daemon for you.

```bash
export TOON_CONNECTOR=http://<address>.anyone
npx toon describe
```

```text
toon: http://<address>.anyone is a hidden service; starting a local anon daemon
toon: downloading anon-live-linux-amd64.zip (v0.4.10.2)…
toon: verified; extracting
toon: starting anon v0.4.10.2 on 127.0.0.1:41337 (…/anon)
toon: anon is listening; building circuits on demand
toon: proxying through socks5h://127.0.0.1:41337
```

Every line of that goes to **stderr**, never stdout, so `--json` output stays exactly one
parseable document.

Already running your own daemon? Name it, and nothing is downloaded and no process is spawned:

```bash
npx toon send --socks socks5h://127.0.0.1:9050 --body 'hello'
export TOON_SOCKS=socks5h://127.0.0.1:9050     # same thing, for every command
```

`--socks` beats `TOON_SOCKS`, which beats the default — the same flag-then-environment order as
every other setting in this CLI. A clearnet connector starts no daemon and downloads nothing.

### The managed daemon, in detail

An operator is entitled to know what would run on their machine.

| | |
| --- | --- |
| Release | **`v0.4.10.2`**, pinned. |
| Channel | **`live`** — the stable channel. There are newer `-beta` tags; you are not shipped one. |
| Platforms | `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`. |
| Verification | sha256 against a checksum recorded in this repository, checked **before** the binary is ever executed. A platform with no pinned checksum is **refused**, not downloaded and trusted. |
| Cache | `$XDG_CACHE_HOME/toon/anon/<version>/`, falling back to `~/.toon/anon/<version>/`. Keyed by version, so a new pin never silently reuses an old binary and only the first run pays the download. |
| Also required | `unzip` on PATH (macOS/Linux), or PowerShell's `Expand-Archive` (Windows). |
| Port | An ephemeral loopback port, chosen per run. |
| Bootstrap | Up to 90 s for the SOCKS port to open. |
| Lifetime | Stopped when the command ends. Nothing outlives the command that started it. |

If your platform is not on that list, or the machine has no outbound access to fetch a release,
the escape hatch is the same one an operator with their own daemon uses: run `anon` yourself and
pass `--socks` / `TOON_SOCKS`. The CLI then downloads nothing.

## From the library

The library never starts a daemon — see
[ADR 0001](adr/0001-managed-anon-daemon-lives-in-the-cli.md). A library an application embeds must
not fetch and execute a binary at runtime. Give it a proxy instead:

```ts
import { ToonClient } from '@toon-protocol/client';

const client = await ToonClient.create({
  connector: 'http://<address>.anyone',
  socksProxy: 'socks5h://127.0.0.1:9050',
  mnemonic: process.env.TOON_MNEMONIC,
});

const answer = await client.send('g.toon.hs.echo', { body: 'hello' });
```

That is the whole difference. The transport is built during construction, **before** the first
`GET` of the self-description — asking a node what it is must not be the request that exposes the
asking. `close()` releases the proxy's sockets, so the process still exits.

For a transport you wire yourself, the factory is its own Node-only entry point. It is
deliberately **not** exported from the package root:

```ts
import { createHiddenServiceTransport } from '@toon-protocol/client/hidden-service';

const hs = createHiddenServiceTransport('socks5h://127.0.0.1:9050');
// hs.fetch, hs.createWebSocket, hs.dispatcher — then hs.close() when done.
```

The browser-safe pieces — `isRoutableHsHostname`, `isHiddenServiceUrl`,
`assertRoutableHsHostname`, `validateSocks5hUrl`, `rpcFetch`, `rpcTransport` — are exported from
the package root, because config validation needs them and they touch no Node built-in.

An explicitly injected `fetch` or `createWebSocket` still wins over the proxy's. A caller who
supplied their own has said something specific about how bytes leave their process, and that is
never silently overridden.

## What else changes

**Your chain RPC moves too.** By default, `socksProxy` carries the EVM and Solana JSON-RPC as well
as the packets — channel opens, deposits, closes, settles, wallet balance reads and wallet
transfers, on both chains. This is deliberate and it is the point: reaching the connector inside
the overlay while reading chain state on clearnet would broadcast your settlement address, from
your own IP, timed either side of every paid request — see
[ADR 0002](adr/0002-chain-rpc-is-proxied-with-the-connector.md). Opt out only when the RPC endpoint
is already private:

```ts
await ToonClient.create({ connector, socksProxy, proxyRpc: false }); // e.g. your own node on loopback
```

`proxyRpc: false` opts **chain RPC out, and nothing else**. The client edge and the BTP socket keep
riding the proxy: a hidden-service connector is still a hidden-service connector, and there is no
setting that makes it reachable without one.

**Timeouts get longer.** The per-packet default rises from 30 s to **120 s**, because building a
circuit to a cold hidden service can take tens of seconds before the connector sees a byte. Set
`timeoutMs` yourself to override it. The SOCKS connect timeout is raised well above the `socks`
library's own default for the same reason — a short one turns "slow" into "unreachable", an error
indistinguishable from a wrong address.

**Packets outlive your patience.** A packet's expiry is set 15 s beyond the client's own timeout,
so the client always gives up first. Without that margin a slow answer arrives after the packet
has expired — and it expires under a claim you already signed, which costs money for nothing. This
was a latent defect on every carriage, clearnet included; the fix is not specific to hidden
services. An `expiresAt` you name yourself is honoured exactly, neither extended nor clamped.

**Plain `http://` is correct here.** No CA can issue a certificate for `.anyone`, and the overlay
authenticates the endpoint itself, so an HS connector is addressed over `http://` and this client
accepts that for `.anyone` hosts.

**What a node advertises cannot redirect you.** The connector URL you configured stays
authoritative for reachability. An endpoint resolved from the self-description is checked before
anything dials it, and one naming a hidden service this client has no proxy for is refused with
the missing proxy named — rather than falling through to a DNS lookup.

## Addresses that look right and are not

| You wrote | What happens |
| --- | --- |
| `<addr>.anyone` | Routed. This is the only hidden-service TLD `anon` resolves. |
| `<addr>.anon` | **Refused, with the corrected address in the message.** `anon` treats `.anon` as a clearnet name and fails with `HostUnreachable` deep in the transport, far from the typo. |
| `<addr>.onion` | **Refused.** That is Tor. This client dials the Anyone Protocol and cannot reach it. |
| `socks5://…` | **Refused.** The missing `h` means *your* machine resolves the hostname — putting the hidden service you are about to talk to into a plaintext DNS query. |

Two more refusals, both at construction time, before anything dials:

- A `.anyone` connector with **no** `socksProxy` — unreachable, and the attempt would leak the
  address to a resolver first. The message names the proxy to set, and that the `toon` CLI can
  start a daemon for you.
- A `socksProxy` with a **clearnet** connector — nothing would ride the proxy, and believing
  otherwise is worse than knowing.

And one check before the first packet rather than at construction: the client probes the proxy
port and fails, naming the daemon, if nothing is listening. Discovering that later would cost a
signed claim.

## Browsers

There is no browser story, and there is not going to be a pretend one. **A browser cannot reach a
hidden service by any route.** It cannot open a SOCKS connection, so it cannot dial `.anyone` at
all — there is no flag, no polyfill and no configuration that changes this. Stop looking for a
workaround; there is not one to find.

The transport itself is kept out of the way of a bundler regardless: the SOCKS factory is a
separate entry point that a browser bundle never follows, and the address validation and
`socks5h://` parsing the package root does export are pure. (The package root is not itself
browser-clean today — the Node keystore pulls `node:crypto` and `node:fs` in — but that predates
this feature and no part of it made things worse.)

## Requirements

- Node ≥ 22.
- The optional dependencies `undici` and `socks`, installed automatically unless you disabled
  optional dependencies, loaded through a guarded dynamic `require` and never bundled. `ws` too,
  if you use the BTP carriage.
  `undici` is pinned to **`^7`** on purpose. Node's global `fetch` hands a userland dispatcher a
  handler defined by Node's *own* bundled undici; undici 8 dropped the shape Node 22 passes, and
  this package's `engines.node` is `>=22`. `^8` is not an upgrade here.
- `unzip`, or PowerShell on Windows — only for the CLI's managed daemon.

## Not covered here

- **Tor.** `.onion` addresses are refused, by name. Supporting a second overlay would be a
  separate decision, and it has not been made.
- **Any browser path**, including a server-side gateway proxying on a browser's behalf. One
  existed in an earlier version of this package and is not being revived.
- **A published devnet `.anyone` node.** None is deployed — that is a connector-side deployment,
  not a gap in this client. See [devnet.md](devnet.md#hidden-services).
- **Hiding you from the connector.** The overlay conceals your network location from observers;
  the connector still sees a claim carrying your settlement address, as it must in order to be
  paid.
