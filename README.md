# realtycalendar-web-mcp

An MCP server for [RealtyCalendar](https://realtycalendar.ru) that lets AI assistants check room availability,
find reservations, and create, update, cancel or delete bookings.

Run it locally over stdio or self-host it over HTTP for connector clients. Access defaults to read-only.
Every write uses a separate preview step and requires approval through the client's write-tool prompt.

- List categories and rooms, availability, prices and stay restrictions.
- Find stays, arrivals, departures, unpaid and unassigned bookings.
- Read booking details, payments and optional change history.
- Create, update, cancel and delete bookings at the configured access level.

This uses RealtyCalendar's unofficial web app API, which can change without notice. Payment writes, guest-contact
editing and searches by booking creation date are outside the current tool set.

Current release: **v0.4.0**. There is no npm package. Local stdio runs from a checkout; Docker serves hosted HTTP.

## Choose a setup

| Setup | Use it for | Requirements |
| --- | --- | --- |
| [Hosted HTTP](#hosted-http) | A connector URL for Claude or ChatGPT | Docker, an HTTPS reverse proxy and a persistent server key |
| [Local stdio](#local-stdio) | A local MCP client such as Claude Desktop, Claude Code or Codex | Node.js 22+ and an RC session token |

Create a dedicated RealtyCalendar user with only the objects and role it needs (Settings → Users). Its actions then
appear under its own identity in RC's history. Use an upstream read-only role when access must be read-only.

Clone the repository for either setup:

```sh
git clone https://github.com/stek29/realtycalendar-web-mcp.git
cd realtycalendar-web-mcp
```

To build a specific release locally, run `git checkout v0.4.0` before building.

## Hosted HTTP

The hosted server exposes Streamable HTTP at `<MCP_PUBLIC_URL>/mcp`. Each connection signs in with its own
RealtyCalendar credentials and picks an access level, capped by the server's `RC_ACCESS` setting.

The OAuth implementation accepts Claude, Claude Code and ChatGPT client metadata. End-to-end validation in
Claude web and ChatGPT web is still pending; see [remaining work](docs/roadmap.md).

### Deploy

The image `ghcr.io/stek29/realtycalendar-web-mcp` supports linux/amd64 and linux/arm64. The package is currently
private: pulling it requires `docker login ghcr.io` with a GitHub token that has `read:packages` and access to the
package. Release images use version tags such as `0.4.0`; `main` tracks the main branch.

Use the [compose example](deploy/docker-compose.yml) behind your own HTTPS reverse proxy:

1. Generate a server key with `openssl rand -base64 32`.
2. Create `deploy/.env`, replacing the example origin and key:

   ```dotenv
   MCP_PUBLIC_URL=https://rc.example.com
   MCP_SERVER_KEY=REPLACE_WITH_GENERATED_KEY
   RC_ACCESS=read
   MCP_TRUST_PROXY_HOPS=1
   ```

3. Restrict access to that file, then start the server:

   ```sh
   chmod 600 deploy/.env
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
   ```

4. Forward your public HTTPS origin to `127.0.0.1:8080` and have the proxy append the client IP to `X-Forwarded-For`.
   Set `MCP_TRUST_PROXY_HOPS` to the actual number of trusted proxies in front of the server.

The container speaks plain HTTP. `GET /healthz` reports server health without contacting RC. A
[Kubernetes example](deploy/k8s.yaml) is also available. To build your own image, use
`docker build -t realtycalendar-web-mcp:local .` and select that image in your deployment configuration.

### Connect

Add `https://your-host/mcp` as a custom connector in your client and complete sign-in. For Claude Code:

```sh
claude mcp add --transport http realtycalendar https://your-host/mcp
```

Require approval for write tools in the client; see [write approval](#write-approval).

### Hosted settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_PUBLIC_URL` | required | Public origin without a path; HTTPS required except for local development |
| `MCP_SERVER_KEY` | required | Persistent base64/base64url secret of at least 32 bytes |
| `MCP_SERVER_KEY_PREVIOUS` | unset | Previous key accepted during rotation; keep it for the refresh-token lifetime of 30 days |
| `PORT` | `8080` | HTTP listening port |
| `MCP_TRUST_PROXY_HOPS` | `0` | Trusted proxies that append to `X-Forwarded-For`; `0` uses the direct peer address |

Keep the server key across restarts. Replacing it without retaining the previous key disconnects existing users.
Hosted mode obtains RC session tokens through sign-in and derives its confirmation key from the server key;
`RC_TOKEN` and `RC_CONFIRM_KEY` are local-stdio settings.

## Local stdio

Requires Node.js 22+.

```sh
npm ci
npm run build
node dist/main.js login
```

Login asks for the dedicated RC user's credentials and prints a session token. The local CLI does not store the
password. The token represents a separate RC session; browser logout does not end it.

Verify the connection with `RC_TOKEN=YOUR_SESSION_TOKEN node dist/main.js check`, then add the server to your client.
For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "realtycalendar": {
      "command": "node",
      "args": ["/absolute/path/to/realtycalendar-web-mcp/dist/main.js"],
      "env": { "RC_TOKEN": "YOUR_SESSION_TOKEN", "RC_ACCESS": "read" }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add realtycalendar -e RC_TOKEN=YOUR_SESSION_TOKEN -e RC_ACCESS=read -- node /absolute/path/to/realtycalendar-web-mcp/dist/main.js
```

For Codex (`~/.codex/config.toml`), start with read-only access:

```toml
[mcp_servers.realtycalendar]
command = "node"
args = ["/absolute/path/to/realtycalendar-web-mcp/dist/main.js"]
env = { RC_TOKEN = "YOUR_SESSION_TOKEN", RC_ACCESS = "read" }
```

Codex's `default_tools_approval_mode = "prompt"` has not been verified for this server. Verify its approval behavior
before enabling writes. Do not use automatic write approval for normal operation.

End the MCP's RC session with `RC_TOKEN=YOUR_SESSION_TOKEN node dist/main.js logout`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RC_TOKEN` | required | Session token printed by `login` |
| `RC_CONFIRM_KEY` | random per process | Key that signs preview confirmation tokens |

## Shared settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RC_ACCESS` | `read` | `read`; `book` adds create; `edit` adds update/cancel; `full` adds delete. In hosted mode, the maximum connection level |
| `RC_SITE_BOOKINGS` | `protect` | Protect booking-site reservations from changes RC does not send back to the site. `allow` permits those changes with a warning |
| `RC_TIMEZONE` | `Europe/Moscow` | Hotel time zone, using an IANA identifier |
| `RC_AUDIT` | `summary` | One audit entry per write; `full` includes the pre-write booking body and guest data |
| `RC_HIDE_GUEST_PII` | `false` | Hide known structured guest-name and phone fields in MCP responses; accepts `true`/`false` or `1`/`0` |

With `RC_SITE_BOOKINGS=protect`, booking-site reservations cannot receive new dates, category, status or price, or
be canceled/deleted. Assigning a room within the same category, changing arrival/departure times and adding notes
remain available.

### Hide guest names and phone numbers

Guest-name and phone masking is available starting with **v0.4.0**.

Set `RC_HIDE_GUEST_PII=true` in the server environment (or `deploy/.env` for the compose example) and restart the
server. This is a server-wide option for both hosted HTTP and local stdio; it also applies to existing hosted
connections, with no OAuth or token changes.

When enabled, structured guest names and phone numbers become `null`, including nested previews, conflicts and
warnings. Generated write summaries omit the guest name. Recognized guest-name and phone changes in history have
their old/new values hidden; recognized booking-site contact fields contain `[hidden]`.

Booking IDs, rooms, dates and financial data remain available. Names and phones remain intact inside RC: searches,
duplicate detection and writes still use the original values. Notes, other free text, guest emails and staff names
are untouched. This masks the specified response fields; it is not complete anonymization. `RC_AUDIT=full` still
writes the original booking body to server logs.

## Write approval

Each write is two calls: `preview_<write>` returns the proposed changes and a `confirm_token`; the write tool then
requires that token with the same arguments. The token binds the write to the preview. Approval must come from the
client's write-tool prompt; the token itself is not proof of human approval.

Require approval for `create_booking`, `update_booking`, `cancel_booking` and `delete_booking`. Do not mark them
“always allow” or add them to Claude Code's `allowedTools`.

Read and preview tools do not modify reservations. Automatically allowing them still grants access to the guest
data available to that connection.

## Data and credentials

Guest names, contacts, notes and booking details pass through the server to the model provider used by the client.
The server has no booking database. Default application logs omit guest contact details; clients, model providers
and hosting infrastructure may retain outputs or logs according to their own settings.

`RC_AUDIT=full` writes the pre-write booking body, including guest data, to logs. Logs and audit entries go to stderr
for local stdio and stdout for hosted HTTP.

Hosted authorization codes and refresh tokens contain RC credentials encrypted with `MCP_SERVER_KEY`, allowing
the server to sign in again when an RC session expires. Protect the key and client-held tokens. Authentication
limitations, including the lack of per-user revocation, are listed in [remaining work](docs/roadmap.md).

The hotel operator is responsible for applicable privacy obligations, including disclosures about transfers to the
model provider and any cross-border processing. Keep session tokens, client configuration containing tokens, server
keys and local credential files out of Git.

## Development

```sh
npm run check  # typecheck, lint and existing unit tests
npm run build
npm run tools  # print MCP instructions and tool schemas for the configured access level
```

Fixtures and documentation examples use fictional identifiers, contacts, dates and financial values. Model evals,
fixture maintenance and opt-in live testing are covered in the [testing guide](docs/testing.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [Tool specification](docs/mcp-tool-spec.md) | Inputs, outputs, errors and approval flow |
| [Architecture](docs/architecture.md) | Code structure, upstream client, caching, OAuth and privacy |
| [Booking workflows](docs/mcp-user-stories.md) | Upstream semantics and supported workflows |
| [API scope](docs/api-scope.md) | Endpoint reference |
| [Testing](docs/testing.md) | Unit checks, eval runners and opt-in live tests |
| [Remaining work](docs/roadmap.md) | Unfinished client validation and known limitations |
| [Design decisions](docs/decisions.md) | Rationale for the current implementation |
