# Screens (packages/ui): plan

Decisions (2026-11-24): several topics per customer; page `/talk` with a side panel (account, topics, Sign out) and a conversation with its own scroll; design follows DelvyG (list of topics as a table with status badges, create form, ticket card) and FreeScout (short "recent topics" list in the side panel with "View all N", tabs with paging); English only, one dictionary file per language; attachments off; statuses Open, Pending, Resolved.

Technology: plain browser modules, no framework, no React. One call, `mountFoyerdesk(element, options)`, draws everything; an Astro page only holds the element and loads the script and the stylesheet. All text goes in with `textContent`, never as HTML (DelvyG's XSS in `ticket.ejs` is the case this avoids). The same module works on the old Vite site and on Astro.

| Screen | Route (hash) | Data |
|---|---|---|
| Guest: one Sign in button, reason notice (signed out / session ended) | none | `/api/support/session` 401 |
| Side panel: account card (name, email, sign-in method), New topic, Recent topics (5, unread dot), View all, Sign out, unread badge | always | session, topics page 1 |
| Topics | `#/` and `#/resolved` | `GET /api/support/topics?tab=&page=` |
| New topic | `#/new` | `POST /api/support/topics` |
| Topic | `#/topic/{id}` | `GET/POST /api/support/topics/{id}/messages`, resolve, reopen |

Live: socket `/api/support/stream` sends `changed` or `changed:<id>`; the page refreshes the list and the open topic. With the socket open one safety check every 5 minutes; without it every 20 s while the tab is visible; nothing for a guest or a hidden tab.
Languages: add `src/i18n/<code>.json` and register it in `src/i18n/index.js`; a test fails if any key is missing or extra compared with `en.json`.

Tests (Playwright on a static harness page with the API mocked to the Worker's contract): guest, list with tabs and paging, new topic (subject optional, repeat uses one request id), topic view (own scroll, newest message shown, resolve and reopen), unread dot and badge, push refresh, no timers for a guest or a hidden tab, text injected as `<img onerror>` stays text, sign out, session end, language parity. Then the same screens against the real Worker (P2b) once a v4 page can host them.
