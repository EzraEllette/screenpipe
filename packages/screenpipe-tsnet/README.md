# Screenpipe tsnet sidecar

This sidecar gives every online Screenpipe device a private tailnet endpoint
without binding Screenpipe itself to a LAN interface or copying captured data to
the cloud.

It exposes two surfaces:

- `:3030` inside the embedded tailnet: a read-only proxy to that device's local
  Screenpipe API. The device's local API key is injected by the sidecar and is
  never sent to other devices.
- `127.0.0.1:3031`: an authenticated coordinator that discovers sibling
  `screenpipe-*` tsnet nodes and fans a GET out to all of them.

## Run on every Screenpipe device

Build the sidecar with Go 1.26.6 or newer:

```bash
go build -o screenpipe-tsnet .
export SCREENPIPE_LOCAL_API_KEY="$(screenpipe auth token)"
./screenpipe-tsnet
```

The first run prints a Tailscale login URL. Open it once for each device. The
node identity is then retained in `~/.screenpipe/tsnet`. For unattended setup,
pass a reusable or ephemeral Tailscale auth key in `TS_AUTHKEY`; the auth key is
not persisted by Screenpipe.

Use Tailscale ACLs to restrict which users or tagged nodes may reach the
`screenpipe-*` nodes on TCP port 3030. The sidecar never enables Funnel.

## Query every online device

```bash
export SCREENPIPE_LOCAL_API_KEY="$(screenpipe auth token)"

curl -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
  http://127.0.0.1:3031/v1/devices

curl -X POST http://127.0.0.1:3031/v1/query \
  -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/search?q=screenpipe&start_time=1d%20ago&limit=10"}'
```

The response keeps each device's status and body separate. Devices that
Tailscale reports offline are omitted. If Tailscale reports a device online but
its sidecar or Screenpipe API cannot be reached, that device has an explicit
per-device error. The sidecar does not fall back to cloud data.

Only `GET`, `HEAD`, and `OPTIONS` reach a remote Screenpipe API. The coordinator
accepts `POST /v1/query` only as a local fan-out instruction; the request it
sends to each device is always a `GET`.
