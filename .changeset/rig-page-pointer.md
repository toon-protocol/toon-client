---
"@toon-protocol/rig": minor
---

rig push: every push keeps the repo's Rig page current — a permanent per-repo Arweave pointer that opens the repo in the Rig (rig-web), the repo's GitHub-Pages equivalent served from any ar.io gateway.

- The pointer is a tiny self-contained redirect shell (`src/rig-pointer.ts`): its txId is the repo's permanent Rig-page URL; opening it forwards to the current rig-web deployment with the repo route + relay in the URL hash (rig-web's HashRouter + fragment relay resolution). Redirect — not boot-in-place — is deliberate while the canonical rig-web bundle is not yet on Arweave (Pages asset hashes churn per deploy; the origin + hash-route contract are stable). Stage 2 flips generation to the boot-in-place shell (`rig-web/src/web/rig-pointer-html.ts`) once an immutable bundle txId / ArNS name exists; `RIG_WEB_URL` overrides the base today.
- Content-addressed: the pointer HTML is deterministic for (rig-web URL, relay, owner, repoId) and recorded locally (`rig-pointers.json`), so it is paid for once and reused free until an input changes. Its fee is part of the confirmed push total; `--no-rig-page` skips it; a pointer failure never fails a succeeded push (the next push retries). Printed as `Rig page: <ar.io-gateway>/<txId>`; the `--json` envelope carries a `rigPage` report. Daemon-path pushes skip with a note (no raw-blob route yet).
- Test-harness hardening: the strict-json `run()` helper now defaults to a hermetic `TOON_CLIENT_HOME` — an empty env let command tests write local record stores into the developer's real `~/.toon-client`.
