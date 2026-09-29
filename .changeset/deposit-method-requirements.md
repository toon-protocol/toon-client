---
'@toon-protocol/client': patch
---

A Base deposit whose `depositMethod` overrides the connector's `assetTransferMethod` now tells the facilitator the method it actually signed. Before, a Permit2 deposit to a connector publishing `eip3009` sent requirements saying `eip3009`, and the facilitator refused it with `invalid_batch_settlement_evm_erc3009_authorization_required`.
