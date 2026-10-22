# RealtyCalendar MCP: technical structure

Status: final draft, 2054-10-22. What to build and in which order. Behaviour: [mcp-tool-spec.md](mcp-tool-spec.md).
Runtime rules (RC client, write path, OAuth): [architecture.md](architecture.md).

**Goal:** one MCP implementation, minimal dependencies, no persistent storage of RealtyCalendar credentials. Only the
platform adapters differ between deployments.

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
| Login page | Hono JSX |
| CLI | plain `process.argv` parsing, no framework |
| Build | `tsup` → `dist/` |
| Tests | Vitest; MCP Inspector for manual checks |

**Portability rule** (keeps Cloudflare Workers open, see "Later"): everything outside `src/platforms/` and
`src/cli/` uses only Web-standard APIs — `Request`, `Response`, `fetch`, `crypto.subtle`, `TextEncoder`, `URL`. No
`node:*` imports, no `process.env`, no file system there. Config and the cache are passed in, not read globally.

## Deployments

| Target | Entrypoint | Auth | Status |
|---|---|---|---|
| Local stdio (Claude Desktop, Claude Code, Codex, Inspector) | `platforms/stdio.ts` | RC token from `RC_TOKEN` | v1 |
| Self-hosted HTTP | `platforms/node.ts` | stateless OAuth (architecture.md) | M4 |
| Cloudflare Workers | `platforms/worker.ts` | same OAuth | later, not built now |

Plus the **CLI** in the same package: `realtycalendar-web-mcp login | logout | check` for stdio users.

## Repository

One npm package, `realtycalendar-web-mcp` (`UNLICENSED`, private), in the git repo `stek29/realtycalendar-web-mcp`
(local for now; a GitHub remote and CI can be added any time):

```text
docs/                     the design docs; docs/endpoints/ = endpoint lists extracted from the web app
scripts/                  extract_endpoints.py, scrub-fixture.ts
src/
  mcp/
    server.ts             createMcpServer(ctx): McpServer — instructions + tools allowed by ctx.access
    instructions.ts       server instructions (today, rules, what this access level can't do)
    tools/                one file per tool (8), plus define.ts (defineTool, defineWriteTool) and shared.ts
                          (input checks, BookingSummary output shape)
  domain/                 pure logic, no IO
    catalog.ts  match.ts  dates.ts  calendar.ts  bookings.ts  writes.ts  confirm.ts  warnings.ts  errors.ts  redact.ts
  upstream/               the only code that talks to RealtyCalendar
    client.ts             RcClient: fetch, headers, retries, error mapping, response validation
    api.ts                one typed function per endpoint
    schemas.ts            Zod schemas of RC responses
  oauth/                  hosted only
    app.ts                Hono routes: metadata, /authorize, login form, /token
    tokens.ts             JWE encrypt/decrypt for login state, codes, access and refresh tokens (no server-side state)
    cimd.ts               client allowlist + CIMD document fetch/validation
    login.tsx             login page
  context.ts              Context type + makeContext(rcToken, config, cache)
  audit.ts                AuditEntry, AuditSink (write audit log; the stdio platform provides a file sink)
  config.ts               Config type + parse(env-like record)
  cache.ts                Cache interface + in-memory implementation
  log.ts                  Logger: structured JSON lines, every line through domain/redact.ts
  cli/
    main.ts               login / logout / check
  platforms/
    stdio.ts              v1 entrypoint
    audit-file.ts         audit log as daily JSONL files (0600), 30 days kept
    node.ts               hosted entrypoint (M4)
test/
  fixtures/               scrubbed RC responses
  fake-rc.ts              in-memory RC built from fixtures (unit tests, evals, Inspector demos)
  unit/  live/  evals/
```

## Layers

```text
platforms/*  ──►  mcp/ (createMcpServer, tools)  ──►  upstream/ (fetch, validate)
                         │                                  │
                         └────────►  domain/ (pure)  ◄──────┘
oauth/ is used only by platforms/node.ts (and later worker.ts)
```

- **`domain/`** never calls `fetch`, reads config or the clock; it gets data and `today` as arguments. The tricky
  logic lives here and is tested with fixtures: capacity with unassigned bookings, single-unit categories, stay rules
  and closures, money (paid/left), name matching with Russian endings, the GET→PUT update body, confirm tokens.
- **`upstream/`** is the only place that knows RC URLs, headers and response shapes.
- **`mcp/`** wires them together: parse input → resolve names via the catalog → RC calls → domain → output.
- **`platforms/`** build a `Context` and hand `createMcpServer` to the SDK. Nothing else differs between targets.

## Key interfaces

