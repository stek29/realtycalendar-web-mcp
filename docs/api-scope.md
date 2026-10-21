# RealtyCalendar "Шахматка" (chessmate): API scope

Raw reference of the web app's API (what exists). Decisions and test results live elsewhere:
[mcp-user-stories.md](mcp-user-stories.md) (stories, tested behaviour), [mcp-tool-spec.md](mcp-tool-spec.md) (v1 tools),
[architecture.md](architecture.md).

Source: the SPA at https://realtycalendar.ru/chessmate/ (Vue 3 + Vuex, Vite bundle). Endpoints come from
live network traffic plus static extraction of `src-*.js` and `common-*.js` (`scripts/extract_endpoints.py`,
raw output per app in `docs/endpoints/endpoints_<app>.txt`). Bundle version inspected: `src-CvEGM1Ee.js`, `common-CFzk5Z8c.js` (2054-10-21).
The other left-nav sections are separate Vue apps on the same `/v2` API; see "Other sections" below.

## Transport and auth

- Base URL: `https://realtycalendar.ru/v2/` (relative paths in the bundle; a leading `/v2/` is stripped and re-added).
- Auth header: `X-User-Token: <token>`. In the browser the token is `localStorage.token` (set at login). No cookies or CSRF needed.
  Verified: plain `fetch` with only this header returns 200 for apartments, bookings and booking detail.
- Also sent: `X-Locale: ru`. Body: JSON (`Content-Type: application/json`), multipart for uploads.
- Query encoding is Rails-style: arrays as `key[]=a&key[]=b`, objects as `key[sub]=v`. `apartment_ids` is the exception: a comma-joined list.
- Errors: `401`/`422` → `{ "errors": { "<field>"|"common": [msg] } }`; `404` → not found; `5xx` → server error.
- Realtime: ActionCable WebSocket `wss://realtycalendar.ru/cable?token=<token>` (pushes calendar updates; optional for an MCP).
- Login: `POST sign_in` `{username, password}` → `{auth_token}` (the `/auth/sign-in` app; new flow, feature flag
  `v2_sign_up`) or the legacy Rails `/users/sign_in`; both hand the token back to the apps as `?token=` in the URL.
  Logout `DELETE sign_in` / `users/sign_out`. v1 uses a token copied from `localStorage.token`.
- Many endpoints have an `admin/` prefixed twin used in "manager" mode (agency staff working across agencies). Ignore them for v1.

## What v1 uses (2054-10-22)

The final v1 tool set is in [mcp-tool-spec.md](mcp-tool-spec.md). It uses: `apartments`, `info`, the calendar grid
`event_calendars/`, `event_calendars/{id}` (GET/POST/PUT/DELETE), `event_calendars/{id}/payments` (read only),
`apartments/{id}/price`, `arrivals_departures/by_dates`. Everything else below is reference for later versions.
Payload formats and tested behaviour: [mcp-user-stories.md](mcp-user-stories.md).

## Core: calendar and bookings

| Method | Path | Purpose |
|---|---|---|
| GET | `info` | Current user, agency, feature flags, constants |
| GET | `apartments?can_see=me&with_archive=0&page=N` | Properties (units) list → `{apartments:[{id,title,archive,agency_id,prices,rooms[],rates[]}], agencies:[...]}` |
| GET | `apartments/{id}/apartment_info` | Property details |
| GET | `apartments/{id}/price?begin_date&end_date[&guests_count&extra_charge…]` | Quote a stay → `{price}` |
| GET | `apartments/{id}/rates` | Rate plans |
| GET | `apartments/{id}/options` | Apartment options |
| GET | `apartments/{id}/check_in_rules` | Check-in rules |
| GET | `event_calendars/?begin_date&end_date&statuses[]=booked&statuses[]=request&apartment_ids=1,2,3` | **Calendar grid**: `{items:[{apartment_id, room_id, events:[booking summary], special_prices:[...]}]}`. The app chunks `apartment_ids`. `event_calendars/partners` is the partner-agencies variant. |
| GET | `event_calendars/{id}` | **Booking detail** (client, guest, amounts, prepaid, notes, source, platform, audits, …) |
| POST | `event_calendars` | **Create booking** (draft), body `{event_calendar:{status, apartment_id, realty_room_id, begin_date, end_date}}`; must be followed by the PUT |
| PUT | `event_calendars/{id}` | **Update booking**; full body required (strict schema) |
| DELETE | `event_calendars/{id}` | Delete (soft; `is_delete`) |
| POST | `event_calendars/{id}/restore` | Restore deleted booking |
| GET | `event_calendars/prepaid_amount?amount&begin_date&end_date` | Default prepayment for an amount |
| PUT | `users/preferences/active_statuses` | Which statuses the grid shows |

