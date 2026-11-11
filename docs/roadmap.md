# Remaining work

The hosted server and booking-history feature are implemented. These items were still open at the last release;
the local unit suite does not establish that they have been completed.

## Client validation

- Run the booking-history eval cases U12d, U12e and X8 against the intended model clients.
- Complete end-to-end hosted connector checks in Claude web and ChatGPT web, including OAuth refresh, read calls,
  one explicitly approved test write, and whether each client passes MCP server instructions.
- Run selection evals with a second, decoy calendar MCP server. Existing negative/context cases use only this server.
- Verify Codex's `default_tools_approval_mode = "prompt"` before recommending its write flow as tested.

## Stateless authentication limitations

- Failed login attempts have no application-level rate limit; upstream RC throttling is relied on.
- There is no per-user revocation or account blocklist. Rotating the server key disconnects every user.
- Authorization codes and refresh tokens have no shared replay-detection state.
- There is no global token bucket towards RC. Revisit before serving additional tenants.

## Deferred features

- Payment/refund writes and guest-contact editing remain outside the tool set.
- Notification support needs a verified API model for new/unread bookings.
- MCP elicitation may improve write approval on clients that support it; keep unsupported clients usable.
- Cloudflare Workers remains a possible adapter, not an implemented deployment target.
