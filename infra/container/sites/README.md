# One Caddy file per household

`ops/household.sh add <ssh-host> <name> <domain>` writes these on the host.
They look like:

```
aline.chezmaurice.eu {
	reverse_proxy maurice-aline:3001 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
	request_body {
		max_size 512MB
	}
	encode gzip
}
```

The name in the block is the public one; `maurice-<name>` is the container,
reachable only on the `maurice-edge` network — no household publishes a port.
This directory is mounted read-only into Caddy, which re-reads it on
`caddy reload`, so adding a household never restarts the others.

The directory is empty in the repository on purpose: who lives on a host is
the host's business, not the source tree's.
