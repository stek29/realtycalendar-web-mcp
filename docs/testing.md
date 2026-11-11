# Testing

Run the existing local checks from a checkout:

```sh
npm ci
npm run check
npm run build
```

Unit tests use fictional fixture identifiers, contacts, dates and financial examples. They do not need a live RC
account. Calendar examples use 2054–2055; dates in protocol identifiers are actual protocol versions.
No live tests or paid model evals run as part of `npm run check`.

## Evals

Purpose: check that real models pick the right tools with the right arguments from the descriptions and schemas, and
answer with what the spec requires — and compare models on cost and efficiency. Run whenever tool descriptions,
schemas or instructions change, and before a release.

### Server under test: fake-RC mode

`test/evals/fake-server.ts` — the real `createMcpServer` over stdio, with:
- `fetch` = the fake RC (`test/fake-rc.ts`) plus the eval scenario (`test/evals/scenario.ts`: synthetic bookings the
  prompts refer to — "Анна Петрова", "Иванов", an Ostrovok booking made "yesterday", booking 810000208 with a
  prepayment, a hold, unassigned bookings; fake names only, allowlisted by the fixture check);
- clock fixed by `EVAL_NOW` (default `2054-10-22T09:00:00+03:00`, Thursday, as in spec §3);
- `RC_ACCESS` from the case; `RC_CONFIRM_KEY` fixed, so a confirm token issued in turn 1 is valid in turn 2 (each CLI
  invocation starts a new server process);
- fake RC writes persisted to `EVAL_STATE` (a temp JSON file per case run), so a booking created in one turn exists in
  the next.

The fake server uses fictional fixture data. No live data reaches a model in evals.

### Cases

`test/evals/cases.json`, one entry per spec §3 story:

```jsonc
{ "id": "U5a", "access": "full",
  "turns": ["Забронируй 22-й на 7–9 ноября для Анны Петровой, +7 900 123-45-67"],
  "expect": [                                   // per turn
    { "calls": [ { "tool": "preview_create_booking", "args": { "room": { "re": "^22" }, "check_in": "2054-11-07", … } },
                 { "tool": "create_booking", "args": { "room": { "re": "^22" }, … }, "confirm_token": true } ],
      "answer": ["\\d{6,}"] } ] }
```

Writes are one turn (D35): the preview tool, then the write tool with the token. Headless clients approve the write
tool's call at once (Claude via `--allowedTools`, Codex via `default_tools_approval_mode`), standing in for the user's
approval in the client prompt. So a case can't put a user's change of mind between preview and write (U6g); that path
(`PREVIEW_STALE`) is covered by unit tests, and the case has `skip` with the reason.

- `calls`: required tool calls with an argument subset, in any order; extra read calls (preview
  tools included) are allowed (counted in the benchmark), extra write calls are not; a write must come after a
  preview with the same arguments.
- `answer`: regexes the final answer must match (dates used, amounts, "can't do that in v1" …).
- `forbid`: tools that must not be called (X1–X7 negative stories: no writes, no fabricated payment calls).

### Runners

Each runner spawns a headless client per turn, with stdin from `/dev/null` and the working directory set to an empty
temp directory per case, and reads the tool calls from its event stream. The server is started by the client as
`node_modules/.bin/tsx test/evals/fake-server.ts`. Verified 2054-10-22 with a throwaway fake-RC server (two turns on
each client: "Что свободно на выходные?" → `check_availability(2054-10-23, 2054-10-25)`, then "А на следующие?" →
`check_availability(2054-10-30, 2054-11-01)`).

