---
'@toon-protocol/client': patch
---

A `NetworkError` raised while delivering a packet now names the URL it tried to reach — the HTTP `POST /ilp` endpoint or the BTP `ws(s)://` URL — and says when the connector published it in its self-description. The original error stays as `cause`, the `code` is unchanged, and the URL is also on `NetworkError.endpoint`.
