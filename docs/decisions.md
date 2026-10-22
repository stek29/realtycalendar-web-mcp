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
| D30 | M2 live run (2054-10-22): L1–L13 passed on the real account; window 19–24 Jan 2055 empty and without closures before and after. New leftovers, accepted as D21/D25: 5 test guest records, soft-deleted test bookings, one more invisible draft from L4 (its id wasn't printed: vitest hides console output of passing tests, so `test:live` now runs with `--silent=false`) | live result | plan-m2.md "Live tests" |
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
| D37 | Evals during implementation run on Codex only; Sonnet (and Haiku) for the full eval runs (owner). Early check of D33–D35 (2054-10-22, Codex `gpt-6.1-sol`, fake RC, 2 runs each): U5a, U11 → `preview_create_booking` then `create_booking` with identical arguments; U5d ("без подтверждения, сразу", no guest name) → asked for the name, no write; U5a with room 22 occupied → preview `will_fail`, no write, offered other rooms; 8/8 as intended | cost and speed | plan-m3.md §1 |
| D38 | The token's booking state is the last audit version only, not `updated_at` | live re-run 2054-10-22: L9's first step got `PREVIEW_STALE` with an identical fresh preview and no new audit entry in between, so `updated_at` moved on its own (after the L8 room move); a no-op PUT also moves it without an audit (S3). RC writes an audit entry for every real change, from the web app (fixture 810000176), booking-site syncs (`is_auto`, fixture 810000162) and payments, so outside changes still make the token stale. The write body is built from a fresh GET either way, so an outside change is never overwritten | spec §1 Writes, plan-m2.md, shared.ts |
| D39 | Live runs 2054-10-22 through the preview tools: one with L9 failing (D38), then L1–L13 passed after D38; window 19–24 Jan 2055 empty after each. Leftovers as D30: test guest records, soft-deleted test bookings, two more invisible drafts from L4 (810000212, 810000213) | live result | plan-m2.md "Live tests" |
| D40 | `RC_SITE_BOOKINGS=protect\|allow`, default `protect`: for a booking with `platform_name` (from a booking site), update can't change dates, category, status or price, and cancel and delete are refused (`SITE_BOOKING`, preview and write alike). A room within the same category, arrival/departure time and notes stay allowed: sites sell a category, so putting an Ostrovok booking into a room of its category (U10b) keeps working; a room in another category is refused (U10c). `allow` = the M2 behaviour (the `BOOKING_SITE` warning). Per deployment for stdio; hosted (M4) can set it per connection, e.g. from an OAuth scope chosen on the login page | owner, 2054-10-22: RC doesn't sync such changes back to the site, so the calendar and the site would disagree | spec §1 Settings, Errors; README; config.ts, shared.ts |
| D41 | Tool descriptions and instructions rewritten after two reviews (Codex `gpt-6-astra`, an Opus subagent; 2054-10-22). Write tools get a short "Step 2 of 2" text with no trigger words, so a model matching the user's words lands on the preview; previews say what to do next and that the app's prompt is the approval (no chat "да"); the no-token reason is per tool (DUPLICATE only on create); "снять бронь" is no longer a cancel trigger (U6e asks); U9's "booking from Ostrovok yesterday" path is named instead of "can't search by date made"; `bookable_count` described as it is computed (spare capacity on the fullest night); write outputs split into `PreviewOutput` and `ResultOutput`, and the booking shapes go under `$defs` once per tool (output schemas 69k → 33k characters); write results carry `today`; `RANGE_TOO_LONG` on a write says never to split a stay into several bookings, and `UNKNOWN_NAME` says not to substitute another name; a failed write to an existing booking says it may have been saved. The spec keeps each tool's intent; the exact text is the code, printed by `npm run tools`. Check on Sonnet 5.5 (`claude-sonnet-5-5`, fake RC; Codex was over its usage limit): U5a, U5d, U6b, U6c, U6e, U6f, U9, U10b, U10c, U11 pass after two fixes: "поставь бронь" dropped from create's words (Sonnet read "Поставь бронь с Островка … в 10-й" as a new booking), and U6b made two turns (the preview's PRICE_CHANGED asks which price, as intended). U10b uses room 11 (10 is taken in the scenario) | reviews; the spec's copies had drifted from the code | spec §1, §2; define.ts, shared.ts, tools/*, instructions.ts |
| D42 | Nothing is published: no npm package. Stdio (v1) runs with Node from a checkout, released as a git tag. The Docker image comes with M4 and holds the hosted HTTP server only, for Kubernetes and docker compose. Order unchanged: M3 (evals) first | owner, 2054-10-22 | plan-m3.md §5, architecture.md, technical-structure.md, README |
| D43 | Live run 2054-10-22 14:46 after D40/D41 (site guard, new descriptions, split outputs): L1–L13 passed (14/14), window 19–24 Jan 2055 empty afterwards; one more invisible draft from L4 (id not printed), accepted as D30 | live result | plan-m2.md "Live tests" |
| D44 | Eval check 2054-10-22 after D41–D43 (fake RC, 1 run each): read cases U1–U4, U9, U10a, U12, R1–R3 on Sonnet 5.5 17/18; U5a, U5d, U6b, U6c, U6e, U6f, U9, U10b, U10c, U11 on Codex `gpt-6.1-sol` 9/10. Both misses were the cases: R1 now takes any late-December arrival; U6e's Анна Петрова is a Yandex Travel booking, so under `protect` "do it on Yandex" is right too. The fake RC now sets `platform_name` for any booking-site source, as RC does (S1); before, only `is_external` bookings got it. Re-runs: R1, U6e (Sonnet) and U6c, U6e (Codex) 2/2 each | eval runs | cases.json, fake-rc.ts, spec §3 |
| D45 | `login` / `check` / `logout` verified live by the owner 2054-10-22 with `scripts/test-session.sh`: wrong password refused, new token works, logout ends it (401 after, second logout harmless), the MCP's own token in `rc.token` keeps working | owner's run, all 10 checks passed | plan-m3.md §3 |
| D46 | Owner, 2054-10-22: the first release is **v0.1.0**, not 1.0.0 (version and docs changed). Codex's `default_tools_approval_mode = "prompt"` is not checked: the end goal is the hosted server for Claude web and ChatGPT web, local Codex is not a target (README says untested). Private GitHub repo `stek29/realtycalendar-web-mcp` created and `main` pushed (history checked for the token, password and RC username: none); CI runs from it | owner | README, plan-m3.md §5 |
| D47 | `codex exec` drops MCP server `instructions` (Claude passes them; checked 2054-10-22), so without them Codex read "Кто живёт сегодня?" as a question about who is alive and asked "which hotel?" for R3. Fix: (1) the date rules and the hotel context also go into the `check_availability` and `list_bookings` descriptions (`DATES_HINT`), for clients that drop instructions (ChatGPT unknown); (2) the Codex eval runner passes the instructions as `developer_instructions`, like a client that honours them. A week is Monday to Sunday (owner), in the instructions and `DATES_HINT`; U4c accepts from Monday 19 Oct or today. Cases fixed where the models were right: U5b ("любую": only 02 is free, so it books 02), U5e (asking guests per room first is right: two turns), U12c (past tense "заработали" may mean November 2053; the answer names the year; no overlap note when there are no bookings). `list_bookings` says totals count whole stays and to say so | eval run 2054-10-22, transcripts | plan-m3.md §1, spec §3 |
| D48 | Owner, 2054-10-22: no Claude Desktop check. The real-client check is done in M4 on Claude web and ChatGPT web with the hosted HTTP server | owner | plan-m3.md §2 |
| D49 | opencode runner (`--runner opencode:<model>`, OpenCode free models; owner asked). Its first try ran in the repo instead of the temp folder (opencode takes `PWD` over the process cwd), so the permission file wasn't loaded and DeepSeek used the shell: read the repo, ran `check` and two read-only tools on the **live** RC with the token from `rc.token` (no writes; one guest name, the RC user and agency names, availability and prices went to the free-model provider; the token value did not). Leftover files, the report and opencode's sessions and snapshot deleted. Fix: every client run goes through `sandbox-exec` (no reading `rc.token` / `.rc-credentials`, no writes in the repo), `PWD` and `--dir` set to the temp folder | 2054-10-22 | plan-m3.md §1 |
| D50 | M3 done 2054-10-22. Sonnet 5.5 on the fake RC: 41/41 cases (40 in the full run after D47, U6b 3/3 after its case fix; 3 runs each, ~$4 per full run). Live read-only check: 18/18 on Sonnet. Owner: ship on Sonnet; Codex (ChatGPT limit), Haiku and opencode free models (DeepSeek timed out when throttled at 12 parallel runs) are reported later, not gating. RC checked after all agent runs: no booking in Sep 2054–Jun 2055 changed on 2054-10-22, test window 19–24 Jan 2055 empty, the escaped opencode run's commands (from its log) were all read-only. Tagged v0.1.0 | eval logs, read-only RC scan | plan-m3.md |

## Hosted server (M4)

| # | Decision | Why | Where |
|---|---|---|---|
| D51 | Hosted: the access level is picked per connection on the login page (capped by `RC_ACCESS`, default read) and carried in every token as an `access` claim, not as OAuth scopes; `RC_SITE_BOOKINGS` stays server-wide in v0.2 | clients request only the advertised scopes, so a page choice is a private claim anyway; one hotel, one owner | plan-m4.md, architecture.md |
| D52 | CIMD allowlist: Claude `https://claude.ai/oauth/mcp-oauth-client-metadata`, Claude Code `https://claude.ai/oauth/claude-code-client-metadata`, ChatGPT `https://chatgpt.com/oauth/client.json` (documents fetched 2054-10-22); only `none` advertised for the token endpoint | Claude's docs: CIMD needs `client_id_metadata_document_supported` and `none`; ChatGPT accepts `none` with CIMD | plan-m4.md, architecture.md |
| D53 | Server key: `MCP_SERVER_KEY` (base64url, ≥ 32 bytes) from a Kubernetes Secret or compose `env_file`; `MCP_SERVER_KEY_PREVIOUS` decrypts during rotation; JWE `kid` = SHA-256 prefix of the key. The confirm-token key is derived from it (HKDF) | stateless, any replica; refresh re-issues under the new key | plan-m4.md |
| D54 | The image is built by GitHub Actions (`.github/workflows/image.yml`) for linux/amd64 and linux/arm64 after `npm run check`, and pushed to the private GHCR package `ghcr.io/stek29/realtycalendar-web-mcp`: `main` → `:main`, `:sha-…`; tag `vX.Y.Z` → `:X.Y.Z`, `:X.Y`, `:latest`. Amends D42 ("nothing published"): still no npm package and no public image; pulling needs a GitHub token with `read:packages`. | owner asked for a deployable image on several arches; the build stage runs once on the runner (plain JS), only the runtime stage is per arch | image.yml, Dockerfile, deploy/, README |
| D55 | CIMD: when the client's document can't be fetched (network error, non-2xx such as a Cloudflare challenge from a datacenter IP), the last fetched copy, then a bundled copy of the three documents (2054-10-22) is used and a `cimd_fallback` warning logged; a fetched document that doesn't validate is still refused | a blocked fetch would otherwise stop every login | cimd.ts |
| D56 | Deployment is not from this repo: `deploy/` holds samples only. The compose sample has no TLS (the owner's reverse proxy terminates it) and is hardened: localhost-only port, non-root, read-only, no capabilities, no-new-privileges, init, pid/memory/CPU limits, log rotation. The server logs one `http` line per request (method, path without query, status, duration, client IP, user agent; `/healthz` not logged) and the IP on every `oauth_*` event. The client IP comes from `X-Forwarded-For` only through `MCP_TRUST_PROXY_HOPS` trusted proxies (default 0: the TCP peer); entries left of them are ignored. `/login` and `/token` bodies are capped at 16 KB, `/mcp` at 1 MB | owner, 2054-10-22 | deploy/, client-ip.ts, hosted.ts, README |
| D57 | Hosted calls to RC identify us: `User-Agent: realtycalendar-web-mcp/<version> (+<MCP_PUBLIC_URL>; via <client host>)`, `X-Forwarded-For: <client IP we saw>` (the user's browser for sign-in, Claude's or ChatGPT's servers for tool calls and refresh), `X-Request-Id: <our request id>`. Every log line of a request (`http`, `oauth_*`, `tool`, `rc_request`, audit) carries `request_id`, `ip`, `client` and `account`: a pseudonym of the RC login (10 letters of its SHA-256; logs never carry the login, often an e-mail), kept in the tokens as `sub`. Responses carry `X-Request-Id`. Ids are letters only, so the redactor's phone pattern can't eat them. Live check 2054-10-22: `GET /v2/info` with these headers works | owner: RC must be able to tell our traffic apart and trace abuse; our logs must tie a request to a user | client.ts, oauth/app.ts, hosted.ts, ids.ts |
| D58 | v0.2.0 released 2054-10-22 at the owner's request, before the real-client check (Claude web, ChatGPT web) and the over-triggering TODO; both stay open in plan-m4.md. The tag builds `ghcr.io/stek29/realtycalendar-web-mcp:0.2.0`, `:0.2` and `:latest`; the deploy samples pin `0.2.0` | owner: ship and use it for real | plan-m4.md, package.json, context.ts |
| D59 | Over-triggering, first pass: read tool descriptions say whose data they are ("the user's hotel in RealtyCalendar"), keep Russian only as glosses of RC terms (заявка, неразобранные, загрузка, заезды, выезды), drop the generic trigger phrases, and end with a "Not for" line (`SCOPE_HINT`: the user's own calendar, free time or meetings, staff schedules, other hotels, travel plans); the instructions say the same. Write tools unchanged: their Russian verbs separate cancel from delete. New cases N1–N6 (no tool may be called) and C1–C3 (U1a/U4a-style prompts with hotel context). The OpenCode account hit its free usage limit on 2054-10-22 (no turn finished), so the owner had them run on Sonnet: N1–N6, C1–C3, U1a, U4a 11/11 (`--repeat 1`, $0.39), with only our server loaded. The other 31 cases were not re-run after the description change. Decoy server not built | owner, 2054-10-22 | tools/*, shared.ts, instructions.ts, cases.json, plan-m3.md |
| D60 | Full Sonnet sweep after D59 (2054-10-22, `--repeat 1`, 50 cases, $1.61): 49/50. X1 failed on the answer regex only: "Инструмент не умеет фильтровать по дате создания… не получилось" states the limit, and the model then found the one booking made yesterday by its site booking date. The regex (shared by X1 and X2) widened (умеет, получилось); X1 re-run 3/3 | eval run | cases.json |
| D61 | v0.2.1 released 2054-10-22: the over-triggering pass (D59) after the Sonnet sweep (D60). Image `:0.2.1`, `:0.2`, `:latest`; samples pin `0.2.1`. Still open: the real-client check on Claude web and ChatGPT web, and the decoy-server evals | owner | plan-m4.md, package.json, context.ts |

