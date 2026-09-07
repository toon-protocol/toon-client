---
status: accepted
---

# The managed `anon` daemon lives in the CLI, never in the library

Reaching a hidden-service connector needs a running `anon` daemon and a `socks5h://` port. We
decided that `@toon-protocol/client` **never** downloads or spawns that daemon: the library accepts
a `socksProxy` URL and nothing more, while the `toon` CLI may download a pinned `anon` release,
verify its checksum, and spawn it on the user's behalf. A library that an application embeds must
not fetch and execute a binary at runtime — that is a supply-chain decision belonging to whoever
chose to run our executable, not to every downstream consumer of a dependency.

## Considered options

An earlier version of this package did the opposite: `transport/anon-proxy.ts` (473 lines, removed
in `fed33cb`) downloaded, checksum-gated, extracted and spawned `anon` from inside the library, so
that `ToonClient.create()` alone could reach a `.anyone` address with zero setup. It is genuinely
more convenient, and that convenience is why it was written. It is not worth the blast radius.

## Consequences

- `ToonClient` throws, rather than helping, when handed an HS connector with no `socksProxy`. The
  error names the missing proxy and how to start one.
- The download-and-verify code now has exactly one caller, so it is tested through the CLI or not
  at all.
- The pinned release (`v0.4.10.2`, channel `live`) and its per-platform checksums live in the CLI.
  A platform whose checksum is unpinned refuses to download rather than skipping verification.
