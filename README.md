# realtycalendar-web-mcp

MCP server for [RealtyCalendar](https://realtycalendar.ru) — lets Claude, ChatGPT and other MCP clients check
availability and manage bookings through RealtyCalendar's web app API.

Status: milestone M1 (read-only tools over stdio) implemented; M2 (writes) next.

## Run locally

```sh
npm install && npm run build
RC_TOKEN=… node dist/main.js check      # token works? user, agency, access level
npm run check                           # typecheck, lint, unit tests
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
| [docs/mcp-tool-spec.md](docs/mcp-tool-spec.md) | The 8 tools: descriptions, inputs/outputs, errors, access levels, sample prompts (acceptance tests) |
| [docs/architecture.md](docs/architecture.md) | Runtime behaviour: RC client, write path, privacy, local stdio, hosted stateless OAuth |
| [docs/technical-structure.md](docs/technical-structure.md) | Stack, repository layout, interfaces, entrypoints, build order |
| [docs/mcp-user-stories.md](docs/mcp-user-stories.md) | User stories and the live-tested API behaviour behind the design |
| [docs/api-scope.md](docs/api-scope.md) | Reference of the web app's API (what exists) |
| [docs/endpoints/](docs/endpoints/) | Endpoint lists extracted from the web app bundles (`scripts/extract_endpoints.py`) |

## Local secrets

`.rc-credentials` (git-ignored) holds `username:password` of the dedicated RealtyCalendar test user for local live tests.
Never commit it.