```ts
// config.ts
type Access = 'read' | 'book' | 'edit' | 'full'
interface Config { access: Access; timezone: string; confirmKey: Uint8Array; rcBaseUrl: string }
parseConfig(env: Record<string, string | undefined>): Config        // RC_ACCESS, RC_TIMEZONE, RC_CONFIRM_KEY

// cache.ts — in-memory now; Workers would use the Cache API behind the same interface
interface Cache { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T, ttlSec: number): Promise<void> }

// context.ts — built per connection (stdio) or per request (HTTP); never shared between users
interface Context { rc: RcClient; catalog(): Promise<Catalog>; now(): Date; config: Config; log: Logger;
                    audit: AuditSink; withBookingLock<T>(id: number, fn: () => Promise<T>): Promise<T> }

// upstream/client.ts
class RcClient {
  constructor(token: string, opts: { baseUrl: string; fetch?: typeof fetch })
  get<T>(path: string, query: Query, schema: ZodType<T>): Promise<T>                     // 1 retry, validated
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, schema: ZodType<T>): Promise<T>  // no retry
}

// upstream/api.ts
getApartments, getApartmentInfo, getInfo, getGrid, getStayRules,
getBooking, getPayments, getPrice, createDraft, putBooking, deleteBooking, signIn, signOut

// mcp/tools/define.ts
defineTool({ name, level, description, input, output, annotations, handler: (ctx, args) => Promise<Out> })
defineWriteTool({ name, level, description, input, output, annotations,
                  preview: (ctx, args) => Promise<Preview>,          // no side effects
                  commit:  (ctx, args, preview) => Promise<Out> })   // runs only with a valid confirm_token

// mcp/server.ts
createMcpServer(ctx: Context): McpServer       // registers tools with level ≤ ctx.config.access
```

## Entrypoints

```ts
// platforms/stdio.ts
const config = parseConfig(process.env)
const ctx = makeContext(process.env.RC_TOKEN!, config, memoryCache())
serveStdio(() => createMcpServer(ctx))

// platforms/node.ts (M4)
const app = new Hono()
app.route('/', oauthApp(config))                               // discovery, /authorize, login, /token
app.all('/mcp', async c => {
  const rcToken = await accessTokenToRcToken(c.req.raw, config) // 401 + WWW-Authenticate on failure
  const ctx = makeContext(rcToken, config, sharedCache)
  return createMcpHandler(() => createMcpServer(ctx), { legacy: 'stateless' })(c.req.raw)
})
serve({ fetch: app.fetch, port })
```

- Stateless Streamable HTTP; older clients served through the SDK's `legacy: 'stateless'` mode; no HTTP+SSE
  transport, no MCP sessions.
- The RC token is taken per request from the decrypted access token and lives only in that request's `Context`.
- The shared in-memory cache is keyed by a hash of the RC token, so users never see each other's catalog.

## CLI

```text
realtycalendar-web-mcp            → runs the stdio server (default)
realtycalendar-web-mcp login      → asks for RC login + password, POST /v2/sign_in → prints the token (or stores it in
                                 the OS keychain with --keychain); creates a separate RC session for the MCP
realtycalendar-web-mcp logout     → DELETE /v2/sign_in with RC_TOKEN (ends only that session)
realtycalendar-web-mcp check      → GET /v2/info with RC_TOKEN: prints user, agency, access level, token works or not
```

The password is never stored or logged. The CLI is the only place besides the hosted login page that sends a password.

## Tooling and CI

- `tsup` builds `dist/`; `bin: realtycalendar-web-mcp`. `tsc --noEmit` for type checks; `eslint` + `prettier`.
- A lint rule (or a simple test) enforces the portability rule: no `node:` imports outside `platforms/` and `cli/`.
- Evals and the real-client check run headless CLIs against the server in fake-RC mode (no live data):
  `claude -p --model sonnet|haiku --strict-mcp-config --mcp-config <json> --output-format stream-json --verbose`
  (tool calls are read from the stream), and `codex exec -m gpt-6.1-sol --json` with the server passed as
  `-c mcp_servers.realtycalendar.command=…`; both gate. Exact flags: plan-m3.md §1. One run on Claude Desktop before
  a release.
- CI (GitHub Actions): typecheck, lint, unit tests, fixture-PII check; evals when `src/mcp/` changes. Live tests
  (`RC_LIVE=1 RC_TOKEN=… npm run test:live`) never run in CI.
- Release: npm with provenance; config examples pin the version.

## Build order

| # | Milestone | Done when |
|---|---|---|
| M1 | Repo + `docs/`, config/context/cache, `upstream/` client + schemas, fixtures + fake RC, catalog + matching, the 4 read tools, stdio, `check` command | Claude Desktop answers U1–U4, U9, U10, U12, R1–R3 against the live account with `RC_ACCESS=read` |
| M2 | `defineWriteTool`; create / update / cancel / delete (S2, S3 answered and S9 settled by the 2054-10-22 baseline, mcp-user-stories.md) | Live write tests pass and leave the calendar clean; S3 (no-op PUT keeps booking and guest) passes before update/cancel ship |
| M3 | Evals for all spec §3 prompts, `login` / `logout`, audit log, packaging | Evals green; v1 published |
| M4 | `oauth/` + `platforms/node.ts` | Connects from Claude and ChatGPT via CIMD |

## Later: Cloudflare Workers (postponed)

Not built now. Kept possible by: the portability rule; `Cache` as an interface (Workers → Cache API, keyed by token
hash); OAuth state entirely in encrypted tokens (nothing to share between isolates); `platforms/worker.ts` would only
wire `app.fetch`. Before building it, check that the login page is reachable from Russia (Russian ISPs have been
throttling Cloudflare) and that RC accepts requests from Cloudflare's network; guest data would also pass through a
non-Russian provider.
