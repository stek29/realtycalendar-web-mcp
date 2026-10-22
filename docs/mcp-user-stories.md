# RealtyCalendar MCP: user stories → tools → API

Companion to [api-scope.md](api-scope.md) (what the API can do). This file is the MCP design: which questions it must
answer, which tools answer them, and which endpoints each tool calls. The exact v1 tool definitions (descriptions,
schemas, outputs, errors, Russian sample prompts) are in [mcp-tool-spec.md](mcp-tool-spec.md), which wins where the
two differ; deployment and auth in [architecture.md](architecture.md). Facts marked ✅ were checked against the live API
on 2054-10-22 with only the `X-User-Token` header. Writes were tested with test bookings on 20–27 Jan 2055, all deleted
afterwards (see "Write API" and "Unassigned bookings").

## Account model (as seen live)

- **Category** = RC "apartment" (9 here, e.g. "02. Двухместный улучшенный…"). **Room** = RC "realty room" (18 real rooms here, "21", "22"…; plus one "Неразобранные" pseudo-room per category with rooms).
- A booking is bound to a category and optionally to a room. **Unassigned** = `realty_room_id: null`; the calendar
  shows these in each category's "Неразобранные" row (in `apartments[].rooms` it's a pseudo-room with `id: 0`).
  Bookings from booking sites often arrive unassigned (15 of 58 in the next 6 months, incl. Ostrovok, Yandex Travel).
- Rooms per category ✅: 01, 05, 06, 07 → 2; 02, 03 → 5; **04, 08, 09 → none** (each acts as a single unit).
  See "Unassigned bookings and room binding" below for the rules.
- **Booking** = RC "event_calendar". Statuses ✅: `booked`, `request`, `canceled`, `deleted`.
- **Source / channel** ✅: `source_id` on a booking → name in `GET info` → `agency.sources_list` (62 entries: Ostrovok,
  101Hotels.com, …). Not the same ids as `GET platforms`.

## User stories

| # | Story |
|---|---|
| U1 | What rooms do we have (free) for date X / dates X–Y? |
| U2 | Is room X available on date Y? |
| U3 | What rooms are busy on date X (and with whom)? |
| U4 | Who is arriving on date X, in which rooms, from which platforms/channels? |
| U5 | Add a manual booking for dates X–Y in room Z |
| U6 | Move the booking in room Z from Fri–Sun to Sat–Mon |
| U7 | What new (unread) bookings do we have? |
| U8 | Which bookings were created today / yesterday / … (booking date, not arrival date)? |
| U9 | What is that booking from Ostrovok from yesterday? |
| U10 | Which bookings aren't in a room yet? Put the Ostrovok one into room 22. |
| U11 | Add a booking for date X in room Z: Ivan booked, 5k per night, he pre-paid 5k already to X bank. (v1: without recording the prepayment) |
| U12 | Is booking N paid in full? How much is paid and how much is left? Who still owes money? |
| U13 | Ivan paid the rest (to X bank) / that payment was a mistake. (later, not v1) |

## Thin or combined?

**Thin where one endpoint already answers the question, combined where a story needs a join.** The plumbing is the
same in both cases: names → ids, ISO dates, compact output instead of raw RC JSON.

Combined logic is needed because the raw API is awkward for these stories:

- The calendar grid ✅ only returns **busy** nights. "Free" = rooms from `apartments` − overlapping bookings − closed
  dates (`special_prices[].closed`). Only the server can answer "is 22 free" in one step.
- The grid returns ids only (`apartment_id`, `room_id`, `source_id`). Names come from `apartments` and `info`.
  Per booking it also has ✅ `status`, `begin_date`, `end_date`, `client: {fio, phone}` (phone often null),
  `arrival_time`, `departure_time`, `amount`, `price`, `prepayment`, `prepayment_progress`, `debt`, `is_external`,
  `is_delete`, `updated_at`, and per row `special_prices[]`. Bookings that start before `begin_date` but overlap the
  range are included ✅ (a 9–16 Jan booking came back for a 15–28 Jan query).
- Grid date range is limited (6 months OK, 15 months → `400 {"error":"date range"}`) ✅; arrivals list must be < 1 month ✅.
  Tools pass these limits through as errors instead of splitting requests.
- Grid payload is heavy (6 months, 9 categories ≈ 230 KB, includes per-day prices) ✅. Must be trimmed before it reaches the model.

