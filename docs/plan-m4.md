# M4: hosted HTTP server

Status: v0.3.0 released 2054-10-28 (D58, D61, D64); the real-client check is still open. Design: [architecture.md](architecture.md) "Hosted: stateless OAuth". Layout:
[technical-structure.md](technical-structure.md). Goal: deployed and in real use on Claude web and ChatGPT web.

## Modules

| File | What |
|---|---|
| `src/oauth/keys.ts` | server key(s) from config → JWE key per `kid`, confirm-token key (HKDF) |
| `src/oauth/tokens.ts` | `seal(typ, claims, ttl)` / `open(typ, jwe)`: JWE `dir` + `A256GCM`; checks `typ`, `iss`, `aud`, `exp` |
| `src/oauth/cimd.ts` | allowlist of CIMD URLs, fetch + validate the document (cached 1 h), redirect URI match |
| `src/oauth/login.ts` | login page HTML (`hono/html`, not JSX: no extra build config) |
| `src/oauth/app.ts` | Hono routes below; `bearer(req)` → RC token + access level, or a 401 `Response` |
| `src/platforms/node.ts` | env → config, Hono app, `/mcp` via `createMcpHandler`, `/healthz`, `@hono/node-server` |

New dependencies: `hono`, `@hono/node-server`, `jose`. All of `src/oauth/` follows the portability rule.

## Endpoints

| Route | |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | `resource` = `<public URL>/mcp`, `authorization_servers` = [issuer], `scopes_supported` = `["offline_access"]` |
| `GET /.well-known/oauth-authorization-server` | issuer, endpoints, `client_id_metadata_document_supported`, `none`, `S256`, `iss` supported, `offline_access`, `response_types` `code`, grants `authorization_code` + `refresh_token` |
| `GET /authorize` | validate client (CIMD) and redirect URI → error page (no redirect); other errors → redirect with `error` + `iss`; OK → login-state cookie + login page |
| `POST /login` | read cookie, `POST /v2/sign_in` → redirect with `code`, `state`, `iss`; wrong password → the page again with a message |
| `POST /token` | form-encoded; `authorization_code` (PKCE S256, client, redirect URI, resource) and `refresh_token` |
| `POST\|GET\|DELETE /mcp` | bearer → per-request `Context` → `createMcpHandler(…, { legacy: 'stateless' })` |
| `GET /healthz` | `ok`, no RC call |

`resource` must equal `<public URL>/mcp` when sent (Claude and ChatGPT send it); a missing one is accepted and bound
to that URL anyway (single resource).

## Config (env)

| Var | |
|---|---|
| `MCP_PUBLIC_URL` | e.g. `https://rc.example.com`; issuer = it, MCP URL = it + `/mcp`. HTTPS required except `localhost` / `127.0.0.1` |
| `MCP_SERVER_KEY` | base64url, ≥ 32 bytes (`openssl rand -base64 32`); required |
| `MCP_SERVER_KEY_PREVIOUS` | optional, rotation (below) |
| `PORT` | default 8080 |
| `MCP_TRUST_PROXY_HOPS` | reverse proxies in front that append to `X-Forwarded-For` (default 0); for the client IP in logs |
| `RC_ACCESS` | the **highest** level a connection may pick (default `read`) |
| `RC_SITE_BOOKINGS`, `RC_TIMEZONE`, `RC_AUDIT` | as stdio, server-wide |

`RC_TOKEN` and `RC_CONFIRM_KEY` are not used: the RC token comes from the access token, the confirm key is derived
from the server key.

## Settled questions

1. **Per-connection settings.** The login page has an access level select (read / book / edit / full, capped by
   `RC_ACCESS`, default read). The choice goes into every token as the `access` claim; changing it means reconnecting.
   Not as OAuth scopes: clients request only what `scopes_supported` says, so a scope picked on our page would be a
   private claim anyway. `RC_SITE_BOOKINGS` stays server-wide for v0.2 (one hotel, one owner). (D51)
2. **CIMD allowlist** (all three documents fetched 2054-10-22):

   | Client | `client_id` | Redirect URIs in the document |
   |---|---|---|
   | Claude (web, Desktop, mobile) | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `https://claude.ai/api/mcp/auth_callback` |
   | Claude Code | `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost/callback`, `http://127.0.0.1/callback` (port ignored) |
   | ChatGPT | `https://chatgpt.com/oauth/client.json` | `https://chatgpt.com/connector_platform_oauth_redirect` |

   ChatGPT's document says `private_key_jwt` but lists `none` as supported; we advertise only `none`. (D52)
