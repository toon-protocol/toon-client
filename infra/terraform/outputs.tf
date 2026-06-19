output "instance_ip" {
  description = "Public IPv4 of the headless client host. Consumed by the deploy workflow for SSH."
  value       = linode_instance.client.ip_address
}

output "instance_id" {
  description = "Linode instance id."
  value       = linode_instance.client.id
}

output "volume_id" {
  description = "Block Storage volume id (the durable wallet/keystore root — snapshot before destroy)."
  value       = linode_volume.client_data.id
}
