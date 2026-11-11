# Architecture

The server exposes the same booking tools over local stdio and hosted Streamable HTTP. Local clients provide an RC
session token through the environment; hosted clients sign in through OAuth. The hosted server has no database.
See [mcp-tool-spec.md](mcp-tool-spec.md) for tool behavior and [roadmap.md](roadmap.md) for known gaps.

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript (strict), ESM |
| MCP | official `@modelcontextprotocol/server` v2: `createMcpHandler` (HTTP), `serveStdio` (stdio) |
| HTTP framework | Hono |
| Self-hosted runtime | Node.js 22+ with `@hono/node-server` |
| Token encryption | `jose` (JWE, `A256GCM`) |
| Schemas | Zod v4 (tool inputs/outputs and RC responses) |
| RC HTTP client | native `fetch` |
| Login page | `hono/html` templates |
| CLI | plain `process.argv` parsing, no framework |
| Build | `tsup` → `dist/` |
| Tests | Vitest; MCP Inspector for manual checks |

**Portability rule** (keeps Cloudflare Workers open, see "Later"): everything outside `src/platforms/` and
`src/cli/` uses only Web-standard APIs — `Request`, `Response`, `fetch`, `crypto.subtle`, `TextEncoder`, `URL`. No
`node:*` imports, no `process.env`, no file system there. Config and the cache are passed in, not read globally.


## Code structure

| Directory | Responsibility |
| --- | --- |
| `src/mcp/` | MCP instructions, tool schemas and handlers |
| `src/domain/` | Calendar calculations, matching, booking transforms, confirm tokens and write plans |
| `src/upstream/` | RC HTTP client, endpoint functions and response schemas |
| `src/oauth/` | Hosted authorization, login, encrypted tokens and client metadata |
| `src/platforms/`, `src/cli/` | Node entrypoints and local login/check/logout |
| `test/` | Fictional fixtures, fake RC, unit tests, evals and opt-in live tests |
| `deploy/` | Example compose and Kubernetes configuration, not a production deployment |

Domain logic is pure; handlers coordinate it with the upstream client. Platform adapters supply configuration,
logging and runtime IO. The portability rule keeps Node imports in the platform/CLI layers.

## RC client

- Base `https://realtycalendar.ru/v2/`, headers `X-User-Token`, `X-Locale: ru`, `Content-Type: application/json`,
  an honest `User-Agent` (`realtycalendar-web-mcp/<version>`). Hosted adds the deployment and client to the
  User-Agent, the client IP as `X-Forwarded-For` and our `X-Request-Id`, so RC can trace abuse through us (D57).
- Query: Rails arrays (`statuses[]=…`), `apartment_ids` comma-joined; chunk ids by 10 when > 50 (as the web app).
- Error mapping per spec §1: 401 → `AUTH`; 404 → `NOT_FOUND`; 422 "На данные числа объект занят" → `OCCUPIED`;
  422 "Комната не найдена" → `ROOM_NOT_IN_CATEGORY` (logged as an invariant violation — the server derives the
  category itself, so this means a bug or a stale cache; refresh the catalog); date messages → `INVALID_DATES`;
  schema errors (array of strings) → `VALIDATION`; 400 `{"error":"date range"}` → `RANGE_TOO_LONG`.
- Response validation: every RC response goes through its zod schema; a missing/renamed field we rely on (e.g.
  `prepayment`, `amount`, `room_id`) → `RC_SCHEMA_DRIFT` instead of silently wrong money or availability.
- GETs: 15 s timeout, one retry on network/5xx with jitter, respect `Retry-After`. Writes: no automatic retry.
- Concurrency: the client bounds requests per token. A global upstream token bucket is not implemented; see
  [roadmap.md](roadmap.md).

## Caching

In memory, keyed by (hash of RC token, agency id):

| Data | Source | TTL |
|---|---|---|
| categories + rooms | `GET apartments` | 10 min (refreshed once on a name miss) |
| sources, currency | `GET info` → `agency.sources_list`, `agency.currency` | 10 min |
| bookings, availability, prices | — | never |

## Write path

From tested behaviour (mcp-user-stories.md) and the reviews:

