# realtycalendar-web-mcp

MCP server for [RealtyCalendar](https://realtycalendar.ru) — lets Claude, ChatGPT and other MCP clients check
availability and manage bookings through RealtyCalendar's web app API.

Status: M1 (read tools) and M2 (write tools: create, update, cancel, delete, each with a read-only preview tool)
done; from M3, the audit log and `login` / `logout` are in. Evals and the release are next. Released as a Docker
image only (no npm package); the image isn't built yet, so the examples below run `dist/main.js` directly.

## Run locally

```sh
npm install && npm run build
node dist/main.js login                 # asks for the RC login and password, prints a token for RC_TOKEN
RC_TOKEN=… node dist/main.js check      # token works? user, agency, access level
RC_TOKEN=… node dist/main.js logout     # ends that RC session
npm run check                           # typecheck, lint, unit tests
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

Claude Desktop (`claude_desktop_config.json`), until the Docker image exists (then `"command": "docker"`, `"args":
["run", "-i", "--rm", "-e", "RC_TOKEN", "-e", "RC_ACCESS", "<image>"]`):

```jsonc
{ "mcpServers": { "realtycalendar": {
    "command": "node", "args": ["/path/to/realty/dist/main.js"],
    "env": { "RC_TOKEN": "…", "RC_ACCESS": "edit" } } } }
```

Claude Code: `claude mcp add realtycalendar -e RC_TOKEN=… -e RC_ACCESS=edit -- node /path/to/realty/dist/main.js`.
Don't put the write tools in `allowedTools`.

Codex (`~/.codex/config.toml`). Codex refuses MCP tools that aren't read-only unless the server sets
`default_tools_approval_mode`: `prompt` asks you before each call; `approve` runs them without asking (tests only).

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
