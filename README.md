# realtycalendar-web-mcp

MCP server for [RealtyCalendar](https://realtycalendar.ru) — lets Claude, ChatGPT and other MCP clients check
availability and manage bookings through RealtyCalendar's web app API.

Status: M1 (read tools) and M2 (write tools: create, update, cancel, delete with preview → confirm) implemented;
M3 (evals, login/logout, audit log, release) next. Writes are not released before M3.

## Run locally

```sh
npm install && npm run build
RC_TOKEN=… node dist/main.js check      # token works? user, agency, access level
npm run check                           # typecheck, lint, unit tests
RC_LIVE=1 RC_TOKEN=… npm run test:live  # live write tests on the approved test window (plan-m2.md)
```

Claude Desktop (`claude_desktop_config.json`), until the package is published:

```jsonc
{ "mcpServers": { "realtycalendar": {
    "command": "node", "args": ["/path/to/realty/dist/main.js"],
    "env": { "RC_TOKEN": "…", "RC_ACCESS": "read", "RC_TIMEZONE": "Europe/Moscow" } } } }
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
