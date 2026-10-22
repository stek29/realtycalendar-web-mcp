# M2 plan: write tools

Status: plan, 2054-10-22. Behaviour is defined in [mcp-tool-spec.md](mcp-tool-spec.md) §1 (writes, warnings, access
levels) and §2.5–2.8; runtime rules in [architecture.md](architecture.md) "Write path"; the live evidence in
[mcp-user-stories.md](mcp-user-stories.md) "Write baseline". This file says how M2 is built and tested. Agreed
decisions: [decisions.md](decisions.md).

## Scope

In:
- `create_booking` (level `book`), `update_booking` and `cancel_booking` (`edit`), `delete_booking` (`full`).
- Preview → confirm token for every write; warnings and `will_fail` from the same capacity logic as
  `check_availability`.
- GET → PUT body builder (spec §2.6 mapping), fail-closed on unknown GET fields.
- Server instructions per access level (already written for all four levels in M1).
- Fake RC with write behaviour; unit tests; live tests on the agreed window.

Out (unchanged from the spec): payments, guest contact edits, restore, prepayment on create. The audit log is M3
(build order); M2 writes are not released before M3.

Already settled by the live baseline (no further live checks needed): S2 (RC doesn't enforce min stay or closures),
S3 (no-op PUT is safe), S8 (drafts: invisible, don't block, can't be deleted), S9 (not learnable; strictest night).

## Modules

| File | Contents |
|---|---|
| `upstream/schemas.ts` | `BookingSchema` gains a raw variant that keeps unknown keys (`z.looseObject`) for the builder's key check. PUT and DELETE responses use the same schema (they return the booking in the GET shape ✅). Draft POST response: `{ id }` plus the draft fields (only `id` is used). |
| `upstream/api.ts` | `createDraft(rc, {status, apartment_id, realty_room_id, begin_date, end_date})`, `putBooking(rc, id, body)`, `deleteBooking(rc, id)` — all `rc.send`, never retried |
| `domain/writes.ts` | `KNOWN_BOOKING_KEYS` (the 36 keys of a live GET, 2054-10-22); `putBodyFromGet(raw)` (spec §2.6 mapping; unknown key → `RC_SCHEMA_DRIFT`); `createBody(plan)`; `applyChanges(body, plan)`; price rules (given / keep average per night × new nights / keep total on category change); notes append (`old + "\n" + new`) or replace |
| `domain/confirm.ts` | `signPlan(key, plan, now)` / `verifyPlan(key, token, plan, now)` — see "Confirm token" |
| `domain/calendar.ts` | `availability()` gains `excludeBookingId` so an update's own nights don't count against it |
| `domain/warnings.ts`¹ | builds the preview warnings (`HOLD_OVERLAP`, `CLOSED_DATES`, `BOOKING_SITE`, `CATEGORY_CHANGE`, `PRICE_CHANGED`, `PRICE_KEPT`, `HAS_PAYMENTS`, `PAST_DATES`, `NO_GUEST_MESSAGES`, `DUPLICATE`) and `will_fail` / `conflicts` from an availability result |
| `mcp/tools/define.ts` | `defineWriteTool({…, preview, commit})`: adds `confirm_token` to the input; without it runs `preview`; with it re-runs `preview` (fresh state), verifies the token against the new plan, and only then `commit` |
| `mcp/tools/create-booking.ts`, `update-booking.ts`, `cancel-booking.ts`, `delete-booking.ts` | one per tool |
| `context.ts` | `withBookingLock(id, fn)`: writes to the same booking id serialised in-process |

¹ New file, listed in technical-structure.md when added (`domain/` currently names `writes.ts` and `confirm.ts`;
warnings may live in `writes.ts` if small).

### Plan → preview → confirm

Each write tool turns its arguments into a **plan**: the resolved target (ids, not names) and the exact field values
that will be written, plus, for existing bookings, the booking state it was computed from (`updated_at` and the last
audit version). Preview and commit both build the plan from fresh RC data, so what is confirmed is exactly what was
shown.

- **Preview** (no `confirm_token`): plan + capacity check + warnings → `{ preview: true, summary, before, after,
  changes, warnings, will_fail, conflicts, confirm_token }`. `summary` is one Russian line ("Бронь: 22, 7–9 ноября,
  Анна Петрова, 17 200 ₽").
- **No token when the write can't or shouldn't happen**: `DUPLICATE` (spec) and `will_fail: true` (room or category
  certainly full) return the preview without `confirm_token`, so the model offers alternatives instead of asking for
  a "да" that can only fail. *(Spec §1 change, applied with the code.)*
- **Confirm** (with token): rebuild the plan from fresh data; token mismatch or expired → `PREVIEW_STALE` with the
  fresh preview included; else commit.

### Confirm token

- `token = base64url(exp) + "." + base64url(HMAC-SHA256(key, exp + "\n" + canonical_json(plan)))`, `exp` = now + 15
  min (seconds). `crypto.subtle` only (portable). Key: `RC_CONFIRM_KEY` or random per process (spec Settings); a
  random key means tokens don't survive a server restart, which only costs a fresh preview.
- `plan` contains the tool name, the target booking id (if any), the resolved field values to be written (not the raw
  arguments: "22" and "22-й" give the same plan), and the booking state. A changed quote, a changed booking or
  changed arguments all change the plan → `PREVIEW_STALE`.
- Stateless, not single-use (spec). Repeated confirms are made safe by the duplicate check (create) and by the
  booking state in the plan (update/cancel/delete: after the first commit the state differs → `PREVIEW_STALE`).

### Per tool

| Tool | Plan from | Commit |
|---|---|---|
| `create_booking` | catalog (room → its category; category → `AMBIGUOUS` if several), dates, guest, status, amount (given total / per night × nights / RC quote), times, source (`AMBIGUOUS` if several), notes | duplicate check → `POST` draft → `PUT` create body → result from the PUT response. 4xx → mapped error, "nothing was saved"; timeout/5xx → `RC_ERROR` "Not sure it was saved. Call again with the same confirm_token…" (spec §2.5) |
| `update_booking` | `GET` booking (`DELETED` if `is_delete`, `NOT_FOUND` on 404) + payments; requested changes (at least one; `room`/`category`/`unassign` exclusive; `notes_append`/`notes_replace` exclusive; price rules) | under the booking lock: re-`GET` → plan → token check → `PUT` body from that GET with the changes |
| `cancel_booking` | as update with `status: canceled` | same |
| `delete_booking` | `GET` booking + payments | lock → re-`GET` → token check → `DELETE` |

Results: the booking as `BookingSummary` (+ `deleted` for delete), built from the PUT/DELETE response; `paid` from the
payments list read at confirm time (create: 0, no call).

### Input validation (all `VALIDATION` with a message saying what to send)

- create: exactly one of `room` / `category`; `guest_name` non-empty; at most one of `price_per_night` / `total`,
  both ≥ 0; `arrival_time` / `departure_time` as `HH:MM`; `check_out > check_in`, at most 62 nights.
- update: at least one change; exclusivity rules above; `clear_arrival_time` with `arrival_time` → `VALIDATION`.
- Guest contact fields are not inputs of update (spec).

## Fake RC (test/fake-rc.ts)

Extended to hold state per instance:
- `POST event_calendars` → draft (invisible: GET 404, not in the grid); `DELETE` on a draft → 404.
- `PUT` → strict body check (every key of the create body present, else 422 with an array of strings, as RC);
  occupancy check as RC: per room one `booked`; per category assigned + unassigned `booked` ≤ rooms (1 for
  single-unit); holds and canceled don't count; 422 `{"errors":{"end_date":["На данные числа объект занят"]}}`.
  Category unchanged + room from another category → 422 "Комната не найдена"; category changed + foreign room → room
  silently dropped (as RC). Min stay and closures not enforced (as RC). Response = booking in the GET shape.
- `DELETE` → `is_delete: true`, gone from the grid, GET still 200.
- Failure injection: `fakeRc({ failNext: { method: 'PUT', with: 'timeout' | 500 } })` for the timeout path.

## Unit tests (test/unit/)

- `writes.test.ts`: no-op round trip of every booking fixture (`putBodyFromGet` → the fields the GET has, ids kept);
  unknown GET key → `RC_SCHEMA_DRIFT`; price rules (3 cases); notes append/replace; status/room/category changes;
  `apartment_id` always from the target room.
- `confirm.test.ts`: round trip; expiry; any plan change (args, quote, `updated_at`) → mismatch; key change → mismatch.
- `write-tools.test.ts` (fake RC, through `runTool`), the spec §3 write stories:
  - U5a create in a room: preview (no change in the fake) → confirm → booking exists; result fields.
  - U5b category without room → unassigned; `AMBIGUOUS` when the category words match two categories.
  - U5c hold in a single-unit category.
  - U5d no confirm without a preview (a made-up token → `PREVIEW_STALE`).
  - U5e two previews then two confirms.
  - U6a move dates; `will_fail` and no token when occupied.
  - U6b extend: `PRICE_CHANGED` with old/new totals and the quote.
  - U6c/U6d cancel vs delete; `HAS_PAYMENTS`, `BOOKING_SITE` warnings on the Ostrovok fixture.
  - U6f notes append keeps the old note.
  - U6g changed arguments after a preview → `PREVIEW_STALE` with a fresh preview.
  - U10b assign a room in another category → `CATEGORY_CHANGE`, `PRICE_KEPT`.
  - U11 price per night → total 30 000; `NO_GUEST_MESSAGES`.
  - X5/X7 tools above the access level: not registered, `ACCESS_DENIED` if called.
  - create timeout → `RC_ERROR` with the repeat hint; repeat confirm → duplicate check returns the saved booking
    (fake saved it) or creates it (fake didn't).
  - booking changed between preview and confirm → `PREVIEW_STALE`; deleted → `DELETED`.
  - logs: no guest data or token on any write path (seeded PII string).
- `npm run check` stays the gate: typecheck, lint, unit tests.

## Live tests (test/live/, opt-in)

Run: `RC_LIVE=1 RC_TOKEN=… npx vitest run test/live`. Never in CI; `npm test` excludes `test/live`.

Approved scope (decisions.md D24): guests named "TEST MCP …", phone +79990000001, e-mail test-mcp@example.com, dates
**20–23 Jan 2055** only (the other approved windows were for the S2/S9 baseline, already done). Any category; the
whole hotel was empty 19–24 Jan 2055 with no closures on 2054-10-22.

Safety, enforced in code, not by convention:
1. **Write firewall**: the live tests' `fetch` wrapper rejects any POST/PUT/DELETE that is not (a) a POST whose dates
   lie in 2055-01-20…2055-01-23, or (b) a PUT/DELETE to a booking id created by this run; and any PUT whose guest/
   client name doesn't start with "TEST MCP". A rejection fails the test before anything reaches RC.
2. **Pre-check**: grid for all categories, 19–24 Jan 2055, all statuses: abort unless empty (or only "TEST MCP"
   bookings, which are cleaned up first).
3. **Cleanup** in `afterAll`: `DELETE` every id created by the run (drafts answer 404, expected); then assert the grid
   for 19–24 Jan is empty again. Failures are reported with the ids.

Scenarios, all through the MCP tools (preview → confirm), in order:

| # | Scenario | Checks |
|---|---|---|
| L1 | create "TEST MCP Иван" in room 5, 20–23 Jan, no price | preview shows the quote; result id; `get_booking` matches; `list_bookings(query="TEST MCP")` finds it |
| L2 | same create again | `DUPLICATE`, no token, nothing created |
| L3 | create in room 5 overlapping L1 | preview `will_fail`, no token |
| L4 | preview a create in room 6, then occupy room 6 with another create, then confirm the first | RC 422 → `OCCUPIED`, "nothing was saved" (leaves one invisible draft — known, D19) |
| L5 | hold (request) in category 01 without a room | unassigned hold; `check_availability` lists it, capacity unchanged |
| L6 | update L1: dates 20–23 → 21–23 | `PRICE_CHANGED`; amount = average × 2 |
| L7 | assign the hold to room 6, then confirm it (request → booked) | room set; status booked |
| L8 | move L1 to room 21 (category 02) | `CATEGORY_CHANGE`, `PRICE_KEPT`; `apartment_id` = 02 |
| L9 | unassign L1; notes_append; clear arrival time | each a separate preview/confirm; untouched fields unchanged (S3 regression) |
| L10 | preview an update, change the booking with another update, confirm the first token | `PREVIEW_STALE` + fresh preview |
| L11 | single-unit: create in category 04, then an overlapping one | second preview `will_fail` |
| L12 | cancel L1 | status canceled; `check_availability` shows the room bookable |
| L13 | delete the hold; then update it | delete ok; update → `DELETED` |

Expected leftovers (accepted, D21/D25): one guest record per successful create (~6), soft-deleted test bookings,
one invisible draft from L4.

## Docs to update with the code

- spec §1: preview without `confirm_token` when `will_fail` (with `DUPLICATE` already so); the `summary` format.
- spec §2.5–2.8: input validation rules above; result shape (`BookingSummary`, `deleted` for delete).
- technical-structure.md: new files; `npm run test:live`.
- decisions.md: entries for anything that changes on the way.

## Done when

- `npm run check` green with the write unit tests.
- Live L1–L13 pass and the calendar for 19–24 Jan 2055 is empty afterwards.
- Read tools unaffected (M1 tests still green).
