# realtycalendar-web-mcp

MCP server for [RealtyCalendar](https://realtycalendar.ru) — lets Claude, ChatGPT and other MCP clients check
availability and manage bookings through RealtyCalendar's web app API.

Status: v0.2.1 — 4 read tools and 4 write tools (create, update, cancel, delete), each write with a read-only preview
tool; audit log; `login` / `logout`; a hosted HTTP server with OAuth sign-in for Claude and ChatGPT connectors (Docker
image, below). Not published: stdio runs with Node from a checkout; the image is in the private GHCR package.

## Set up

Needs Node 22+.

1. **A RealtyCalendar user for the MCP** (Settings → Users), recommended: give it only the objects and role it needs.
   Its actions then show up under its own name in RC's history, and a read-only RC role is the real guarantee for
   read-only use.
2. **Build** from a checkout of the release tag:

   ```sh
   git checkout v0.2.1
   npm ci && npm run build
   ```

3. **Token**: `node dist/main.js login` asks for that user's login and password and prints a token. The password is
   not stored. The token is a separate RC session: logging out in the browser doesn't end it.
4. **Check**: `RC_TOKEN=… node dist/main.js check` shows the user, the agency and the access level.
5. **Add it to your client** (below) with `RC_TOKEN` and the `RC_ACCESS` level you want.

To revoke the token: `RC_TOKEN=… node dist/main.js logout` (ends only that session).

### Personal data

Guest names, phones and notes pass through the server (nothing is stored; logs carry no guest data) and go to the
model provider of your MCP client (Anthropic, OpenAI…), as with any use of an AI assistant. The hotel is the operator
of this data under 152-FZ and may need to mention the transfer, including abroad, in its privacy notice.
`RC_AUDIT=full` writes guest data to the log stream; use it only when you need it.

## Hosted server (Claude web, ChatGPT)

The same tools over Streamable HTTP at `<MCP_PUBLIC_URL>/mcp`, with a built-in OAuth server: each user signs in with
their RealtyCalendar login on the server's page and picks an access level (up to `RC_ACCESS`). No database: all state
is in tokens encrypted with `MCP_SERVER_KEY`. Clients: Claude (web, Desktop, mobile), Claude Code, ChatGPT
([plan-m4.md](docs/plan-m4.md)).

The image `ghcr.io/stek29/realtycalendar-web-mcp` (linux/amd64, linux/arm64; private: `docker login ghcr.io` with a
GitHub token that has `read:packages`) is built by GitHub Actions: `:main` from the main branch, `:X.Y.Z` and `:latest`
from release tags. `docker build .` builds it locally.

Samples: [deploy/docker-compose.yml](deploy/docker-compose.yml) (hardened, plain HTTP behind your TLS reverse proxy)
and [deploy/k8s.yaml](deploy/k8s.yaml). Settings, besides the ones below:

| Variable | Meaning |
|---|---|
| `MCP_PUBLIC_URL` | the public origin, e.g. `https://rc.example.com` (https, except `localhost`) |
| `MCP_SERVER_KEY` | secret, `openssl rand -base64 32`; losing or changing it disconnects every user |
| `MCP_SERVER_KEY_PREVIOUS` | the old key while rotating: tokens under it still work; drop it after 30 days |
| `PORT` | default 8080; `GET /healthz` for probes |
| `MCP_TRUST_PROXY_HOPS` | reverse proxies in front that append to `X-Forwarded-For` (default 0); logs then show the real client IP, and a client can't fake it |

`RC_ACCESS` is the highest level a connection may pick; `RC_TOKEN` and `RC_CONFIRM_KEY` are not used. Add the
connector with the URL `https://…/mcp` (Claude: Settings → Connectors → Add custom connector; ChatGPT: Settings → Apps
→ developer mode → Create; Claude Code: `claude mcp add --transport http realtycalendar https://…/mcp`).

## Develop

```sh
npm run check                           # typecheck, lint, unit tests
npm run tools                           # print the instructions and tools/list for RC_ACCESS / RC_SITE_BOOKINGS
npm run evals -- --case U5a --repeat 1  # evals on the fake RC (plan-m3.md); needs the claude / codex CLIs
RC_LIVE=1 RC_TOKEN=… npm run test:live  # live write tests on the approved test window (plan-m2.md)
```

## Settings (env)

| Variable | Default | Meaning |
|---|---|---|
| `RC_TOKEN` | – | RC session token, from `login` |
| `RC_ACCESS` | `read` | `read` · `book` (+ create) · `edit` (+ update, cancel) · `full` (+ delete) |
| `RC_SITE_BOOKINGS` | `protect` | `protect`: bookings from booking sites (Ostrovok, Yandex Travel…) can't get new dates, category, status or price, and can't be cancelled or deleted, since RC doesn't send such changes to the site; a room in the same category, times and notes can still change. `allow`: all changes, with a warning |
| `RC_TIMEZONE` | `Europe/Moscow` | the hotel's time zone |
| `RC_AUDIT` | `summary` | audit line per write on stderr; `full` adds the booking before the write (guest data) |
| `RC_CONFIRM_KEY` | random per process | key for the preview's confirm token |

## Clients

Every write is two tools: `preview_<write>` (read-only, returns a preview and a `confirm_token`) and `<write>`, which
needs the token. **Your approval of the write is the client's tool prompt**, so never set the write tools
(`create_booking`, `update_booking`, `cancel_booking`, `delete_booking`) to "always allow". The read tools and the
`preview_*` tools are safe to always allow.

Claude Desktop (`claude_desktop_config.json`):

```jsonc
{ "mcpServers": { "realtycalendar": {
    "command": "node", "args": ["/path/to/realty/dist/main.js"],
    "env": { "RC_TOKEN": "…", "RC_ACCESS": "edit" } } } }
```

Claude Code: `claude mcp add realtycalendar -e RC_TOKEN=… -e RC_ACCESS=edit -- node /path/to/realty/dist/main.js`.
Don't put the write tools in `allowedTools`.

Codex (`~/.codex/config.toml`). Codex refuses MCP tools that aren't read-only unless the server sets
`default_tools_approval_mode`: `prompt` should ask you before each call (not tested); `approve` runs them without
asking (tests only).

```toml
[mcp_servers.realtycalendar]
command = "node"
args = ["/path/to/realty/dist/main.js"]
env = { RC_TOKEN = "…", RC_ACCESS = "edit" }
default_tools_approval_mode = "prompt"
```

## Docs

| Doc | What's in it |
|---|---|
| [docs/mcp-tool-spec.md](docs/mcp-tool-spec.md) | The 12 tools (4 read, 4 writes with their preview tools): descriptions, inputs/outputs, errors, access levels, sample prompts (acceptance tests) |
| [docs/architecture.md](docs/architecture.md) | Runtime behaviour: RC client, write path, privacy, local stdio, hosted stateless OAuth |
| [docs/technical-structure.md](docs/technical-structure.md) | Stack, repository layout, interfaces, entrypoints, build order |
| [docs/mcp-user-stories.md](docs/mcp-user-stories.md) | User stories and the live-tested API behaviour behind the design |
| [docs/api-scope.md](docs/api-scope.md) | Reference of the web app's API (what exists) |
| [docs/plan-m2.md](docs/plan-m2.md) | M2 (write tools): modules, confirm tokens, fake RC, unit tests, live test protocol and approved scope |
| [docs/plan-m3.md](docs/plan-m3.md) | M3: evals and benchmark (Sonnet, Haiku, Codex), real-client checks, login/logout, audit log, release |
| [docs/decisions.md](docs/decisions.md) | Log of decisions and agreed scope since the design, with the evidence |
| [test/evals/cases.json](test/evals/cases.json) | Spec §3 stories as machine-readable eval cases |
| [docs/endpoints/](docs/endpoints/) | Endpoint lists extracted from the web app bundles (`scripts/extract_endpoints.py`) |

## Local secrets

`.rc-credentials` (git-ignored) holds `username:password` of the dedicated RealtyCalendar test user for local live tests.
Never commit it.