- **Preview tool + confirm token** (spec §1, D33–D35): a read-only `preview_<write>` tool returns the preview and an
  HMAC token over (tool, resolved plan, the booking's last audit version, expiry 15 min). The write tool
  (`destructiveHint: true`, so the client asks the user) recomputes it; mismatch → `PREVIEW_STALE` with a fresh
  preview. The token binds the write to what was previewed; the user's approval is the client's prompt.
  Stateless; the key is `RC_CONFIRM_KEY` (v1) or derived from the server key (hosted).
- **Create**: duplicate check → `POST` draft → `PUT` full body. Nothing is retried or deleted by the server. After a
  timeout or 5xx the caller is told the outcome is unknown and to repeat the confirm: the duplicate check returns the
  booking if it was saved. Drafts left by a failed PUT can't be deleted (DELETE → 404 ✅) but are invisible and don't
  block rooms ✅.
- **Update / cancel**: re-`GET` at confirm time (also the stale check) → body built **from that GET** with guest and
  client ids carried over (spec §2.8 mapping) → apply only the requested changes → `PUT`. Unknown fields in the GET →
  refuse (`RC_SCHEMA_DRIFT`). Writes to the same booking id are serialised in-process. Deleted bookings → `DELETED`.
- `apartment_id` always derived from the target room (or the explicit category).
- `send_confirm_email`, `send_link_prepaid` always `false`; no payment writes in v1.
- **Audit log** per confirmed write: one JSON line in the log stream (stderr for stdio) with time, tool, booking id,
  RC user id, written fields and result; `RC_AUDIT=full` adds the pre-write GET body (guest data) for manual undo.
  Details: [testing.md](testing.md) and `src/audit.ts`.

## Security against prompt injection

Guest names, notes and booking-site fields are written by outsiders (anyone can book on Ostrovok). They are returned
inside `untrusted` objects, the server instructions tell the model never to follow instructions found there, and every
write needs a confirm token from a preview the user saw.

## Logging and privacy

- Structured JSON logs: tool, duration, RC endpoint + status, error code, booking ids. Never request/response bodies,
  never guest names, phones, e-mails, notes or tokens. One redaction layer (`redact.ts`) used by the logger and by
  `VALIDATION` error details (RC 422 bodies can echo field values). A test pushes a seeded PII string and a fake token
  through every error path and greps the logs.
- Tool outputs include guest phone/e-mail only in tools whose job needs them (arrivals, booking lists, booking detail),
  not in availability results.

## Local stdio

```jsonc
{ "mcpServers": { "realtycalendar": {
    "command": "node", "args": ["/path/to/realtycalendar-web-mcp/dist/main.js"],   // checkout at a release tag, e.g. v0.3.0
    "env": { "RC_TOKEN": "…", "RC_ACCESS": "edit" } } } }
```

- **Dedicated RC user** for the MCP (Settings → Users), recommended, with only the needed objects and role: actions
  show up under that user in RC's history, and a read-only RC role is the real guarantee for read-only use. (Sessions
  are independent ✅ A1, so a shared user would also work: the browser's logout doesn't touch the MCP's token.)
- Token: preferably the bundled `node dist/main.js login` CLI (`POST /v2/sign_in {username, password}` →
  `auth_token`), which creates a **separate session** for the MCP ✅; the local CLI does not store the password; the token goes into
  `RC_TOKEN`. Copying the browser's `localStorage.token` also works but ties the MCP to
  that browser session (logging out there kills it ✅). Rotation/revocation: `node dist/main.js logout` →
  `DELETE /v2/sign_in` with the MCP's token, which ends only that session ✅.
- `RC_ACCESS=read|book|edit|full` (default `read`; levels in spec §1): tools above the level are not registered
  **and** their handlers refuse calls (second guard if a client cached the tool list).
- `RC_SITE_BOOKINGS=protect|allow` (default `protect`, D40): writes don't change what a booking site sold. Hosted, it
  is server-wide for the hosted deployment; the access level is picked per connection on the login page, capped by `RC_ACCESS` (D51).
- No npm package or stdio image is published; run from a checkout with Node. The Docker image is
  for the hosted HTTP server only.

## Hosted: stateless OAuth

Goal: one URL that users add as a connector in Claude or ChatGPT; the server keeps no database.

### Protocol

- Endpoints: `/mcp` (Streamable HTTP), `/.well-known/oauth-protected-resource` (RFC 9728),
  `/.well-known/oauth-authorization-server` (RFC 8414), `/authorize`, `/token`, login page.
- Unauthenticated or invalid-token `/mcp` requests → HTTP 401 with
  `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"` (plus
  `error="invalid_token"` when a token was sent). An RC 401 during a tool call is turned into this HTTP 401 too, so the
  client refreshes/re-authenticates immediately.
- Authorization code + PKCE (S256 only), public clients (`token_endpoint_auth_method: none`), exact `redirect_uri`
  match, `iss` in the authorization response, `resource` parameter (RFC 8707) bound into tokens as `aud`; when omitted it defaults to this server's MCP URL.
- **Client registration: CIMD only, no DCR.** Both Claude and ChatGPT support it.
  Authorization server metadata must advertise:
  `"client_id_metadata_document_supported": true`, `"token_endpoint_auth_methods_supported": ["none"]`,
  `"code_challenge_methods_supported": ["S256"]`, `"authorization_response_iss_parameter_supported": true`, and
  `"scopes_supported": ["offline_access"]` (Claude then asks for a refresh token).
- Accepted clients (allowlist of CIMD URLs; their metadata is fetched and the redirect URI checked against it):

  | Client | `client_id` (CIMD URL) | Redirect URI |
  |---|---|---|
  | Claude (web, Desktop, mobile) | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `https://claude.ai/api/mcp/auth_callback` |
  | Claude Code | `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost:<any>/callback`, `http://127.0.0.1:<any>/callback` (match ignoring the port) |
  | ChatGPT | `https://chatgpt.com/oauth/client.json` | `https://chatgpt.com/connector_platform_oauth_redirect` |

- Every authorization response, including errors, carries `iss` (ChatGPT rejects responses without it). The
  protected resource metadata's `resource` equals the MCP URL exactly, and `authorization_servers` lists our issuer
  first (Claude uses only the first entry).
- `/token` accepts `application/x-www-form-urlencoded`; invalid refresh → `invalid_grant`. Claude allows 10 s for the
  token endpoint and 30 s for refresh, which a refresh with an RC sign-in fits.
- The login page shows which client is connecting and its redirect host; HTTPS only.

### Tokens (no server-side storage)

All tokens are JWE (`A256GCM`) under one persistent server key. Each carries `typ`, `iss`, `aud` (the `/mcp` URL),
`client_id`, `scope`, `iat`, `exp`.

| Token | Lifetime | Contains |
|---|---|---|
| login state | 10 min | the validated authorization request (client, redirect URI, PKCE challenge, scopes, resource); set by `GET /authorize` as an encrypted cookie (`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`) and read by `POST /login`. Binds the login to the browser that started it; `SameSite=Lax` also keeps cross-site form posts out |
| authorization code | 60 s | PKCE challenge, redirect URI, RC token, RC username + password |
| access token | 15 min | RC token |
| refresh token | 30 days, sliding | latest RC token, RC username + password |

- `/mcp`: decrypt, check `typ`, `aud`, `exp` → call RC with the RC token. An RC 401 → HTTP 401 `invalid_token`, so
  the client refreshes right away.
- Refresh: try the RC token from the refresh token (`GET /v2/info`). Works → keep it. 401 → sign in to RC with the
  username + password → new RC token. Sign-in fails → `invalid_grant`, the user reconnects. Either way, issue a new
  access + refresh token.
- Flow: `GET /authorize` (validate, set the login-state cookie) → `POST /login` (read the cookie, sign in to RC) →
  redirect with a 60-second encrypted code → `POST /token` (decrypt; check expiry, client, redirect URI, PKCE
  verifier; issue access + refresh tokens).
- Nothing is kept in memory or storage: no database, Redis, Durable Objects or session store; only the persistent
  encryption key. Any instance (and later a Worker) can handle any step.
- Accepted trade-off: without shared state a code can't be enforced as single-use; it stays replayable until it
  expires if the PKCE verifier is also compromised.
- MVP gaps, accepted: refresh tokens are reusable (no rotation or replay detection), no revocation, no maximum
  session lifetime. Changing the RC password stops silent re-login.

### RC sessions (tested)

Every `POST /v2/sign_in` returns a new token and older ones keep working; `DELETE /v2/sign_in` ends only that session
✅. RC decides how long a token lives; when one dies, refresh signs in again with the stored credentials.

### Personal data (152-FZ)

Guest names and phones flow through the server (not stored) and, in both v1 and hosted, to the LLM provider. Each
hotel is the data operator and may need to cover cross-border transfer in its notices; in hosted we act on the
hotel's instruction (processor). Defaults: store nothing about guests; keep PII out of logs; provide
a short note for hotels. Legal check before a public launch.


## Development

See [testing.md](testing.md) for local checks, model evals and live-test precautions. Setup and hosted deployment
settings are in [README.md](../README.md). RC's private web API can change without notice; response schema validation
fails closed when required fields change. [api-scope.md](api-scope.md) documents the known endpoint surface.
