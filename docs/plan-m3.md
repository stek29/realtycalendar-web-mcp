# M3 plan: evals, client checks, login/logout, audit log, release

Status: plan, 2054-10-22. Builds on M2 ([plan-m2.md](plan-m2.md)). Agreed decisions: [decisions.md](decisions.md)
(D22, D23 for testing). Acceptance prompts: [mcp-tool-spec.md](mcp-tool-spec.md) §3; machine-readable copy:
[`test/evals/cases.json`](../test/evals/cases.json).

## 1. Evals and benchmark

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

No live data reaches a model in evals.

### Cases

`test/evals/cases.json`, one entry per spec §3 story:

```jsonc
{ "id": "U5a", "access": "full",
  "turns": ["Забронируй 22-й на 7–9 ноября для Анны Петровой, +7 900 123-45-67", "да"],
  "expect": [                                   // per turn
    { "calls": [ { "tool": "create_booking", "args": { "room": "22", "check_in": "2054-11-07", … }, "no_token": true } ],
      "answer": ["(?i)подтверд|preview|да\\?"] },
    { "calls": [ { "tool": "create_booking", "has_token": true } ], "answer": ["\\d{9}"] } ],
  "forbid": ["delete_booking"] }
```

- `calls`: required tool calls with an argument subset; `any_order` for independent calls; extra read calls are
  allowed (counted in the benchmark), extra write calls are not.
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
| `claude-sonnet` | `claude -p <prompt> --model sonnet --strict-mcp-config --mcp-config <cfg.json> --tools "" --allowedTools mcp__realtycalendar --setting-sources project --output-format stream-json --verbose --max-budget-usd 1`; turn 2+ adds `--resume <session_id>` (from the `system/init` event) | **gate** |
| `codex` | `codex exec --json -m gpt-6.1-sol -s read-only --skip-git-repo-check --ignore-user-config -C <dir> <disable…> -c mcp_servers.realtycalendar.command="<tsx>" -c mcp_servers.realtycalendar.args=["<server>"] <prompt>`; turn 2+ `codex exec resume <thread_id> --json -m gpt-6.1-sol -c sandbox_mode="read-only" --skip-git-repo-check --ignore-user-config <disable…> -c mcp_servers… <prompt>` run from the same directory (`resume` takes neither `-s` nor `-C`) | **gate** (non-Claude client; ChatGPT is a target in M4) |
| `claude-haiku` | as `claude-sonnet` with `--model haiku` | floor: reported, not gating |

- Claude: `--tools ""` leaves only the MCP tools (the `init` event lists exactly the four `mcp__realtycalendar__*`
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
- Caveat: these clients have their own system prompts (a coding agent), not Claude Desktop's or ChatGPT's. Evals test
  our descriptions and instructions, not the exact production client — hence the release check in §2.
- Cost limits: `--max-budget-usd` per Claude run; a whole run is about 40 cases × 2 turns × 3 repeats per runner.

### Grading and gate

- Deterministic: tool calls and arguments from the event stream; answer regexes. No LLM judge in v1; failures are
  reviewed by reading the transcript.
- Each case runs 3 times per runner (models are not deterministic). A case passes on a runner if ≥ 2 of 3 runs pass.
- **Gate (M3 "evals green")**: every case passes on **both** `claude-sonnet` and `codex`. Haiku is reported, not
  gating; a case that regresses on it is looked at.
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

The summary table goes into the commit message of the change that ran it.

## 2. Real-client checks (D22)

- **Live read-only check** (replaces the M1 Claude Desktop gate): the same harness in `--live` mode starts the real
  server (`dist/main.js`) with `RC_TOKEN` and `RC_ACCESS=read`, runs the M1 read cases (U1–U4, U9, U10, U12, R1–R3)
  on `claude-sonnet`, and checks tool calls and that no call errors. Transcripts are **not** written to disk (real
  guest data); only pass/fail and counts. Real guest data reaches Anthropic, as in any real use.
- **Claude Desktop**, once before the v1 release: the owner adds the server to Claude Desktop and asks three prompts
  (U1a, U4a, X5). Confirms the client launches the server, shows the tools and uses the instructions.

## 3. login / logout

- `realtycalendar-web-mcp login [--keychain]`: asks for the RC username (e-mail or phone) and the password (hidden
  input, `node:readline` with muted output); `POST /v2/sign_in`; prints the token, or with `--keychain` stores it:
  macOS `security add-generic-password -U -s realtycalendar-web-mcp -a <username> -w <token>`, Linux
  `secret-tool store`, elsewhere an error saying to use RC_TOKEN. The password is never stored or logged.
- The stdio server and `check` read the token from `RC_TOKEN`, else from the keychain.
- `realtycalendar-web-mcp logout`: `DELETE /v2/sign_in` with that token (ends only this session ✅), removes the
  keychain entry.
- Tests: unit tests with a fake `fetch` and a fake keychain runner. Live: the owner runs `login` once (the assistant
  doesn't handle the password), then `check` and `logout`.

## 4. Audit log

Per confirmed write (architecture.md "Write path"):
- `AuditSink { write(entry): Promise<void> }` in `Context` (portable); the stdio platform provides a file sink.
- File sink: `RC_AUDIT_DIR` (default macOS `~/Library/Logs/realtycalendar-web-mcp/`, Linux
  `$XDG_STATE_HOME/realtycalendar-web-mcp/` or `~/.local/state/…`, Windows `%LOCALAPPDATA%\realtycalendar-web-mcp\`),
  one file per day `audit-YYYY-MM-DD.jsonl`, directory 0700, files 0600; files older than 30 days deleted at start.
- Entry: `time`, `tool`, `booking_id`, RC user id, changed field names, RC HTTP status / error code, and the full
  pre-write GET body (for manual undo; this is why the file is local and 0600). Written after RC answers, for success
  and failure alike. Create entries have no pre-write body.
- Tests: unit (temp dir, permissions, rotation); live: L1 and L12 of plan-m2 assert an entry each.

## 5. Packaging and release

- `package.json`: version `1.0.0`, `bin`, `files: ["dist"]`, `engines.node >= 22`; `npm pack --dry-run` checked in a
  test (no fixtures, tokens or docs in the tarball).
- README: install (`npx -y realtycalendar-web-mcp@1.0.0` config), `login` / `check`, access levels, the dedicated RC
  user recommendation, a short personal-data note for hotels (architecture.md "Personal data").
- CI (needs the GitHub remote): GitHub Actions for typecheck, lint, unit tests (includes the fixture-PII check);
  evals optional (need an API key secret). Workflow file prepared; enabled when the remote exists.
- Publish: npm with provenance from CI — needs the owner's npm account and the remote.

## Done when

- Evals gate green on Sonnet and Codex; Haiku results reported.
- Live read-only client check passes; Claude Desktop check done by the owner.
- `login` / `check` / `logout` verified by the owner.
- Audit entries written in the live write tests.
- `npm pack` contents checked; v1.0.0 published (owner).
