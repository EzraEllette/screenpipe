# Screenpipe tsnet sidecar

This sidecar gives every online Screenpipe device a private device-mesh endpoint
without binding Screenpipe itself to a LAN interface or copying captured data to
the cloud. The transport is powered by Tailscale's userspace networking, but
identity and enrollment belong to the user's Screenpipe account. Users never
create or sign in to a Tailscale account.

It exposes two transport surfaces, but clients only use Screenpipe's main API:

- `:3030` inside the embedded tailnet: a read-only proxy to that device's local
  Screenpipe API. The device's local API key is injected by the sidecar and is
  never sent to other devices.
- `127.0.0.1:3031`: an internal authenticated coordinator that discovers
  sibling `screenpipe-*` tsnet nodes and fans a GET out to all of them. The main
  Screenpipe API proxies it, so this port is not shared with clients.

## Run on every Screenpipe device

Build the sidecar with Go 1.26.6 or newer:

```bash
go build -o screenpipe-tsnet .
export SCREENPIPE_LOCAL_API_KEY="$(screenpipe auth token)"
./screenpipe-tsnet
```

On first run the sidecar asks the authenticated local Screenpipe API for a
short-lived, one-use node credential. The backend creates a Tailscale API-only
tailnet for that Screenpipe account and stores its OAuth credentials encrypted.
Every device signed in to that Screenpipe account joins the same tailnet; no
other account shares it. tsnet retains only its node state in
`~/.screenpipe/tsnet`.

There is no interactive login fallback, and ambient Tailscale enrollment
environment variables are explicitly ignored. Users never need a Tailscale
account, client, auth key, or VPN configuration. The sidecar never enables
Funnel.

## Backend setup

Create a Tailscale organization OAuth client with the `tailnets` scope. Store
its client ID and secret only in the Screenpipe API Worker, together with two
independent random keys:

```bash
openssl rand -base64 32 | bunx wrangler secret put MESH_NAMESPACE_SECRET
openssl rand -base64 32 | bunx wrangler secret put MESH_CREDENTIAL_ENCRYPTION_KEY
bunx wrangler secret put TAILSCALE_ORGANIZATION
bunx wrangler secret put TAILSCALE_OAUTH_CLIENT_ID
bunx wrangler secret put TAILSCALE_OAUTH_CLIENT_SECRET
```

Apply `packages/ai-gateway/migrations/0009_tailscale_mesh_tailnets.sql` before
enabling enrollment. Tailscale currently marks API-only tailnet creation as
alpha and requires an organization quota large enough for one tailnet per
Screenpipe account.

## Query every online device

```bash
export SCREENPIPE_LOCAL_API_KEY="$(screenpipe auth token)"

curl -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
  http://127.0.0.1:3030/v1/devices

curl -X POST http://127.0.0.1:3030/v1/query \
  -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"/search?q=screenpipe&start_time=1d%20ago&limit=10"}'
```

The response keeps each device's status and body separate. Devices that the
mesh reports offline are omitted. If the mesh reports a device online but
its sidecar or Screenpipe API cannot be reached, that device has an explicit
per-device error. The sidecar does not fall back to cloud data.

Only `GET`, `HEAD`, and `OPTIONS` reach a remote Screenpipe API. The coordinator
accepts `POST /v1/query` only as a local fan-out instruction; the request it
sends to each device is always a `GET`.
