---
"@toon-protocol/client": patch
---

Fall back to BTP when a claim-bearing ILP-over-HTTP write comes back `401 Unauthorized` (issue #565). The rust connector generation now live on the two-box devnet fleet rejects a discovered/unconfigured peer identity with a bare `401` instead of the `402` x402 greeting #561's fallback handled, so `sendClaimBearingPacket` never retried onto the already-negotiated BTP session and every paid write died with `ConnectorError`. `HttpIlpClient` now maps a 401 to a new `Http401RequiresBtpError`, and `ToonClient.sendClaimBearingPacket` retries it over `state.btpClient` the same way it already does for `Http402RequiresBtpError`, throwing the same `BTP_REQUIRED` error when no BTP uplink is configured. The 402-based fallback is untouched, so a fleet whose HTTP edge still answers the 402 greeting keeps working unchanged.
