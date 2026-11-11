# Design decisions

This is the maintained rationale for the current implementation. Detailed milestone plans and execution diaries
remain in the sanitized Git history. D-numbers in comments refer to the original decisions grouped below.

| Decisions | Current choice | Reason |
| --- | --- | --- |
| D1–D10 | One TypeScript package with portable domain logic, typed RC responses and platform adapters | Share the tools between local stdio and hosted HTTP; detect upstream drift |
| D11–D14 | Tolerant Russian name matching and Cyrillic/Latin transliteration | Accept common inflections and mixed-script guest records; writes select booking IDs |
| D15–D21 | Create through a draft then PUT; update from a fresh GET; fail closed on unknown fields | Match the upstream API and preserve existing guest records and untouched fields |
| D22–D30 | Unit tests and fake-RC evals; live tests are opt-in and limited to an explicitly approved test scope | Exercise behavior without exposing or modifying real reservations by default |
| D31–D32 | Local login prints a separate session token; audit entries use the log stream | Avoid local password storage and platform-specific audit files |
| D33–D36 | Separate read-only preview and destructive write tools; the token binds the write to its preview | Keep client approval at the actual write; do not rely on a chat “yes” |
| D38 | Bind confirm-token freshness to the last upstream audit version, not `updated_at` | Upstream timestamps can move without a meaningful booking change |
| D40 | Protect booking-site reservations by default | Local changes to dates, prices or status are not propagated to the booking site |
| D41, D47, D59–D60 | Scoped descriptions, explicit date rules and negative/contextual eval cases | Reduce wrong-tool selection and over-triggering on personal calendars |
| D42, D46, D54 | Local stdio runs from a checkout; Docker serves hosted HTTP; no npm package | Keep packaging aligned with the supported deployment paths |
| D49 | Isolate model eval clients from local credentials and repository writes | Model runners must not reach real-account files during fake-data evals |
| D51–D53 | Per-connection access level, allowlisted CIMD clients and encrypted stateless tokens | Support connector login without a session database |
| D55 | Use validated cached/bundled client metadata only when fetching fails | Keep connector login usable during network challenges without accepting invalid documents |
| D56–D57 | Trusted proxy hops, bounded bodies and correlated logs with account pseudonyms | Trace requests without writing account login strings to logs |
| D62–D64 | Booking change history is optional and upstream free text stays untrusted | Keep ordinary booking reads concise and avoid treating audit text as instructions |

The historical model benchmark scores describe those runs only. Current remaining validation and authentication
limitations are tracked in [roadmap.md](roadmap.md), not inferred from previous release tags.
