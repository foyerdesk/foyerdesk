# Where the logic comes from (provenance)

Rule: reference projects are studied, not copied, unless this table says so. No reference code is copied into this repository; behaviour was studied and rewritten.
Local clones are kept OUTSIDE this repository (copyleft code must not sit in it).

| Source | Pinned version | Licence | What Foyerdesk took | Copied code? |
|---|---|---|---|---|
| **Chatwoot** `chatwoot/chatwoot` | tag v4.20.1 (the version in production) | MIT (Enterprise folder excluded) | The facts the design stands on: webhook signature (`lib/webhooks/trigger.rb`), webhook payload fields (`app/presenters/conversations/event_data_presenter.rb`), list cap of 25 (`contacts/conversations_controller.rb`), message paging (`MessageFinder`), conversation filter (`filter_service.rb`), out-of-office rules (`hook_execution_service.rb`). Each fact is also proved against the live server by `probes/` | No |
| **DelvyG/chatwoot-portal** | `cbd31ba` (2026-03-25) | none in the repository; the Foyerdesk owner knows the author and states that everything may be used (2026-11-24) | Screen set and layout: topics table (number, subject, status badge, last update), create form (subject + message), ticket view; colour variables, badge colours, the sign-in card values (`.auth-card`: 420 px, 12 px radius, centred title) | CSS values only. The rest is rewritten, because its server code has an XSS in `ticket.ejs`, an unsigned webhook, no CSRF protection, in-memory sessions, its own login |
| **FreeScout** `freescout-help-desk/freescout` | `1ffabc9` (2026-11-20) | AGPL-3.0 | Structure of history: a short "Previous conversations" list in the side panel with "View all N"; a full list with status badges, preview line and paging | No (structure only) |
| **KiteDesk** `kitedesk/kitedesk` | `69622ca` (2026-10-13) | AGPL-3.0 | Customer portal behaviour: tabs Open and Solved, the customer can mark a request as solved, a reply brings it back; statuses New, Open, Pending, On-hold, Solved, Closed | No (behaviour only) |
| **Chatwoot Client Portal by ICT Shift** (WordPress plugin) | 2.6.15 | GPL-3.0 | The status filter All, Open, Pending, Resolved; the rule "a topic belongs to this contact and to an allowed inbox" (`belongs_to_contact`); resolve and reopen actions | No (pattern only) |

Not from any reference, written for this project: the Worker (Logto sign-in with PKCE, session in a Durable Object, idempotent create and reply, signed webhook, hibernating socket), `topics.mjs` rules, the screens' code, dark theme, return to a linked topic after sign-in, adaptive refresh, the translation key test, the shared API contract, and all tests.
Documentation used besides these: Logto, Cloudflare Workers and Durable Objects, Chatwoot developer docs.
