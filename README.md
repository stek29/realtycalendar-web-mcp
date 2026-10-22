# realtycalendar-web-mcp

MCP server for [RealtyCalendar](https://realtycalendar.ru) — lets Claude, ChatGPT and other MCP clients check
availability and manage bookings through RealtyCalendar's web app API.

Status: v0.1.0 — 4 read tools and 4 write tools (create, update, cancel, delete), each write with a read-only preview
tool; audit log; `login` / `logout`. Not published: run it with Node from a checkout. A Docker image comes with the
hosted HTTP server (M4), for Kubernetes / docker compose.

## Set up

Needs Node 22+.

1. **A RealtyCalendar user for the MCP** (Settings → Users), recommended: give it only the objects and role it needs.
   Its actions then show up under its own name in RC's history, and a read-only RC role is the real guarantee for
   read-only use.
2. **Build** from a checkout of the release tag:

   ```sh
   git checkout v0.1.0
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
