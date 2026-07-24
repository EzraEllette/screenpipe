# Releasing `screenpipe-mcp`

Publishing is a **GitHub Actions job**, not a local command: it needs the
`NPM_TOKEN` repo secret. No developer machine is expected to hold npm
credentials for this package.

---

## 0.19.0 — release notes (pending publish)

**Headline: `team-*` tools can finally be pointed at a customer's own query
gateway.** Orgs on the write-only archive tier keep telemetry in their own
object storage, served by a gateway inside their network; the hosted API has no
read path to that data. Before this release the base URL was a hardcoded
constant, so `team-search` / `team-devices` / `team-records` registered and then
failed with **HTTP 401** for every such org, and the only workaround was running
this MCP from source.

- `--team-api-url` flag, `SCREENPIPE_TEAM_API_URL` env var, and `team_api_url`
  in `~/.screenpipe/enterprise.json` now select the team API base, in that
  precedence order, falling back to `https://screenpi.pe/api/enterprise/v1`
  (`src/team-config.ts`).
- The token is unchanged (`sk_ent_…` via `SCREENPIPE_ENTERPRISE_TOKEN` or
  `team_api_token`); only the base moves.
- The HTTP transport no longer reports a frozen `0.14.0` as its version — both
  transports and the Sentry release tag now read `package.json` through
  `src/version.ts`.
- README documents the whole knob, including which install paths cannot reach a
  gateway yet.

**Why 0.19.0 and not 0.18.16.** npm's `0.18.15` was built from a tree that
predated `src/team-config.ts`, and nobody bumped `package.json`, so the registry
and the repo both claimed "0.18.15" on two different trees. The version string
is the only handle support has on "which build is the customer running", so the
replacement must be unmistakable rather than one character away from the broken
one: `0.19.x` = has the gateway knob, `0.18.x` = does not. It is also the
semver-correct level, since this adds user-facing surface rather than fixing a
defect in shipped behaviour. Nothing depends on this package through a semver
range — every consumer in the monorepo uses `screenpipe-mcp@latest` — so the
minor bump changes no resolution.

**Known gaps that this release does NOT close** (documented under "Known limits"
in the README):

- Nothing in the repo writes `team_api_url` into `~/.screenpipe/enterprise.json`
  yet, so precedence step 3 is unpopulated in practice; gateway orgs must set the
  env var or the flag by hand.
- The `.mcpb` bundle's `manifest.json` has no `user_config`/`env` block, so the
  Claude Desktop extension install has no UI for these variables.
- The `--http` transport still exposes `search_content` only; `team-*` is
  stdio-only.

---

## Before releasing

1. **The source commit must be on `main`.** `src/team-config.ts` arrived with
   PR #5400 (`feat(enterprise): write-only archive + customer-run query
   gateway`). Publishing from a feature branch ships a tree nobody reviewed as
   `latest`. Confirm:
   ```bash
   git fetch origin
   git merge-base --is-ancestor <team-config-commit> origin/main && echo "on main" || echo "NOT on main — do not release"
   ```
2. **The version must not already be on npm.** `release-mcp.yml` now *fails* in
   that case instead of skipping quietly, but check first so you don't burn a
   run:
   ```bash
   node -p "require('./package.json').version"   # repo
   npm view screenpipe-mcp version               # registry — must differ
   ```
3. **Local gates green** (also enforced by `.github/workflows/test-mcp.yml`):
   ```bash
   cd packages/screenpipe-mcp
   bun install --frozen-lockfile
   bun run typecheck
   bun run build
   bun run test
   ```

## Publishing

Two equivalent triggers. Tag push is preferred — the tag is then a real record
of what shipped:

```bash
# from an up-to-date main checkout
git tag mcp-v0.19.0
git push origin mcp-v0.19.0
```

Or dispatch it (this is how 0.18.15 shipped; the workflow creates the tag
itself in its "Create GitHub Release" step):

```bash
gh workflow run release-mcp.yml -R screenpipe/screenpipe
```

`allow_already_published: true` is **only** for re-running the MCP-Registry /
`mcpb` / GitHub-release steps after a partial failure. It leaves the npm
registry untouched — never use it to "retry" a release you expected to publish.

## After publishing

```bash
VER=0.19.0

# 1. the registry actually moved
npm view screenpipe-mcp version                       # == $VER
npm view screenpipe-mcp dist-tags --json              # latest == $VER

# 2. the run did NOT no-op
gh run list --workflow=release-mcp.yml -R screenpipe/screenpipe --limit=3
gh run view <id> --log | grep -i "already on npm"     # must find nothing

# 3. the artifact carries the gateway knob (this is the whole point)
curl -sSL https://registry.npmjs.org/screenpipe-mcp/-/screenpipe-mcp-$VER.tgz \
  | tar -xzO package/dist/team-config.js | grep SCREENPIPE_TEAM_API_URL

# 4. no hardcoded team base survived
curl -sSL https://registry.npmjs.org/screenpipe-mcp/-/screenpipe-mcp-$VER.tgz \
  | tar -xzO package/dist/index.js | grep 'TEAM_API = "https' \
  && echo "REGRESSION: hardcoded base" || echo "ok — base is resolved, not hardcoded"

# 5. the .mcpb bundle attached to the GitHub release contains it too
#    (mcpb pack contents have never been verified — do this once)
gh release download mcp-v$VER -R screenpipe/screenpipe -p '*.mcpb' -D /tmp
unzip -l /tmp/screenpipe-mcp.mcpb | grep team-config
```

End-to-end against a real gateway:

```bash
SCREENPIPE_ENTERPRISE_TOKEN=sk_ent_… \
SCREENPIPE_TEAM_API_URL=https://<gateway>/api/enterprise/v1 \
npx -y screenpipe-mcp@0.19.0
# then call team-devices over stdio and confirm the request reached the
# gateway's access log, not screenpi.pe
```

## Notes

- `server.json`'s two version fields are synced from `package.json` by CI at
  publish time but **never committed back**, so bump them in the same commit.
  `src/version.test.ts` fails if they disagree.
- `manifest.json` intentionally stays at `0.0.0-injected-from-package-json`; CI
  rewrites it during the run.
- The workflow runs a bare `npm install` (no lockfile — `package-lock.json` is
  gitignored, `bun.lock` is the source of truth and npm ignores it), so the
  published build can resolve different transitive dependency versions than the
  local verification did.
