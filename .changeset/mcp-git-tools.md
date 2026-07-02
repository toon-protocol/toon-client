---
'@toon-protocol/client-mcp': minor
---

`toon_git_*` MCP tools over the daemon `/git/*` routes (#230, epic #222).

The Rig write path is now agent-drivable from any MCP host:

- **`toon_git_push`** `{repoPath, repoId?, refspecs?, force?, relayUrls?,
  dry_run?, confirm?}` — two-step by construction: `dry_run: true` hits
  `/git/estimate` only (free) and returns the itemized plan (ref updates +
  per-object/event fee table); a real push REQUIRES `confirm: true` and is
  refused otherwise. The tool description mandates quoting
  `estimate.totalFee` from a dry_run and getting explicit user confirmation
  first — pushes are permanent and non-refundable. `repoId` defaults to the
  basename of `repoPath`. Text responses compact the per-object manifest to
  counts; the full plan/receipts ride `structuredContent`.
- **`toon_git_issue` / `toon_git_comment` / `toon_git_patch` /
  `toon_git_status`** — single paid event publishes (kind:1621/1622/1617/
  1630-1633) taking flattened `repoOwnerPubkey`+`repoId`; descriptions carry
  the per-event fee-quoting + confirmation policy matching toon_publish.
- **Structured errors surfaced as compact JSON**: `non_fast_forward` includes
  the rejected `refs` and a force-after-user-confirmation hint;
  `oversize_objects` lists the offending paths/sizes and references the paid
  blob-storage follow-up (#235); funding (402) remediation passes through
  verbatim.
- All five tools are annotated as paid/destructive writes, and the server
  `instructions` extend the paid-write confirmation policy to them.
