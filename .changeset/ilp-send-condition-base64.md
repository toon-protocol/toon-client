---
'@toon-protocol/client': patch
---

Accept an execution condition in the base64 form `@toon-protocol/core`'s `IlpClient` port now declares, restoring the only CI job that can see dependency drift.

`IlpSendParams` (toon-client#350) extended core's `IlpClient` param shape with a sender-chosen `executionCondition`, typed as the raw `Uint8Array` the rest of the condition subsystem deals in. Core 3.4.0 — pulled in by `@toon-protocol/sdk@3.1.8`, which pins it exactly — then added a field of the same name to that port, typed as a base64 `string`. Neither type is assignable to the other, so the two transports stopped satisfying `IlpClient` and `ToonClient`'s `runtimeClient` assignment failed to compile.

Core's split is deliberate rather than a mistake to paper over: its in-process `SendPacketParams.executionCondition` is `Uint8Array`, annotated "not base64 string", while the JSON-shaped `IlpClient` wire port carries base64. `IlpSendParams.executionCondition` therefore now accepts `Uint8Array | string` and normalizes through a new exported `resolveExecutionCondition` at both transports — exactly the shape `expiresAt`/`resolveExpiresAt` already took when core 2.1.0's `IlpClient` started passing an ISO string for a field this package held as a `Date`. Bytes stay the native form: senders in this package keep passing what `mintExecutionCondition` mints, and length validation stays at the transports so a malformed condition fails identically whichever representation it arrived in.

Only `Devbox Environment Validation` installs with `--no-frozen-lockfile`, so it alone re-resolved to the new sdk and went red on 2026-08-15 while every lockfile-pinned job stayed green. The lockfile now moves forward to sdk 3.1.8 / core 3.4.0 and the declared ranges match, so the pinned jobs compile against what devbox resolves instead of hiding the break.
