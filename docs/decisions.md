# Decision log

Decisions and agreed scope since the design was finalised (2054-10-22), newest last. Each entry says what changed,
why, and where the docs were updated. The specs remain the source of truth; this file is the history.

## Implementation choices (M1)

| # | Decision | Why | Where |
|---|---|---|---|
| D1 | TypeScript 6.0, not 7 | typescript-eslint supports TypeScript < 6.1 only | package.json |
| D2 | Portability rule enforced by eslint (`no-restricted-imports` for `node:*`, `no-restricted-globals` for `process`) outside `src/platforms/` and `src/cli/` | the lint rule technical-structure.md asks for | eslint.config.js |
| D3 | `src/log.ts`: structured JSON lines through `domain/redact.ts` | one redaction layer for logs (architecture.md) | technical-structure.md layout |
| D4 | `mcp/tools/shared.ts`: input checks and the BookingSummary output shape | shared by the read tools | technical-structure.md layout |

## API findings that changed the design

| # | Decision | Evidence | Where |
|---|---|---|---|
| D5 | `list_bookings` uses the grid only; `arrivals_departures/by_dates` and cursor paging dropped | same phones, times, money and source as the grid on all 36 bookings checked | spec §2.3, S4, S6; architecture.md |
| D6 | Single-unit categories: bookings and closures are in the category's `room_id: null` grid row | live grid | spec §2.2, S5 |
| D7 | `special_prices.end_date` is exclusive; the stay-rules call is inclusive on both ends; room rule rows only used for closures | 243 room-nights matched the per-category rules | spec §2.2 |
| D8 | Grid `short_notes` = the booking's notes | equal to the detail's `notes` on all 3 bookings checked | schemas.ts |
| D9 | Price quote = sum of daily `amount.actual` from the stay-rules call (used by the fake RC) | matched RC's quote on 4 ranges | test/fake-rc.ts |
| D10 | Grid with `statuses[]=canceled` works | live grid | spec S7 |

## Matching

| # | Decision | Why | Where |
|---|---|---|---|
| D11 | Word rule: one word a prefix of the other (≥ 4 chars), or ≥ 4 shared leading chars with ≤ 3-letter endings; < 4 chars must be equal | the spec's prefix-only rule contradicted its own examples ("улучшенную" ~ "улучшенный") | spec §1 |
| D12 | Guest names compared as written and transliterated to Latin ("Игорь" ~ "Igor") | 10 of 60 live guest names are in Latin | spec §1, §2.3 |
| D13 | A name or phone query with no match returns a `hint` telling the model to list the period without `query` and read the names itself | spelling variants, nicknames and typos are better handled by the model; about 60 bookings per six months fit in one call | spec §2.3 |
| D14 | Loose matches (Марина ~ Мария) accepted | harmless for search (model sees full names); no write tool selects a booking by guest name | spec §2.3 |
| D15 | Phone search ignores a leading 8 / +7 on 11-digit numbers | Russian numbers are written both ways | domain/bookings.ts |

## Writes (from the live baseline, 2054-10-22)

| # | Decision | Evidence | Where |
|---|---|---|---|
| D16 | Update and cancel may ship: a PUT built from the GET (spec §2.6 mapping) changes nothing | S3 ✅: empty diff, same guest and client ids, no audit entry; only `updated_at` moved | spec S3 |
| D17 | `CLOSED_DATES` is warn-only and is the only guard | S2 ✅: RC saved a stay below min stay and one on closed nights | spec §1 warnings, S2 |
| D18 | Min stay = strictest night of the stay (unchanged); S9 not learnable from the API | RC saved stays crossing min-stay changes in both directions | spec S9 |
| D19 | Create = duplicate check → POST draft → PUT; never retry, never delete; after a timeout or 5xx tell the caller to repeat the confirm (the duplicate check returns a saved booking) | drafts can't be deleted (DELETE → 404), don't block rooms, stay saveable by PUT; an extra capacity check, follow-up GET and draft logging were dropped as over-engineering | spec §2.5, S8; architecture.md |
| D20 | Write results are built from the PUT / DELETE response | both return the full booking in the GET shape | spec §2.5 |
| D21 | Each create makes a new guest record (no reuse by phone); accepted | 5 creates → 5 guest records | mcp-user-stories.md |

## Process and scope

| # | Decision | Where |
|---|---|---|
| D22 | M1's Claude Desktop gate replaced by a real-client check with `claude -p` (Sonnet) against the live account, read-only; one Claude Desktop run before the v1 release | plan-m3.md |
| D23 | Evals run on cheaper models against the fake RC only. Gate: Claude Sonnet **and** Codex `gpt-6.1-sol` (owner: test Codex too, not just Claude); Haiku reported as a floor. Both clients verified end to end with a two-turn smoke run on 2054-10-22 | plan-m3.md |
| D24 | Live write tests approved by the owner (2054-10-22): "TEST MCP" guests (phone +79990000001, e-mail test-mcp@example.com), dates 20–23 Jan 2055 (main window), plus 31 Jan–2 Feb, 28 Feb–2 Mar and 5–7 Apr 2055 (S2/S9, done) | plan-m2.md |
| D25 | Known live leftovers: test guest records and soft-deleted test bookings (from the design phase and the baseline), three invisible drafts (810000209, 810000210, 810000211) | mcp-user-stories.md |

## Writes (M2 implementation)

