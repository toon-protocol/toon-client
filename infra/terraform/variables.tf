variable "label" {
  description = "Name prefix for the Linode instance, volume, and firewall."
  type        = string
  default     = "toon-headless-client"
}

variable "region" {
  description = "Linode region (must support Metadata/cloud-init + Block Storage)."
  type        = string
  default     = "us-ord"
}

variable "instance_type" {
  description = "Linode plan. g6-standard-1 = 2GB/1vCPU (fits toon-clientd + the Node agent). Bump if the agent loop is heavy."
  type        = string
  default     = "g6-standard-1"
}

variable "volume_size" {
  description = "Persistent Block Storage volume (GiB). Holds the client config.json, the encrypted keystore, and payment-channel nonce watermarks."
  type        = number
  default     = 20
}

variable "client_version" {
  description = "Pinned @toon-protocol/client-mcp npm version installed on the box. Keep in sync with infra/client-version.txt."
  type        = string
  default     = "0.1.0"
}

variable "ssh_pubkey" {
  description = "Public half of the CI deploy key (CLIENT_SSH_KEY). Installed for the 'deploy' user via cloud-init."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to reach SSH (port 22). Restrict to CI egress / operator IP. There are NO other inbound ports — this is a pure outbound client."
  type        = string
}