Booking statuses: `booked`, `request`, `canceled`, `deleted` (from `info.statuses`). Closed dates are not bookings:
they are `special_prices[]` rows with `closed: true` in the grid.

## Later versions (out of v1)

### Prices and availability (special prices / restrictions)

| Method | Path | Purpose |
|---|---|---|
| GET | `apartments/{id}/special_prices?begin_date&end_date` | Per-date price overrides / closures |
| POST | `apartments/{id}/special_prices` | Set them, body `{items:[{begin_date,end_date,price,closed,min_stay_through,closed_on_arrivial,closed_on_departure,…}]}` |
| POST | `events/special_prices`, `events/special_prices/prices` | Bulk set / preview across apartments |
| POST | `events/group_special_prices`, `events/group_special_prices/prices` | Same, for room groups |

### Booking money: payments, deposits, receipts

| Method | Path | Purpose |
|---|---|---|
| GET | `event_calendars/{id}/payments` | Payments for a booking |
| POST | `event_calendars/{id}/{payments\|deposits}` | Add payment / deposit `{amount,type,note,invoice_id?,email?}` |
| PATCH | `event_calendars/{id}/{payments\|deposits}/{pid}` | Edit note (needs `invoice_id`; amount ignored for payments) |
| DELETE | `event_calendars/{id}/payments/{pid}`, `…/deposits/{pid}` | Remove (manual payments: 422 "can't be deleted") |
| POST | `event_calendars/{id}/{kind}/{pid}/refund` | Refund |
| GET | `event_calendars/{id}/deposits` · POST `…/deposits/{pid}/withdraw` | Deposits (залоги) |
| GET | `event_calendars/{id}/payment_receipts` · PATCH/POST `…/payment_receipts/full_payments[/send_now]` | Fiscal receipts |

### Guests / clients

| Method | Path | Purpose |
|---|---|---|
| GET | `guests/search` | Search guests |
| GET | `guests/{id}`, `guests/{id}/event_history` | Guest card and booking history |
| PUT | `guests/{id}/notes` | Guest notes |
| GET | `clients/find_by_phone.json?phone=` | Lookup by phone (booking form) |
| POST / DELETE | `black_list`, `black_list/{id}` | Guest blacklist |

## Secondary (probably out of MCP v1)