| # | Decision | Why | Where |
|---|---|---|---|
| D26 | The preview's capacity check (`stayCheck`) ignores closed rooms; `check_availability` still counts them | RC saves bookings on closed nights (S2), so a closed room doesn't make a write fail; closures stay a `CLOSED_DATES` warning | spec §1 Writes, plan-m2.md |
| D27 | `create_booking` accepts `room` and `category` together when they agree (plan-m2 said exactly one) | spec §1's naming rule for all tools; a model often sends both | spec §2.5, plan-m2.md |
| D28 | Write tools have one output shape: `preview: true` with before/after/changes/warnings/token, or `preview: false` with `booking` (+ `deleted`, `note`) | MCP allows one `outputSchema` per tool | spec §1 Writes |
| D29 | An update that changes nothing, and a cancel of a canceled booking, are `VALIDATION` errors | nothing to confirm; also what a repeated confirm of an applied update sees | spec §2.6, §2.7 |
| D30 | M2 live run (2054-10-22): L1–L13 passed on the real account; window 19–24 Jan 2055 empty and without closures before and after. New leftovers, accepted as D21/D25: 5 test guest records, soft-deleted test bookings, one more invisible draft from L4 (its id wasn't printed: vitest hides console output of passing tests, so `test:live` now runs with `--silent=false`) | plan-m2.md "Live tests" |
| D31 | No keychain: `login` prints the token for `RC_TOKEN`, `logout` uses `RC_TOKEN` | owner: not needed | plan-m3.md §3 |
| D32 | Audit log goes to the log stream (stderr for stdio, since stdout is the MCP channel), not a file; `RC_AUDIT=summary\|full`, default `summary` without guest data | owner: the audit is useful, a file isn't needed now | plan-m3.md §4 |

## Write confirmation (reviewed with the owner, 2054-10-22)

How clients confirm writes, checked against the MCP spec, Claude's and OpenAI's connector docs and quick tests with
`claude -p` and `codex exec`:
- Claude (web, Desktop, mobile): "Every tool must include … destructiveHint: true for tools that modify or delete
  data. These determine auto-permissions in Claude. Read-only tools can run without per-call confirmation, and
  destructive tools always prompt." It also wants read and write operations in separate tools.
  Source: https://claude.com/docs/connectors/building/review-criteria.md
- ChatGPT "requires manual confirmation in any conversation before write actions can be taken"; the user can remember
  approval for the conversation. Any tool without `readOnlyHint` counts as a write.
  Source: https://developers.openai.com/api/docs/mcp/
- Codex `exec` refuses tools that aren't read-only ("MCP tool call requires approval, but approval policy is never")
  unless the server config has `default_tools_approval_mode` = `approve` (values: `auto`, `prompt`, `writes`,
  `approve`); evals pass `-c mcp_servers.realtycalendar.default_tools_approval_mode="approve"`.
- So the human approval of a write comes from the client's prompt. The confirm token doesn't provide it (the model
  holds the token and could use it at once); it binds the write to the previewed plan and catches changes since.

| # | Decision | Why | Where |
|---|---|---|---|
| D33 | Each write gets a read-only `preview_<write>` tool (same arguments, same access level, same guidance); the write tool requires `confirm_token` and never previews. No token → `VALIDATION` "call preview_… first"; mismatch or expired → `PREVIEW_STALE` with a fresh preview. 12 tools in v1 | a preview inside a destructive tool would make Claude prompt on the preview too; Claude wants reads and writes in separate tools | spec §1, §2.5–2.8; plan-m2.md; define.ts |
| D34 | All four write tools have `destructiveHint: true`, `create_booking` included | Claude's criteria ("modify or delete data"; then it always prompts); a create leaves an undeletable guest record and blocks a room. Deviates from the MCP spec's reading (create is additive) | spec §1 Annotations |
| D35 | No "да" in chat before a write: the client's approval prompt on the write tool is the confirmation. Server instructions: "Writes: always call the preview_ tool first, show the preview, then call the write tool with the confirm_token; the user approves in the app's confirmation prompt. Ask in chat instead … when the preview has will_fail, needs a choice …, or the user asked to check first. Never skip the preview, even if asked." Eval write cases are one turn; U6g (change of mind between preview and write) can't run headless and is a unit test | the facts above | spec §1, §3; plan-m3.md; cases.json |
| D36 | MCP elicitation not in v1; M4 candidate with the prototype findings | Claude web doesn't document support; the token + client prompt must work without it | plan-m3.md "Later" |
| D37 | Evals during implementation run on Codex only; Sonnet (and Haiku) for the full eval runs (owner) | cost and speed | plan-m3.md §1 |

Early check of D33–D35 (2054-10-22, Codex `gpt-6.1-sol`, fake RC, 2 runs each): U5a, U11 → `preview_create_booking`
then `create_booking` with identical arguments; U5d ("без подтверждения, сразу", no guest name) → asked for the
name, no write; U5a with room 22 occupied → preview `will_fail`, no write, offered other rooms. 8/8 as intended.
| D38 | The token's booking state is the last audit version only, not `updated_at` | live re-run 2054-10-22: L9's first step got `PREVIEW_STALE` with an identical fresh preview and no new audit entry in between, so `updated_at` moved on its own (after the L8 room move); a no-op PUT also moves it without an audit (S3). RC writes an audit entry for every real change, from the web app (fixture 810000176), booking-site syncs (`is_auto`, fixture 810000162) and payments, so outside changes still make the token stale. The write body is built from a fresh GET either way, so an outside change is never overwritten | spec §1 Writes, plan-m2.md, shared.ts |
