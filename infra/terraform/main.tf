# Headless TOON client — Linode (Akamai Connected Cloud) infrastructure.
#
# Provisions one egress-only VPS + a persistent Block Storage volume. The box runs the
# `toon-clientd` daemon (always-on) and a headless mcp-use agent (the journey runner)
# that drives the SocialFi + DeFi journey against a live apex hub. As a pure consumer it
# needs NO inbound ports — only outbound to the hub's BTP/relay (or .anon in Phase 2).
#
# Auth: Linode API token from the LINODE_TOKEN environment variable.
# State: Linode Object Storage (S3-compatible); dynamic settings via -backend-config.

terraform {
  required_version = ">= 1.6"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.13"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "linode" {
  # token sourced from LINODE_TOKEN
}

resource "random_password" "root" {
  length  = 32
  special = true
}