- Guest messaging / automessages: `event_calendars/{id}/messages` (+ `send_now`, `retry`, `enable|disable`, `send_sms_link`, `telegram_invite/*`), `automations/event_calendars/{id}/chats`.
- Smart locks: `event_calendars/{id}/ttlock_lock_codes`, `…/renty_soft_lock_codes`, `integrations/renty_soft`.
- Contracts: `event_calendars/{id}/oki_doki_contracts`.
- Rooms: `PATCH apartments/{id}/realty_rooms/{room_id}` (rename).
- Partner network / cart (sell partners' units): `carts`, `carts/copy_link`, `carts/history`, `agencies/{add_to,remove_from}_favorites`, `agencies/remove_from_partners`.
- Expenses: `POST expenses`. Finance: `moneta/le_account`.
- Reference data: `cities`, `districts`, `metro_branches`, `metro_stations`, `yandex/geocoders/{id}/coordinates`.
- UI noise: `messages`, `messages/{id}/read`, `messages/read_all`, `updates/unread_count`, `info/sms_limit`, `chessmate/banner`, `ads/banners`.
- Manager-only: `admin/*` (agencies, users, `admin/{id}/sign_in` impersonation).

## Other sections (explored 2054-10-21)

Each left-nav section is its own Vue app (`/<section>/assets/main-*.js`) sharing the same HTTP client: same base URL,
same `X-User-Token` auth, same error format. Endpoint lists: `docs/endpoints/endpoints_<section>.txt`.

### "Клиенты и брони" → "Заезды / Выезды" (`/arrivals_departures/`) — `by_dates` used in v1

| Method | Path | Purpose |
|---|---|---|
| GET | `arrivals_departures/by_dates?period_start&period_end&limit=50[&kind&query&city_id&cursor]` | Check-ins/check-outs grouped by day → `[{date, events:[{id, begin_date, end_date, arrival_time, departure_time, room_title, address, client_name, client_phone, amount, prepayment, debt, deposit, source, rent_status, notes, attachments, …}]}]` |
| GET | `arrivals_departures/by_apartments` (same query) | Same, grouped by property ("По объектам") |
| POST | `arrivals_departures/event_calendars/{id}/comments` | Add a booking comment |
| POST / DELETE | `arrivals_departures/event_calendars/{id}/attachments[/{aid}]` | Booking files (multipart) |
| POST | `arrivals_departures/event_calendars/{id}/appearance` | Color / reaction marker on a booking |

- `kind`: `all`, `arrival`, `departure`; `by_apartments` also takes `living` and `vacant`. Range must be under one month.
- `query`: free-text search (address, lot, guest name or phone; not source).
- Pagination is cursor-based through **response headers**: `X-Has-More: true|false`, `X-Next-Cursor: <cursor>` → pass as `cursor`.
- There's a housekeeper ("cleaner") mode of this page that limits editable fields.

### "Клиенты и брони" → "Клиенты" tab — legacy, proposed out

This tab leaves the SPA for the old Rails page `/agencies/{agency_id}/apartments/requests_bookings`. Its XHRs return JSON
(`/requests_bookings/bookings?page&order`, `/clients?page`, `/requests_bookings/checkins_arrivals?date`) but **only with the
browser session cookie**: `X-User-Token` (alone, with `X-User-Email`, as `user_token`/`user_email` query params, or as Bearer)
all get 401. Supporting it would mean cookie auth plus CSRF. The same data is reachable through `/v2` (`by_dates`,
`event_calendars`, `guests/search`), so skip it.

### "Залоги" (`/deposits`) — not in v1

| Method | Path | Purpose |
|---|---|---|
| GET | `arrivals_departures/by_deposits` | `{balance, deposits:{no_deposits:[], waiting_payment:[], paid:[], …}}` — bookings bucketed by deposit state |
| POST | `settings/payments/info` | Payment settings shown on the page (balance top-up) |

Actions on a single deposit reuse `event_calendars/{id}/deposits` (listed under "Booking money" above).

### "Добавить объект" (`/apartment/`) — property editor, not in v1

Wizard pages, each with an `…/info` (read, POST despite reading) and `…/save` pair:

| Method | Path | Purpose |
|---|---|---|
| GET | `apartments/{id}/info` | Property card |
| POST | `apartments/address/info` · `apartments/address/save` | Address step (creates the property) |
| POST | `apartments/{id}/characteristics/{info\|save}` | Rooms, area, beds, guests |
| POST | `apartments/{id}/facilities/{info\|save}` | Amenities |
| POST | `apartments/{id}/photos/{info\|save}`, `apartments/{id}/temp_images[/{img}]` | Photos |
| POST | `apartments/{id}/official/{constants\|info\|save}` | Legal / official data |
| POST | `apartments/prices/info` · `apartments/prices` · DELETE `apartments/prices/destroy_season_price` | Base and seasonal prices |
| POST | `apartments/{id}/seasons/seasons_list` | Seasons |
| GET / PATCH | `apartments/{id}/check_in_rules`, POST `check_in_rules/check_in_rule` | Check-in rules |
| POST | `apartments/{id}/archives/{…}` | Archive / unarchive |
| POST | `apartments/{id}/history/info` | Change history |

### "Настройки" (`/settings`) — proposed out, except a few lookups

~130 endpoints, mostly account administration. Groups (full list in `docs/endpoints/endpoints_settings.txt`):

- **Possibly useful for the MCP:** `platforms` (booking channels / sources list), `agency_booking_origins/*` (custom booking
  sources), `settings/agencies/event_colors_list`, `settings/seasons/seasons_list`, `settings/{channel}/connections` and
  `…/{id}/sync` (OTA channel connections and manual sync), `settings/users/info` (staff list).
- **Out:** agency profile and password, users/roles/access, notifications, mail templates, automations, booking widget
  (`booking_widgets/*`, promo codes), payments and billing (`moneta/*`, `settings/payments/*`, `settings/balances/*`,
  `settings/billing/*`, wallet, Yandex Kassa), integrations (TTLock, RentySoft, OkiDoki, amoCRM, webhooks, WhatsApp, MAX,
  Android SMS), reports download, `redata/*`, dynamic stays, platform taxes.

### "Обновления" (`/updates`) — out

Product changelog / news. Not relevant to an MCP.

## Earlier open questions (answered 2054-10-22)

1. Create/update payloads — captured from a real save; see mcp-user-stories.md "Write API".
2. Statuses `booked`/`request`/`canceled`/`deleted`; closed dates are `special_prices.closed`.
3. `apartments` returns no pagination info (9 categories here); the web app splits `apartment_ids` into chunks of 10
   when there are more than 50. Grid range: 6 months OK, 15 months rejected.
4. Token from `POST sign_in` → `auth_token`. Lifetime still unknown.