So the combined ones are `check_availability` and the create/update tools (two-step create, read-merge-write update);
the rest are thin. Where
the API has no support for a story, we don't work around it (see "Not supported").

## Tool set (v1: 8 tools)

Defined in [mcp-tool-spec.md](mcp-tool-spec.md) (inputs, outputs, confirm tokens, warnings, access levels, sample
prompts). Summary:

| Tool | Level | Stories | Main API calls |
|---|---|---|---|
| `list_rooms` | read | catalog, name → id | `GET apartments` ✅ |
| `check_availability` | read | U1, U2, U3, price quotes | grid `GET event_calendars/` ✅ + `apartments/{id}/price` ✅ |
| `list_bookings` (`staying` / `arriving` / `departing`) | read | U3, U4, U6 lookup, U9, U10, U12 | grid ✅ + `info.agency.sources_list` ✅ |
| `get_booking` | read | U9, U12 | `GET event_calendars/{id}` ✅ + `…/payments` ✅ |
| `create_booking` | book | U5, U11 | `POST event_calendars` (draft) → `PUT event_calendars/{id}` ✅ |
| `update_booking` | edit | U6, U10 assign/unassign, confirm a hold | `GET` → merge → full `PUT event_calendars/{id}` ✅ |
| `cancel_booking` | edit | guest cancelled | same as update with `status: canceled` ✅ |
| `delete_booking` | full | entered by mistake | `DELETE event_calendars/{id}` ✅ |

Writes use a preview → `confirm_token` flow (spec §1). Story-by-story expected calls with Russian prompts: spec §3.

### Later (API works, left out of v1)

- **Recording payments (U13, and the prepayment part of U11).** Tested and working (see "Money"), but left out of v1
  because payments can't be deleted: a wrong call leaves a payment plus a refund in the accounting for good. When
  added, it's two thin tools plus one option:
  - `add_payment(id, amount, note?, account="Наличные")` → `POST event_calendars/{id}/payments`
    `{type:"manual", amount, note, invoice_id}` (bank transfers go on Наличные with the bank in the note);
  - `refund_payment(id, payment_id, amount, note?)` → `POST event_calendars/{id}/payments/{pid}/refund`
    `{refund_type:"manual", amount, note}` (the only way to undo a payment);
  - `create_booking(…, prepaid={amount, note})` → the same payment call right after the booking is saved;
  - `delete_booking` should then warn about existing payments and offer refunds first.

### Not supported (no API for it)

- **U8 "bookings created on day X".** No list endpoint filters or returns a creation date ✅. Creation time is only
  visible per booking (`get_booking`). Out of v1.
- **U7 "new / unread bookings".** Bookings have no read/unread state ✅. The bell list (`GET messages`, read flag,
  `PUT messages/{id}/read`) is a generic notification feed; it was empty for this account, so we don't know yet whether
  new bookings show up there. If they do, add a thin `list_notifications(unread_only)` tool. Check after the next real booking.

### Write API (tested 2054-10-22)

Tested on 20–27 Jan 2055 with two test bookings ("TEST MCP — удалить") in rooms 5, 6, 21, 22. The create was done
through the web UI with the app's calls recorded, the rest via the API. Both test bookings were deleted afterwards;
the calendar is back to its earlier state.

**Create = two calls.** Opening the "new booking" form already sends the `POST`; "Save" sends the `PUT`.

1. `POST /v2/event_calendars` → 200, returns the new id
   ```json
   {"event_calendar":{"status":"booked","apartment_id":810000052,"realty_room_id":810000029,"begin_date":"2055-01-20","end_date":"2055-01-23"}}
   ```
   This is only a draft: `GET` on it returns 404, it is not on the calendar, there is **no availability check** at this
   step, and a draft that never gets its `PUT` never shows up anywhere we can see (whether RC deletes it later or it
   affects booking sites is unknown).
