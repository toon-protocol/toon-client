---
'@toon-protocol/client': minor
---

`ToonClient.create` accepts `carriageEndpoints: { http?, btp? }` to replace the carriage endpoint a connector publishes, per carriage (ADR 0006). The CLI gains `--http-endpoint` / `--btp-endpoint` (`TOON_HTTP_ENDPOINT` / `TOON_BTP_ENDPOINT`), and `toon-client describe` labels an override in effect.
