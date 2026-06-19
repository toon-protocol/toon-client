# Persistent Block Storage volume — the durable root of the client's identity.
# cloud-init formats it on first boot (only if blank) and mounts it at /mnt/toon-client.
# Holds config.json, the encrypted keystore, and channel nonce watermarks, so the
# client's Nostr/chain identity and payment-channel state survive instance rebuilds.
#
# Snapshot this volume before destroying anything — it is the client's wallet root.

resource "linode_volume" "client_data" {
  label     = local.volume_label
  region    = var.region
  size      = var.volume_size
  linode_id = linode_instance.client.id
  tags      = ["toon", "client"]
}
