---
'@toon-protocol/client': major
---

The channel store keeps one record per channel, and every method is required. `ChannelStore` is now `save(entry)`, `load(channelId)`, `find(connector, network, asset)`, `list()` and `delete(channelId)`; the optional binding methods are gone, and `find` replaces the scan over bindings. `ChannelStoreEntry` holds the x402 config, deposit, watermark, last voucher and exit timestamps, and `batchSettlement` is required. Removed: `ChannelBinding`, `ChannelBindingContext` and `ChannelStoreEntry.nonce`. `BatchChannelManager.bindingKey` is gone. `channels.json` and `channels.peers.json` from earlier releases load: the peers file is joined into `channels.json` on first use and renamed `channels.peers.json.migrated`, and `cumulativeAmount` stays under each channel id, where rig reads it.