2. `PUT /v2/event_calendars/{id}` → 200 with the full body (exactly what the form sent):
   ```json
   {
     "event_calendar": {
       "apartment_id": 810000052, "status": "booked", "realty_room_id": 810000029,
       "begin_date": "2055-01-20", "end_date": "2055-01-23",
       "arrival_time": null, "departure_time": null,
       "amount": 33000, "platform_tax": null, "notes": "…",
       "color": null, "reaction": null, "source_id": null,
       "guest":  {"id": null, "fio": "…", "email": null, "phone": null, "additional_phone": null,
                  "attachments": [], "destroy_attachments_ids": []},
       "client": {"id": null, "fio": "…", "email": null, "phone": null, "additional_phone": null},
       "attachments": [],
       "additional_services": {"early_checkin": null, "late_checkout": null}
     },
     "prepaid_amount": null, "send_confirm_email": false, "send_link_prepaid": false,
     "lead_id": null, "destroy_attachments_ids": []
   }
   ```
   After this the booking is readable, on the calendar, and a guest record is created. `amount` is not filled in by
   the server; the form puts in the `apartments/{id}/price` quote.

**Updates must send the whole body.** The server checks a strict JSON schema; a partial body gets
`422 {"errors":["The property '#/event_calendar' did not contain a required property of 'status' …", …]}` listing every
missing field. So `update_booking` = `GET` → build the body above from it → change fields → `PUT`. Rejected requests
change nothing.

