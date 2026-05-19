---
name: screenpipe-team
description: Query the org's screenpipe telemetry as an enterprise admin — devices, members, recent activity, and substring search across the team's screen recordings and audio transcripts. Use when the user asks about their team, a teammate's activity, what their organization worked on, app usage across the org, or anything that requires seeing data beyond the user's own machine. The skill is only installed for enterprise admins; ordinary users won't see it.
---

# Screenpipe Team

Query the customer's team telemetry. Data lives in the customer's own Azure Blob (or our R2 bucket for hosted ingest). All reads transit our control plane today (`https://screenpi.pe/api/enterprise/v1/*`) which checks the bearer's admin role and returns matched records. The model (you) is the user's own local pi-agent — your prompts and the user's chat never leave their machine.

## Auth

Two pieces, both already on disk after the admin signs in to screenpipe cloud — no separate token to mint or paste:

- **Cloud session JWT** from `~/.screenpipe/auth.json` (`.token`). This is a long-lasting Clerk JWT minted by the screenpipe-cloud sign-in flow (`getToken({template:"long-lasting"})`); the v1 endpoints validate it via Clerk and check the user's email against the license's `admin_emails`.
- **License key** from `~/.screenpipe/enterprise.json` (`.license_key`). Tells the server which org the admin wants to query (one user can admin multiple licenses).

```bash
CLOUD_TOKEN=$(jq -r .token ~/.screenpipe/auth.json)
LICENSE_KEY=$(jq -r .license_key ~/.screenpipe/enterprise.json)
SP_URL="https://screenpi.pe/api/enterprise/v1"
AUTH_HEADERS=(-H "Authorization: Bearer $CLOUD_TOKEN" -H "X-License-Key: $LICENSE_KEY")
```

If `CLOUD_TOKEN` doesn't start with `eyJ` (real Clerk JWT prefix — anything shorter like `sp-…` is leftover from an older auth scheme) OR if the v1 endpoints return **401 invalid bearer token**: tell the user verbatim:

> Your screenpipe cloud session looks stale (auth.json doesn't have a
> current Clerk JWT). Sign out and sign back into screenpipe cloud
> from the desktop app — that re-mints a long-lasting token, and the
> team skill works automatically afterward.

If the server returns **403** ("not an admin of this license"): tell the user "you're not listed as an admin on this license — ask whoever owns the license to add your email under enterprise → members".

## Context window protection

API responses can be large (matched OCR text + audio transcripts). **Always**:
1. Write curl output to a file (`-o /tmp/sp_team_*.json`).
2. Check size (`wc -c /tmp/sp_team_*.json`).
3. If over ~5KB, extract with `jq` rather than dumping the file into context.
4. Cite results by `t` (timestamp) and `device` (hostname or pseudonym) — don't quote multi-paragraph blocks.

## Progressive disclosure

Escalate from cheap to expensive:

| Step | Endpoint | When |
|------|----------|------|
| 1 | `GET /devices` | Always start here when the user names a teammate — match the human to a `device_id`. |
| 2 | `GET /search?q=...&since_hours_ago=24` | The user has a topic (e.g. "atlas", "q3 forecast"). Default 24h, narrow further if results are noisy. |
| 3 | `GET /search?q=...&device_id=...` | Once you know whose data you want, scope to that device. |
| 4 | `GET /records?device_id=...&since_hours_ago=4` | "Walk me through what X did between Y and Z" — chronological dump. Use AFTER you know the device + window from steps 1–3. |

Default `since_hours_ago` to 24 unless the user implies otherwise. Max 720 (30d).

---

## 1. List devices

```bash
curl -s "${AUTH_HEADERS[@]}" "$SP_URL/devices" -o /tmp/sp_team_devices.json
jq '.devices[] | {device_id, label, platform, last_seen}' /tmp/sp_team_devices.json
```

Each device has:
- `device_id` — the opaque id used by `/search` and `/records`
- `label` — hostname OR pseudonym (e.g. `john-mbp` or `user_a3f201` for anonymous devices)
- `last_seen` — ISO 8601; "offline" if older than ~30min
- `platform`, `app_version` — for debugging stale clients

When the user names a person ("what's john doing"), match against `label`. If multiple devices match, ask the user which one (or query all and aggregate).

## 2. Search

```bash
curl -s "${AUTH_HEADERS[@]}" \
  "$SP_URL/search?q=atlas&since_hours_ago=24&limit=20" -o /tmp/sp_team_search.json
jq '.results[] | {t, device, app, window, snippet: (.text // .transcription // "")[0:160]}' /tmp/sp_team_search.json
```

### Parameters

| Name | Description |
|------|-------------|
| `q` | Case-insensitive substring across app_name, window_name, frame text, audio transcription, speaker, device label, browser URL. Empty = all records in window. |
| `device_id` | Restrict to one device. Get it from `/devices`. |
| `app_name` | Exact match on app_name (case-insensitive), e.g. `Excel`, `Slack`. |
| `since_hours_ago` | Default 24, max 720. Smaller = faster + cheaper. |
| `since` / `until` | ISO 8601 alternatives to `since_hours_ago`. |
| `limit` | Default 50, max 200. Keep small to protect context. |

Response includes `truncated: true` if the byte budget was hit before the full window was scanned — narrow `q` or `since_hours_ago` and re-query rather than ask for `limit=200`.

## 3. Records (chronological)

```bash
curl -s "${AUTH_HEADERS[@]}" \
  "$SP_URL/records?device_id=DEVICE&since_hours_ago=4&kind=frame&limit=100" \
  -o /tmp/sp_team_records.json
jq '.records[] | {t, app, window, text: (.text // "")[0:120]}' /tmp/sp_team_records.json
```

| Name | Description |
|------|-------------|
| `device_id` | Required-ish. Without it you get the whole org — usually noisy. |
| `kind` | `frame` (screen) / `audio` / `all`. Default `all`. |
| `since_hours_ago` / `since` / `until` | Time window. |
| `limit` | Default 50, max 200. |

Records come oldest-first so you can describe a chronological flow.

---

## Privacy & expectations

- Some devices report as `user_xxxxxx` instead of a hostname — those users chose **anonymous** visibility. You can chat about them by pseudonym but should never speculate about their real identity. If the user asks "who is `user_a3f201`", say: that user opted into anonymous visibility and identity cannot be revealed without their consent.
- Don't dump raw text in your reply when summarizing — quote short snippets, cite by timestamp + device.
- Don't volunteer data the user didn't ask for. If they ask about engineering, don't include design.

## When NOT to use this skill

- The user is asking about **their own** machine → use `screenpipe-api` (queries `localhost:3030`).
- The user isn't an admin → this skill shouldn't even be installed; if it is, the API will return 403 and you should tell them their license role doesn't permit team queries.
