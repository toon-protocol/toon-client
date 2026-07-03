---
'@toon-protocol/rig': patch
---

Handle empty (zero-byte) git blobs. `rig push` previously failed on any repo
containing an empty file because it uploaded the zero-byte blob body as a
kind:5094 request with an empty `i` value, which the store rejects as malformed
(F00). The git empty blob (`e69de29b…`, the only zero-byte object git can
produce) is now skipped on push — its commit/tree still references it — and
synthesized locally on clone/fetch, so a repo with an empty file pushes and
clones back bit-identically (git fsck clean). Fee estimates and receipts report
the skip honestly. Closes #310.