| Test | Result |
|---|---|
| Move dates 20–23 → 21–24, same room | 200 |
| Move to room 6 (same category) | 200 |
| Move to room 21 (other category: change `apartment_id` + `realty_room_id`) | 200, but **amount not re-priced** |
| Save a booking over another `booked` one (create or move) | 422 `{"errors":{"end_date":["На данные числа объект занят"]}}`, nothing changed |
| Back-to-back (check-in on the other's check-out day) | 200 |
| `booked` over a `request` (hold), and a `request` over a `booked` | 200: holds don't block anything |
| `booked` over a `canceled` one; then un-cancel the old one | 200; un-cancel → 422 occupied (canceled frees the room) |
| End date before start date | 422 `{"errors":{"begin_date":["Дата заезда не может быть больше даты выезда"]}}` |
| Room id with the wrong category id | Category changed + room not in the new category: **200, room silently dropped** (booking becomes unassigned). Category unchanged + room from another category: 422 `{"errors":{"realty_room_id":["Комната не найдена"]}}` |
| `DELETE /v2/event_calendars/{id}` | 200; booking stays readable with `is_delete: true`, gone from the calendar (even with `statuses[]=deleted`) |
| `POST /v2/event_calendars/{id}/restore` | 200; `is_delete: false` again |

**What this means for the tools**

- `create_booking`: `POST` then `PUT`. If the `PUT` fails (e.g. occupied), report the error; the draft stays invisible (never re-POST).
- `update_booking`: always read-merge-write; always take `apartment_id` from the room (never from the caller); when
  the room's category changes, say the amount was kept and offer a new quote.
- The server already refuses booked-vs-booked overlaps, so the tools don't need their own check for that. They should
  warn when the stay overlaps a hold (`request`), since the server allows it.
- Guest messages: send `send_confirm_email: false`, `send_link_prepaid: false` unless the user asks; nothing was sent
  to anyone during the tests.

### Unassigned bookings and room binding (tested 2054-10-22)

Same dates (20–23 Jan 2055), 5 test bookings in category 01 (rooms 5, 6) and 04 (no rooms), all deleted afterwards.
There's no separate "assign" endpoint and no drag-and-drop move in the web app: binding is just the
`realty_room_id` field in the normal create/update body.

**Capacity rule.** Per category and per night: assigned `booked` + unassigned `booked` ≤ number of rooms (1 for a
category without rooms). Each room also takes one `booked` at a time. Holds (`request`) and `canceled` don't count.

| Test (category 01 = 2 rooms) | Result |
|---|---|
| Create unassigned (`realty_room_id: null`) | 200 |
| Second unassigned, same dates | 200 |
| Third unassigned, same dates | 422 occupied |
| Booking in the **empty** room 5 while 2 unassigned fill the category | **422 occupied** |
| Assign unassigned U1 → room 5 | 200 |
| Assign U2 → room 5 (U1 there) | 422 occupied, U2 stays unassigned |
| Assign U2 → room 6 | 200 |
| Unassign U1 (`realty_room_id: null`) | 200 |
| 1 unassigned + 1 in room 6, then a booking in empty room 5 | 422 occupied (category full) |
| Same room 5, starting on the check-out day | 200 |
| Unassigned overlapping one full night | 422 occupied |
| Unassigned `request` while the category is full | 200 (holds don't count) |
| Move unassigned to another category (both ids changed, room `null`) | 200 |
| **Category 04 (no rooms)**: first booking / overlapping second | 200 / 422 occupied: a single unit |

**Booking-site bookings.** For bookings with a `platform_name`, the web app warns when dates, status, room, amount
or category change: *"изменения по данному бронированию не передадутся в {platform}"* (changes are not sent to the
site). Assigning a room is internal and fine; changing dates or cancelling in RC does not change the booking on the site.
`update_booking` should repeat that warning for those fields. Not tested on a real booking-site booking (would change
real data).

**What this means for the tools**

- `check_availability` must count unassigned bookings: a room can look empty and still not be bookable because the
  category is full. Report per room *and* per category ("2 rooms, 1 free tonight, 1 unassigned booking").
- `create_booking(category=…)` without a room is allowed (unassigned booking in a category).
- Categories without rooms: their bookings always have `realty_room_id: null` but are **not** "unassigned"; the
  category itself is the single unit.
- Assigning = `update_booking(room=…)`, unassigning = `update_booking(unassign=true)`; RC rejects a taken room.
- Categories without rooms (04, 08, 09) are addressed by category name only.

### Money: prices, prepayments, paid / left (tested 2054-10-22)

v1 uses the price override and the read-only paid / left fields; the payment-writing calls below are for "Later".

One test booking (room 5, 20–23 Jan 2055, "TEST MCP Иван", dummy phone/email, no messages sent). The first payment was
made through the web UI with the app's call recorded, the rest via the API. All payments were refunded (net 0 on
Наличные) and the booking deleted.

**Price.** `event_calendar.amount` is the booking total. Any value is accepted and kept as given (30 000 for 3 nights
at 10 000 instead of the 33 000 quote) ✅. The form shows "Цена за сутки" = amount / nights. `guests_count` doesn't change
the quote for this account ✅.

**Accounts ("Счет").** Every payment goes to one of the agency's accounts, `GET info` → `agency.rent_payment_invoices`:
Наличные (810000042), Ostrovok, Яндекс Путешествия, Суточно, Броневик, T-Путешествия. There is no bank account; **bank
transfers are recorded on Наличные with the bank in the note** (agreed). Booking-site prepayments arrive on their own
accounts automatically (status "Оплачено на сайте бронирования").

**Calls** (all ✅):

| Action | Call | Notes |
|---|---|---|
| List payments | `GET event_calendars/{id}/payments` → `{data:[{id, created_at, note, status.text, payment:{type: income\|refund, amount}, invoice:{id,title}, can_delete, can_edit}]}` | Refunds show as separate `refund` records with negative amounts |
| Record a payment | `POST event_calendars/{id}/payments` `{"note":"Т-Банк","amount":"10000","type":"manual","invoice_id":810000042}` | Exactly what the web app sends ("Записать получение оплаты вручную"). Saved immediately, independent of the booking form |
| Edit a payment's note | `PATCH event_calendars/{id}/payments/{pid}` `{note, invoice_id}` | `invoice_id` required; `amount` is ignored |
| Delete a payment | `DELETE event_calendars/{id}/payments/{pid}` | **422 "Платеж не может быть удален"** (`can_delete: false`) |
| Undo / refund | `POST event_calendars/{id}/payments/{pid}/refund` `{"refund_type":"manual","amount":1000,"note":"…"}` | Adds a refund record; paid total goes down |

Other payment types (`get_link`, `send_email`) need a payment system (Moneta); none is connected, so out of scope.

**Paid / left.**

| Field | Where | Meaning |
|---|---|---|
| `amount` | grid, `by_dates`, detail | booking total |
| `prepayment` | grid, `by_dates` | **paid so far** (incomes − refunds): 10 000 → 30 000 → 16 000 → 30 000 after a 1 000 refund ✅ |
| `prepayment_progress` | grid | % paid (33.33 → 100) ✅ |
| `debt` | `by_dates` | total − paid (20 000 after the first 10 000) ✅ |
| `debt` | grid | **not** the remaining amount: stayed 0 for a future stay at 10 000 / 30 000; non-zero on a stay already in progress. Don't use it |
| `prepaid_amount` | detail | 100 on every booking; not the paid amount. Don't use it |

So the tools compute **left = amount − prepayment** (negative = overpaid), **paid in full = prepayment ≥ amount**.
In v1 these are read-only output fields of `list_bookings` and `get_booking`.

**Deleting a booking with payments** leaves its payments in the history (they can't be deleted). In v1,
`delete_booking` just mentions it when the booking has payments (e.g. a booking-site prepayment).

## Read-only checks (2054-10-22)

| Check | Result |
|---|---|
| `by_dates` `kind` | `all`, `arrival`, `departure` ✅. Others → 422 "Недопустимый тип фильтра" |
| `by_apartments` `kind` | also `living` (staying) and `vacant` (free) ✅, but they return categories, not rooms or free counts. `check_availability` stays on the grid |
| Arrivals paging | `limit=5` → `X-Has-More: true` + `X-Next-Cursor`; `cursor=` gives the next 5, no overlap ✅ |
| `by_dates` `query` | matches guest name / phone / address, not source ("Ostrovok" → 0) |
| `apartments` paging | no pagination info in the response; 9 categories, 0 archived. Fine at this size |
| Closed dates | `special_prices[]` rows with `closed: true`, `is_restriction: true`, `begin_date`..`end_date`, **per room** (e.g. all rooms 1–22 Apr 2055). Also `min_stay_through` rules on 135 rows. Whether the server refuses a booking on closed dates is **not tested** (would need a write in April) |
| Sign-in | `POST /v2/sign_in` `{username: email or phone digits, password}` → `{auth_token, success}`; no 2FA/captcha in that flow; tested with the dedicated user (see Auth) |

## How the tool set got here

The first proposal had 14 tools (overviews, stats, guest cards, comments, payments, restore…). It was cut to the stories
the user asked for, then reshaped by tests and reviews: payment writes moved to "Later"; cancel got its own tool;
`get_price` folded into `check_availability`; arrivals/departures folded into `list_bookings` (`match`). Final v1:
8 tools in four access levels (spec §1). Reads that were dropped (`by_deposits`, `find_by_phone`, `guests/search`) are
tested ✅ and can come back cheaply if a story needs them.

## Auth (tested 2054-10-22 with the dedicated user)

- `POST /v2/sign_in {username, password}` → `{auth_token, success}` ✅. Every sign-in creates a **new** 20-character
  opaque token; earlier tokens keep working ✅. `DELETE /v2/sign_in` with one token ends only that session ✅.
- RC decides how long a token lives; the design signs in again when one dies.
- v1 and hosted designs: [architecture.md](architecture.md).

## Open questions

1. **Notifications (U7).** Do new bookings appear in the bell list? Check after the next real booking.
2. ~~Closed dates~~ — answered 2054-10-22: the API accepts bookings on closed nights and below min stay (spec §5 S2).
3. **Leftovers from tests.** Test guest records ("TEST MCP …", phone +79990000001) stay in the guest base; the
   deleted test booking keeps its (refunded) payment history. Every create with `guest.id: null` makes a **new** guest
   record, even with the same name and phone (5 creates → 5 guest records, 2054-10-22).

### Write baseline (tested 2054-10-22)

Five test bookings in category 01 ("TEST MCP Иван"), all deleted within a minute; the windows were checked empty
before and after.

| Test | Result |
|---|---|
| Create 20–23 Jan, room 5 | `POST` 200 returns a draft in the detail shape (`amount: 0`, `guest: null`, `preparing: true`); `PUT` 200 returns the full booking, same keys as `GET` |
| No-op `PUT` built from the `GET` (spec §2.6 mapping) | 200; no field changed, same guest and client ids, no new audit entry; `updated_at` moved (S3 ✅) |
| 1 night 20–21 Jan where min stay is 2 | saved (S2: min stay not enforced) |
| 31 Jan–2 Feb (min 2, then 4) and 28 Feb–2 Mar (min 4, then 2) | both saved (S9 can't be learned from the API) |
| 5–7 Apr, all rooms closed | saved (S2: closures not enforced) |
| Cancel (status `canceled`) then `DELETE` | 200 / 200; `DELETE` returns the booking with `is_delete: true` |
| Guest records | each create made a new guest record (no reuse by phone) |
| `DELETE` on a draft (never saved, or after a refused `PUT`) | 404 `{"error":"not found"}`: drafts can't be removed |
| `PUT` to a draft after that `DELETE` | 200: the draft became a real booking. Drafts stay saveable |
| Full booking saved over an open draft, same room and dates | 200: drafts don't block the room |
| Leftovers | three invisible test drafts (810000209, 810000210, 810000211) |