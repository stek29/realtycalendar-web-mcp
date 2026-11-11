# Booking workflows and upstream behavior

This guide explains the RC behavior behind the tools. The exact contract is in
[mcp-tool-spec.md](mcp-tool-spec.md); the endpoint inventory is in [api-scope.md](api-scope.md).
Examples and test fixtures use fictional identifiers, contacts, dates and amounts.

## Account model

- An RC “apartment” is a category. A “realty room” is an optional physical room within that category.
- A booking belongs to a category and may have no room. For categories with rooms, this means unassigned.
- A category without rooms is a single unit; its bookings have a null room without being unassigned.
- `booked` reservations consume capacity. `request` holds are shown but do not block bookings.
- `source_id` joins to `info.agency.sources_list`; it is not a platform-integration hotel ID.
- Room titles and category layout are account-specific. The fixture's layout is only an example.

## Workflows

| User request | Tools |
| --- | --- |
| List categories and rooms | `list_rooms` |
| Find availability, prices and stay restrictions | `check_availability` |
| Find stays, arrivals, departures, unpaid or unassigned bookings | `list_bookings` |
| Inspect a booking, payments or optional change history | `get_booking` |
| Create a manual booking or hold | `preview_create_booking` → `create_booking` |
| Move, assign, extend or annotate a booking | `preview_update_booking` → `update_booking` |
| Cancel a guest's booking | `preview_cancel_booking` → `cancel_booking` |
| Delete an accidentally entered booking | `preview_delete_booking` → `delete_booking` |

Every write requires a token from the same-argument preview and approval in the client's write prompt.
“Cancel” changes status; “delete” soft-deletes. Ambiguous requests should be clarified.

## Availability

The calendar grid reports busy stays, not a ready-made list of free rooms. Availability combines the catalog,
overlapping bookings, per-room closures and category capacity. Unassigned bookings consume category capacity even
when individual rooms look empty. Check-out is exclusive, so departure and arrival on the same date do not overlap.
Whole-stay financial totals are not prorated to a reporting window.

Stay restrictions and closed nights need explicit checks: RC can accept a booking below the minimum stay or on
closed nights. The server warns before a write; a successful upstream response alone does not establish bookability.

## Create and update

Creating a booking is two upstream calls: `POST event_calendars` creates a draft, then `PUT event_calendars/{id}`
saves its full body. An abandoned or rejected draft may be invisible and return 404 to DELETE while remaining
saveable. Drafts do not consume room capacity. A timeout therefore has an uncertain outcome; writes are not
automatically retried, and repeated creates use the duplicate check.

Updates start from a fresh GET, preserve guest/client IDs and untouched fields, then send a complete PUT body.
Unknown GET fields cause `RC_SCHEMA_DRIFT` rather than risking their loss. Changing category and supplying an
incompatible room may silently unassign the room in RC, so the server derives category from the target room.
An upstream audit version, rather than `updated_at`, detects changes since preview.

Creating with `guest.id: null` makes a new guest record; matching name/phone does not guarantee reuse. Test guest
records and soft-deleted bookings can remain after cleanup. Neither email confirmations nor prepayment links are
sent by the tools.

## Booking-site reservations

Booking-site details join through the booking and source information; `is_external` alone is insufficient to
recognize them. Site bookings may arrive unassigned. Assigning a room in the existing category remains allowed under
`RC_SITE_BOOKINGS=protect`; changing dates, category, price or status, canceling and deleting are refused because RC
does not send those changes back to the booking site. Use `allow` only when that discrepancy is intended.

## Prices and payments

The price endpoint quotes the stay. A caller-supplied total or per-night price overrides that quote for a manual
booking. Extending a booking without an explicit price keeps its previous average per night; the preview asks the
user to resolve the price warning. Changes to category can retain the previous total with a warning.

Payments belong to the account's configured payment accounts (`agency.rent_payment_invoices`). Account IDs and bank
transfer conventions are not portable between hotels. The tool set reads payments but does not create or refund
them. RC may refuse deleting a payment, requiring a refund that leaves both records in the accounting history.

## Authentication and unsupported requests

Each RC sign-in creates a separate opaque token. Logging out ends that session; upstream controls its lifetime.
Hosted refresh can sign in again using credentials inside the encrypted refresh token. See
[architecture.md](architecture.md) for that privacy and security trade-off.

The tools do not filter booking lists by creation date, track unread/new bookings, edit existing guest contacts,
record payments or restore deleted records. Creation/history timestamps may be available on an individual booking,
but do not provide a global creation-date search. Notification support remains unverified.
