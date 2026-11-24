# Security

How FoyerDesk is meant to protect customer conversations, and what is checked by tests. To report a problem see [SECURITY.md](../SECURITY.md).

| Rule | Where it is enforced | Tested |
|---|---|---|
| The Chatwoot token never reaches the browser | Worker only; the screens call same-origin `/api/*` | acceptance |
| A topic is only reachable by the contact who owns it, in the site's inbox. A foreign or unknown id gets the same answer | `thread.mjs`, `topics.mjs` | unit, acceptance |
| State-changing requests need the site's own `Origin` (a foreign and a missing one are both refused, checked before the session) | `worker.mjs` | `oidc-negative` (every POST route), acceptance |
| Requests are idempotent: a retry with the same request id never creates a second topic or message | `thread.mjs` | acceptance |
| Webhook accepted only with a valid Chatwoot HMAC signature and fresh timestamp; it carries no message text to the page | `stream.mjs` | acceptance |
| Session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`, cookie 8 hours; server limits 30 minutes idle and 8 hours absolute; the session is revoked on sign-out | `worker.mjs`, `session.mjs` | `oidc-negative` (attributes), acceptance, screens |
| Messages are rendered as text, never as HTML | `packages/ui/src/dom.js` | screens (broken escaping was caught by a test) |
| OpenID Connect: PKCE (S256 of the verifier that was sent), state, nonce, signature, algorithm allow-list (no `none`, no HS*), issuer, audience, expiry, same subject in token and userinfo, `email_verified` exactly `true` | `worker.mjs`, `oidc.mjs` | `oidc-negative` (one wrong thing per case, plus a control; the nonce check was removed once to confirm the test fails) |
| Emailed link: hashed single-use token, confirm button, rate limits | `emaillink.mjs` | acceptance |
| A visitor is only sent back to a path listed in `RETURN_PATHS` after sign-in | `worker.mjs` | acceptance |
| Every answer carries `X-Content-Type-Options: nosniff`, HSTS and a referrer policy; CSP on the Worker's own pages; `Cache-Control: no-store` on API answers | `worker.mjs` | `oidc-negative` |
| A failed sign-in never shows raw JSON or an internal reason: the visitor is redirected with a short `auth_error` code, the detail goes to the server log | `worker.mjs` | `oidc-negative`, acceptance |
| The provider's picture address is not copied into Chatwoot (Chatwoot would download any address) | `contact.mjs` | acceptance |
| The session cookie is `<id>.<HMAC>` (key derived from `SESSION_SECRET`, else a secret the Worker already has): a forged or random cookie is refused before any Durable Object is asked | `worker.mjs` | `oidc-negative` |
| A customer is limited to 30 writes a minute (in memory, no storage write); the 31st gets 429 | `thread.mjs` | `oidc-negative` |
| Signing out closes the contact's open live channel | `worker.mjs`, `stream.mjs` | acceptance |

| Request bodies are read with a size cap while they arrive (12 KB for writes, 2 KB for the emailed link, 256 KB for the webhook); a missing or false length header does not help | `limits.mjs` | `oidc-negative` |
| Request records (idempotency) are removed after 48 hours | `thread.mjs` | acceptance |
| Calls to the sign-in provider time out after 8 seconds; its endpoints must be `https`; discovery is cached for an hour | `oidc.mjs` | unit |
| A Worker without `FULL_PAGE_INBOX_ID` answers 503 `misconfigured` (the built-in test mode needs `FOYERDESK_TEST_MODE=1`); the single-thread route `/api/support/messages` is off unless `LEGACY_MESSAGES=1` | `worker.mjs` | `oidc-negative` |
| Emailed link: the confirm page shows which address is being signed in; limits count the mailbox (no `+tag`, no Gmail dots) and the IPv6 /64, the network is counted before the address; an address the mail service refuses gets the normal answer; a Chatwoot outage does not use up the link | `emaillink.mjs`, `worker.mjs` | `emaillink` |
| A person whose verified address changed at the provider keeps the contact (the address follows) unless another contact owns it | `contact.mjs` | acceptance |
| Contact search reads up to five pages | `contact.mjs` | acceptance |
| A contact deleted in Chatwoot ends the session when a topic is started | `thread.mjs`, `worker.mjs` | acceptance |

## Not covered
- **Known gaps from the 2026-11-24 independent review, not yet fixed:** the emailed link is not tied to the browser that asked for it (only shows the address; binding would break opening it on another device, a decision for the owner); a socket that is open when the 15-minute session simply expires stays open until the page closes it; a retry of an unconfirmed reply looks only at the last 20 messages of the topic; the "unconfirmed" legacy reservation has no expiry (the route is off by default). See `docs/ROADMAP.md`.
- **Attachments** are off. They need server-side type and size checks first.
- **Rate limits:** the emailed link and 30 writes a minute per customer exist in the Worker; a flood of requests is for a Cloudflare rate-limiting rule to stop.
- **A Chatwoot contact with the same email but another identifier** blocks sign-in on purpose rather than merging.
- No external security review has been done.