| Runner | Command (per turn) | Role |
|---|---|---|
| `claude-sonnet` | `claude -p <prompt> --model claude-sonnet-5-5 --strict-mcp-config --mcp-config <cfg.json> --tools "" --allowedTools mcp__realtycalendar --setting-sources project --output-format stream-json --verbose --max-budget-usd 1`; turn 2+ adds `--resume <session_id>` (from the `system/init` event) | **gate** |
| `codex` | `codex exec --json -m gpt-6.1-sol -s read-only --skip-git-repo-check --ignore-user-config -C <dir> <disable…> -c mcp_servers.realtycalendar.command="<tsx>" -c mcp_servers.realtycalendar.args=["<server>"] -c mcp_servers.realtycalendar.default_tools_approval_mode="approve" <prompt>`; turn 2+ `codex exec resume <thread_id> --json -m gpt-6.1-sol -c sandbox_mode="read-only" --skip-git-repo-check --ignore-user-config <disable…> -c mcp_servers… <prompt>` run from the same directory (`resume` takes neither `-s` nor `-C`) | **gate** (non-Claude client; ChatGPT is a target in M4) |
| `claude-haiku` | as `claude-sonnet` with `--model claude-haiku-5-5` | floor: reported, not gating |
| `opencode:<model>` | `opencode run --pure --format json --dir <dir> -m opencode/<model> [-s <session>] <prompt>`, MCP server and permissions (shell, edits, web denied) in `<dir>/opencode.json` | extra, e.g. OpenCode's free models (`opencode models`); fake RC only, refused in `--live` |

- Every client runs under `sandbox-exec` (macOS): it can't read `rc.token` / `.rc-credentials` or write in the
  repo (D49). OpenCode's free tier refuses requests without opencode's built-in tools, so those stay, denied by
  permissions and the sandbox.
- Codex refuses tools that aren't read-only ("MCP tool call requires approval, but approval policy is never") unless
  the server has `default_tools_approval_mode` = `approve` (values: `auto`, `prompt`, `writes`, `approve`); found
  2054-10-22 when the write tools were first called (D33).
- Claude: `--tools ""` leaves only the MCP tools (the `init` event lists only the `mcp__realtycalendar__*`
  tools); `--strict-mcp-config` ignores the user's other MCP servers; `--setting-sources project` with an empty
  working directory keeps user settings, hooks and plugins out. Tool calls: `assistant` events with `tool_use`
  blocks; cost, turns and duration: the final `result` event (about $0.04–0.06 per turn on Sonnet).
- Codex: `<disable…>` = `--disable shell_tool --disable unified_exec --disable plugins --disable apps --disable
  browser_use --disable in_app_browser --disable computer_use`. Without them the model first explored the filesystem
  with a shell command and used ~95k input tokens per turn; with them only the MCP tool is called (~56k, mostly
  cached). `--ignore-user-config` keeps the user's Codex config and MCP servers out (auth still works). MCP tool calls
  need no approval in `exec`. Events: `thread.started` (`thread_id`), `item.completed` with `item.type ==
  "mcp_tool_call"` (`tool`, `arguments`, `result`, `error`), `agent_message` (the answer text), `turn.completed`
  (`usage`: token counts; Codex reports no cost).
- Each case gets its own environment: `RC_ACCESS` from the case, a fixed `RC_CONFIRM_KEY`, `EVAL_STATE` pointing at
  a fresh temp file, passed via the MCP config's `env`.
- `codex exec` doesn't give the model the MCP server's `instructions` (checked 2054-10-22: Claude quotes them, Codex
  says it has none). The Codex runner passes them as `developer_instructions`, like a client that honours them (D47).
- Caveat: these clients have their own system prompts (a coding agent), not Claude Desktop's or ChatGPT's. Evals test
  our descriptions and instructions, not the exact production client — hence the release check in §2.
- Cost limits: `--max-budget-usd` per Claude run; a whole run is about 40 cases × 2 turns × 3 repeats per runner.

### Grading and gate

- Deterministic: tool calls and arguments from the event stream; answer regexes. No LLM judge in v1; failures are
  reviewed by reading the transcript.
- Each case runs 3 times per runner (models are not deterministic). A case passes on a runner if ≥ 2 of 3 runs pass.
- **Gate (M3 "evals green")**: every case passes on `claude-sonnet` (historical baseline; other runners are reported separately). A case that regresses on another runner is looked at.
- A failure that only one client shows is fixed in our descriptions, schemas or instructions, not with
  client-specific wording, unless the transcript shows a client bug.

### Benchmark report

`npm run evals -- [--runner claude-sonnet,claude-haiku,codex] [--case U5a,…] [--repeat 3]` writes
`test/evals/reports/<timestamp>.json` (git-ignored) and prints a table per runner:

| Metric | Meaning |
|---|---|
| pass rate | cases passed / total, and per story group (U, R, Q, P, X) |
| tool calls per case | mean, and extra calls beyond the expected ones (efficiency of descriptions) |
| wrong-tool rate | first call to a tool other than the expected one |
| tokens and cost | Claude: cost and tokens from the `result` event; Codex: tokens from `turn.completed` (no cost reported) |
| latency | wall time per turn |

Record the runner, cases and repeat count when reporting a result. Never commit live transcripts.


## Live checks

Live checks are manual and opt-in. Use an isolated test account and select an empty window explicitly approved for
that account. The checked-in dates and room/category layout are examples, not authorization to test a real hotel.
Before running, adapt `test/live/writes.live.test.ts` to that account's rooms, dates, pre-check window and category.
Do not commit its account-specific configuration or resulting records.

```sh
RC_LIVE=1 RC_TOKEN=… npm run test:live
```

The suite preserves these safeguards and scenarios:

Safety, enforced in code, not by convention:
1. **Write firewall**: the live tests' `fetch` wrapper rejects any POST/PUT/DELETE that is not (a) a POST whose dates
   lie in 2055-01-20…2055-01-23, or (b) a PUT/DELETE to a booking id created by this run; and any PUT whose guest/
   client name doesn't start with "TEST MCP". A rejection fails the test before anything reaches RC.
2. **Pre-check**: grid for all categories, 19–24 Jan 2055, all statuses: abort unless empty (or only "TEST MCP"
   bookings, which are cleaned up first).
3. **Cleanup** in `afterAll`: `DELETE` every id created by the run (drafts answer 404, expected); then assert the grid
   for 19–24 Jan is empty again. Failures are reported with the ids.

Scenarios, all through the MCP tools (`preview_*` → write tool with the token), in order:

| # | Scenario | Checks |
|---|---|---|
| L1 | create "TEST MCP Иван" in room 5, 20–23 Jan, no price, arrival 14:00 (for L9) | preview shows the quote; result id; `get_booking` matches; `list_bookings(query="TEST MCP")` finds it |
| L2 | same create again | `DUPLICATE`, no token, nothing created |
| L3 | create in room 5 overlapping L1 | preview `will_fail`, no token |
| L4 | preview a create in room 6, then occupy room 6 with another create, then confirm the first; then cancel the occupier so room 6 is free for L7 | RC 422 → `OCCUPIED`, "nothing was saved" (leaves one invisible draft — known, D19) |
| L5 | hold (request) in category 01 without a room | unassigned hold; `check_availability` lists it, capacity unchanged |
| L6 | update L1: dates 20–23 → 21–23 | `PRICE_CHANGED`; amount = average × 2 |
| L7 | assign the hold to room 6, then confirm it (request → booked) | room set; status booked |
| L8 | move L1 to room 21 (category 02) | `CATEGORY_CHANGE`, `PRICE_KEPT`; `apartment_id` = 02 |
| L9 | unassign L1; notes_append; clear arrival time | each a separate preview/confirm; untouched fields unchanged (S3 regression) |
| L10 | preview an update, change the booking with another update, confirm the first token | `PREVIEW_STALE` + fresh preview |
| L11 | single-unit: create in category 04, then an overlapping one | second preview `will_fail` |
| L12 | cancel L1 | status canceled; `check_availability` shows the room bookable |
| L13 | delete the hold; then update it | delete ok; update → `DELETED` |


RC may retain guest records, soft-deleted bookings and invisible drafts after test cleanup. Payment writes are not
part of the suite. Never run it on a production account merely because the visible calendar looks empty.

`scripts/test-session.sh` checks login/check/logout using ignored local credentials. It prints no password or token.
The eval runner also supports `--live` read-only checks. Real guest data then goes to the chosen model provider;
the runner avoids persisted transcripts and removes its temporary client sessions. The OS sandbox runner currently
uses macOS `sandbox-exec`; that command is required for model evals.

## Fixture maintenance

Use fictional examples when updating fixtures. Keep linked identifiers and filenames consistent with the fake RC,
unit tests and eval scenario. Do not add raw recordings from a live account. The legacy `scrub-fixture.ts` helper
replaces contact fields but is not sufficient to anonymize recordings: it retains identifiers and operational data.
Existing fixture hygiene tests cover fake contacts and allowlisted names, not complete anonymization.
