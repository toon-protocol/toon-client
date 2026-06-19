# The headless client host. Ubuntu 24.04 + cloud-init that installs Node 20, the pinned
# client-mcp CLI (toon-clientd/toon-mcp bins), and the systemd units. The wallet/keystore
# is NOT created here — an operator imports/initializes it once on the box so the seed
# never lives in Terraform state or CI (see docs/deploy-linode-client.md).

resource "linode_instance" "client" {
  label           = var.label
  region          = var.region
  type            = var.instance_type
  image           = "linode/ubuntu24.04"
  root_pass       = random_password.root.result
  authorized_keys = [trimspace(var.ssh_pubkey)]
  tags            = ["toon", "client", "headless"]

  metadata {
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      ssh_pubkey     = trimspace(var.ssh_pubkey)
      client_version = var.client_version
      volume_label   = local.volume_label
    }))
  }
}

locals {
  volume_label = "${var.label}-data"
}
