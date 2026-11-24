# What the reference projects have that FoyerDesk does not

Read from the READMEs and code of the pinned references in [REFERENCES.md](REFERENCES.md) (2026-11-24). Nothing here has been probed against Chatwoot yet: "needs a probe" means the Chatwoot call it would rely on is unchecked. Priorities are a recommendation for the maintainer, not a commitment.

| # | Feature | Seen in | FoyerDesk today | Value for customers | Effort and risk | Priority |
|---|---|---|---|---|---|---|
| 1 | **Sliding session**: the timeout restarts on activity (30 minutes of inactivity) | DelvyG | The session is fixed at 15 minutes after sign-in. Someone writing a long answer can be signed out mid-way | **Done (CHG-058)**: 30 minutes idle, 8 hours cap, tested. High: a lost draft is the worst moment to expire | Small: extend the Durable Object expiry on each authenticated call, with an absolute cap (for example 8 hours) so a stolen cookie does not live forever. Needs a test for both | **P1** |
| 2 | **Email field for the emailed link** on the sign-in card | DelvyG (its only sign-in) | The endpoint and tests exist; the screen has no field | High for sites without an identity provider | Small: one form, uses `/api/auth/email/start`. Verify with a real mail service first | **P1** |
| 3 | **Search in history** | FreeScout, ICT Shift (status filter) | Tabs All, Open, Resolved only | Medium once a customer has dozens of topics | Medium. Needs a probe: Chatwoot conversation search by text, scoped to the contact and inbox | P2 |
| 4 | **Satisfaction rating** after a topic is solved | KiteDesk (one-click 1 to 5 email) | The page hides Chatwoot's own "please rate" message so it does not show as a reply | Medium for the team (a quality signal) | Medium. Needs a probe of Chatwoot's CSAT objects and how a rating is submitted through the API | P2 |
| 5 | **Suggest help articles while typing the subject** | KiteDesk | None | Medium: fewer tickets | Medium. Needs a probe of the Chatwoot Help Center API (portals, articles, search) | P3 |
| 6 | **Priority field** on a new topic | ICT Shift (optional `show_priority`) | None | Low to medium; the customer's guess is often wrong | Small. Chatwoot conversations have a priority; needs a probe that the API-channel inbox accepts it | P3 |
| 7 | **Attachments** | ICT Shift, KiteDesk | Off by decision | High for screenshots | Large, and the main security risk: type and size checks on the server, storage, scanning, download rules. Do not start before a design review | P3 (after review) |
| 8 | **Separate list and detail pages** with configurable URLs | ICT Shift (`ticket_detail_url`, `new_ticket_url`) | One page with hash routes (`#/topic/<id>`) | Low: only matters for hosts that want real URLs | Medium: server-side routes and history handling | P4 |
| 9 | **Guest requests** without sign-in, followed by emailed links | KiteDesk, ICT Shift (public forms) | None, on purpose: one sign-in, no anonymous conversations | Medium for a public contact form | Large and against the current design (no unverified identities) | Not planned |
| 10 | **Second interface language** | DelvyG (Spanish), KiteDesk (Portuguese) | Dictionary and parity test exist; only English | Depends on the site | Small per language: one file | On request |

## What the references have that is not a portal feature
Shared inbox, SLAs, canned replies, kanban, routing rules, workflows (KiteDesk, FreeScout), the visual flow builder and support-hours hand-offs (ICT Shift). These are the team's side. In Chatwoot they belong to Chatwoot and are out of scope for FoyerDesk.

## Where FoyerDesk is ahead (verified by its own tests)
Server-side ownership checks on every topic call, signed webhook, live replies over a WebSocket instead of polling, idempotent create and reply, several topics with full history and paging past Chatwoot's 25-conversation limit, a persistent account card with Sign out, dark theme, sessions held server-side. The references keep sessions in memory (DelvyG) or are whole products (KiteDesk, FreeScout).

## Suggested order
1. Sliding session (P1) with its tests.
2. Email field (P1), then one real-mail run to move the emailed link from "tested with a fake" to verified.
3. Probe items 3, 4, 5 and 6 in one sitting with `probes/` (read-only calls on a test account), then decide.
4. Attachments only after a written design and a security review.