3. **Server key.** One secret, `MCP_SERVER_KEY`, from a Kubernetes Secret or a compose `env_file` (git-ignored). Every
   JWE header carries `kid` = first 8 hex of SHA-256 of the key. Rotation: set the new key as `MCP_SERVER_KEY` and the
   old one as `MCP_SERVER_KEY_PREVIOUS`; tokens are issued with the new key and both decrypt. Refresh re-issues under
   the new key, so after 30 days the previous key can go. Losing the key = every user reconnects; nothing else is
   lost. (D53)

## Token flow

As architecture.md: login state (cookie, 10 min) → code (60 s) → access (15 min) + refresh (30 days, new one on each
refresh). Claims on all: `typ`, `iss`, `aud`, `client_id`, `scope`, `access`, `iat`, `exp`. `/mcp` with a bad token or
an RC 401 during the request → `401` + `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`.
Refresh: `GET /v2/info` with the stored RC token; 401 → sign in with the stored login; fails → `invalid_grant`.

RC 401 mid-request: the `Context`'s RC client reports it to the request; the handler drops the MCP response and
answers 401 (JSON responses only; tool calls never stream).

## Tests (unit, fake RC + fake clients)

- metadata documents; 401 shape on `/mcp` without/with a bad token
- full flow: authorize → login → code → token → `/mcp` `tools/list` → refresh
- `iss` on every authorization response (success, `access_denied`, bad PKCE method, …)
- exact redirect URI match (plus port-agnostic loopback for Claude Code only); unknown client; CIMD document whose
  `client_id` doesn't match its URL
- `aud`/resource: wrong `resource` → `invalid_target`; a token for another `aud` → 401
- expired code; code with a wrong verifier; access token used as refresh token (`typ`)
- refresh: RC token alive → kept; RC 401 → re-login; re-login fails → `invalid_grant`
- RC 401 during a tool call → HTTP 401
- access level from the login page limits `tools/list`; capped by `RC_ACCESS`
- key rotation: token from the previous key still opens

## Deploy

- `Dockerfile`: multi-stage, `node:22-alpine`, `npm ci` + build, runtime with prod deps only, `USER node`,
  `HEALTHCHECK` on `/healthz`, `CMD ["node", "dist/server.js"]`. HTTP only.
- `.github/workflows/image.yml` (D54): after `npm run check`, builds linux/amd64 + linux/arm64 and pushes to the private
  `ghcr.io/stek29/realtycalendar-web-mcp` (`:main`, `:sha-…`; release tags `:X.Y.Z`, `:latest`).
- `deploy/docker-compose.yml`: a hardened sample without TLS, behind the owner's reverse proxy on `127.0.0.1:8080`;
  `MCP_TRUST_PROXY_HOPS` for the real client IP in logs (D56). Deployment itself is not from this repo.
- `deploy/k8s.yaml`: Deployment (non-root, read-only root FS, probes), Service, Secret reference; Ingress left to the
  owner. Any number of replicas works (stateless).

## Done when

- `npm run check` green; the OAuth unit tests above pass. ✅
- Local: MCP Inspector and `claude mcp add --transport http` complete the OAuth flow against `http://localhost:8080`
  with the owner's login (typed by the owner). Partly ✅: the Inspector CLI on the fake RC (`scripts/dev-hosted.ts`);
  the browser Inspector isn't an allowed client; Claude Code with the owner's login not run yet.
- Owner's deployment behind HTTPS; Claude web and ChatGPT web connect, answer U1a and U4a, and one write on the test
  window shows the client's approval prompt. Note whether ChatGPT passes `instructions` (D47).
- Over-triggering TODO (plan-m3.md) done small: descriptions tightened, a few negative/contextual cases, Sonnet
  `--repeat 1`.
- Owner OKs the tag; `v0.2.0`. ✅ Tagged before the two items above, at the owner's request (D58).

## Later

Known gaps, accepted for v0.2 (owner, 2054-10-22): they need shared state to work reliably, and the server stays
stateless for now.
- No rate limit on failed logins: `/login` passes passwords to RC's sign-in. Failures are logged with IP and account
  (D57); RC throttles sign-ins itself.
- No way to cut off one user: no revocation or account blocklist. Rotating the server key disconnects everyone; the user
  changing the RC password stops silent re-login.
- No global token bucket towards RC (architecture.md "RC client"): not needed for one hotel; add before a second
  tenant.
- Refresh token rotation with replay detection.

The browser MCP Inspector isn't an allowed client (it registers with DCR); the Inspector CLI with a bearer token,
`scripts/dev-hosted.ts` and Claude Code cover local checks.
