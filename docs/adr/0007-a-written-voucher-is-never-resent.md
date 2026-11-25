---
status: accepted
---

# A written voucher is never resent; a lost answer is unknown plus doubt

The carriage sends a packet again only when none of it was written. That means a dial or connect
failure, or a socket that was not open when the packet was about to go out. Such failures are
retried within one budget: `btp.maxReconnectAttempts` more tries (default 1), spaced by
`btp.reconnectDelay` (default 250 ms). Once the budget runs out, a BTP packet may fall back to HTTP,
but only where the route does not require BTP and an HTTP endpoint is published or overridden
(ADR 0006). A packet that was written and whose answer was lost is never resent, on either carriage.
The carriage returns `unknown`. `send()` settles the voucher as unknown, the payer marks the
channel in doubt in the channel record, and the next voucher on that channel resyncs against the
connector (`POST /ilp/claim-state`) before it is signed. `send()` then throws the same
`NetworkError` as before, so CLI exit codes do not change.

Whether anything was written is a fact the adapter records at the step where it happens. The BTP
session throws `NothingWritten` from its connect step, and when the socket is not open just before
the frame goes out. It never reads that fact back from an error message. `fetch` does not say how
much of a request left before it failed, so every HTTP failure counts as written.

The rule lives in one place, the carriage module. `BtpRuntimeClient`, `BtpPaidWriteTransport` and
`HttpIlpClient` each send once. A BTP retry or fallback runs inside one slot of the session's
ordered queue, so it reorders nothing queued behind it.

## Why a written voucher is never resent

A voucher states a channel's cumulative total, and the connector orders vouchers by amount alone.
An answer can be lost after the connector banked the voucher: the packet timed out after its frame
was written, or the socket dropped while the answer was on its way. Resending the same voucher
then gains nothing. If the connector banked it, the resend is refused as not advancing. If it did
not, the resend tells the payer nothing it could not learn by asking. Each resend also makes the
app behind the connector do the work again. The old layers made it worse. They treated any error
whose message contained "timeout" as a connection error worth retrying, and the BTP socket's packet
timeout fires after the frame was written. With the defaults, one voucher could go out up to 8 times
over BTP (`BtpRuntimeClient`'s 4 attempts inside `BtpPaidWriteTransport`'s 2 passes), plus up to 4
POSTs over the HTTP fallback (`withRetry`, which retried a request timeout too). With
`btp.maxReconnectAttempts = N`, the BTP count was (N+1)², because both layers read N. This rule
replaces all of that with one send.

## Why a lost answer is unknown plus doubt

The payer cannot tell a banked voucher from a lost one. Counting it as banked overpays the next
voucher if it was not. Giving it back underpays the next one if it was, and the connector refuses
that. Marking the channel in doubt hands the question to the one party that knows: the next voucher
asks the connector for its watermark first and adopts it, clamped by what the payer is proven to
hold and what it ever signed. The doubt is stored in the channel record, not in memory, so it holds
across processes and across clients that share one store. A connector that cannot answer
`claim-state` leaves the doubt in place and the local count as it was, which is what happened
before.

## Considered options

- **Keep retrying a timeout, but only once.** Rejected: one resend of a written voucher is still a
  resend, and it does not answer whether the first was banked.
- **Resend over HTTP after a BTP timeout.** Rejected: the voucher may already be banked, and the
  fallback exists for a carriage that could not be reached, not for one that went quiet.
- **Read "nothing written" from error messages or socket codes.** Rejected: a message is not a
  contract. "timeout" is how the old layers came to resend written vouchers.
- **Settle a lost answer as banked and move on.** Rejected: an unbanked voucher then makes every
  later voucher overpay by its charge, and nothing ever corrects it.

## Consequences

- A slow connector sees each voucher once.
- An HTTP carriage does not retry a failed connect. Only BTP can tell a failed connect apart from a
  failed write.
- The carriage's `unknown` outcome carries `written`. `send()` treats both cases alike: a voucher
  that was never written is settled unknown too, and the resync gives back the charge the connector
  never saw.
- `BtpRuntimeClientConfig.maxRetries`/`retryDelay`, `HttpIlpClientConfig.maxRetries`/`retryDelay`
  and `BtpPaidWriteTransportConfig.fallback`/`maxReconnectAttempts`/`reconnectDelay` are removed.
  `btp.maxReconnectAttempts` and `btp.reconnectDelay` on the client config are the budget.
