---
'@toon-protocol/client': patch
---

Replay the connector's new `charge` vectors, and saturate `chargeFor` at `u64::MAX` as the connector does. The vector set gains a section that pins arithmetic rather than bytes — what a route priced `base + per_kib/KiB` charges for a packet whose sealed payload is a given length — because that rule binds this client, `rig` and `swap` exactly as an encoding does, and prose alone was what let `chargeFor` drift to `floor(len / 1024) + 1` in the first place. The saturation is the one behaviour change: a `bigint` does not overflow, so nothing previously stopped this client computing a charge above `u64::MAX`, which is both more than the connector would charge and too wide to encode into the packet it is paying for. Reverting `chargeFor` to the old formula now fails three vector rows — the empty payload, 1024 bytes and 2048 bytes — and nothing else, which is exactly the set the old suite could not see.
