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

- Use during implementation (owner, D37): small checks run on `codex` only; `claude-sonnet` (and Haiku) are for the
  full eval runs.
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
  guest data); only pass/fail and counts. Claude runs with `--no-session-persistence`, Codex with `--ephemeral`;
  `RC_TOKEN` stays in the environment (Codex: `env_vars`) instead of the client's config file; each run removes its
  temp directory and the client's own files for it (`~/.claude/projects/<dir>`, `~/.codex/sessions/…<thread>.jsonl`).
  Default runner: `claude-sonnet`; `--runner codex,claude-sonnet` also works. Real guest data reaches Anthropic, as in any real use.
- ~~Claude Desktop~~: dropped (owner, D48). The real-client check moves to M4: Claude web and ChatGPT web with the
  hosted HTTP server, the actual targets.

## 3. login / logout

- `realtycalendar-web-mcp login`: asks for the RC username (e-mail or phone) and the password (hidden input,
  `node:readline` with muted output, prompts on stderr); `POST /v2/sign_in` without a token header; prints only the
  token on stdout, for `RC_TOKEN`. The password is never stored or logged. No keychain (owner, D31).
- `realtycalendar-web-mcp logout`: `DELETE /v2/sign_in` with `RC_TOKEN` (ends only this session ✅).
- Tests: unit tests with a fake `fetch` (`test/unit/login.test.ts`). Live: the owner runs `login` once (the
  assistant doesn't handle the password), then `check` and `logout`.

## 4. Audit log

Per confirmed write (architecture.md "Write path"), one JSON line:
- Destination: the server's log stream (stdio: stderr, with the logs; stdout is the MCP channel). The only
  destination for now (owner, D32); `AuditSink { write(entry) }` in `Context` keeps it portable.
- Detail `RC_AUDIT=summary|full` (default `summary`). `summary`: `event: "audit"`, `time`, `tool`, `booking_id`
  (null for a create that got no id), `rc_user_id`, `fields` (RC field names written), `result` (`ok`,
  `already_existed` for a repeated create, or the error code); no guest data. `full` adds `before`, the full
  pre-write GET body (guest names, phones, notes) for manual undo; not passed through log redaction, so only on
  request.
- Written by `defineWriteTool` after RC answers, for success and failure alike; previews write nothing. A failing sink
  is logged as `audit_failed` and doesn't fail the tool (the write already happened).
- Code: `src/audit.ts`. Tests: `test/unit/audit.test.ts`, the write-tool tests; live: L1 and L12 assert an entry each.

## 5. Packaging and release

Nothing is published (owner, D42): no npm package, and no Docker image for stdio. v1 is run with Node from a checkout.

- `package.json`: version `0.1.0`, `bin`, `engines.node >= 22`; tag `v0.1.0` in git.
- README: setup from a checkout (`npm ci && npm run build`, client config `node /path/to/dist/main.js`), `login` /
  `check`, access levels, the dedicated RC user recommendation, a short personal-data note for hotels
  (architecture.md "Personal data").
- CI (needs the GitHub remote): `.github/workflows/ci.yml` runs `npm ci`, `npm run check` (typecheck, lint, unit tests with the fixture-PII check) and `npm run build` on Node 22;
  evals optional (need an API key secret). Workflow file prepared; enabled when the remote exists.
- The Docker image is M4 and serves only the hosted HTTP server (Kubernetes, docker compose).

## Done when

- Evals gate green on Sonnet and Codex; Haiku results reported.
- Live read-only client check passes. (Claude Desktop check dropped, D48.)
- `login` / `check` / `logout` verified by the owner. ✅ 2054-10-22, `scripts/test-session.sh` (D45)
- Audit entries written in the live write tests.
- v0.1.0 tagged; README setup from a checkout.

## Later (M4 candidate): MCP elicitation

Not in v1 (D36). Elicitation lets the server ask the user directly in a client-rendered dialog the model can't answer,
which would make the approval independent of the client's tool prompt. Claude web doesn't document support for it,
so the token plus the client prompt must work without it anyway. Prototype findings (M1 session, 2054-10-22):
- SDK 2.3.1: one handler that returns `inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message,
  requestedSchema }) } })` and reads `acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema)` on re-entry
  serves both protocol eras: `claude -p` used 2026-07-28; Codex used the 2053 protocol through the SDK's legacy shim.
- A client without the elicitation capability gets an `isError` result, so check capabilities first.
- Headless runs answer the dialog automatically (`claude -p`: cancel, `codex exec`: decline), so evals can't exercise
  it.
