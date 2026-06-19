# Egress-only. This box is a pure consumer: it dials the apex hub's BTP/relay (or its
# .anon hidden service in Phase 2) outbound, and serves nothing. The only inbound rule
# is SSH for deploys/ops, restricted to a CIDR. The toon-clientd HTTP control API binds
# loopback (127.0.0.1) only and is never exposed.

resource "linode_firewall" "client" {
  label           = "${var.label}-fw"
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.client.id]
  tags            = ["toon", "client"]

  inbound {
    label    = "allow-ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = [var.allowed_ssh_cidr]
  }
}
