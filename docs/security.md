# Security

How FoyerDesk is meant to protect customer conversations, and what is checked by tests. To report a problem see [SECURITY.md](../SECURITY.md).

| Rule | Where it is enforced | Tested |
|---|---|---|
| The Chatwoot token never reaches the browser | Worker only; the screens call same-origin `/api/*` | acceptance |
| A topic is only reachable by the contact who owns it, in the site's inbox. A foreign or unknown id gets the same answer | `thread.mjs`, `topics.mjs` | unit, acceptance |
| State-changing requests need the site's own `Origin` (a foreign and a missing one are both refused, checked before the session) | `worker.mjs` | `oidc-negative` (every POST route), acceptance |
| Requests are idempotent: a retry with the same request id never creates a second topic or message | `thread.mjs` | acceptance |
| Webhook accepted only with a valid Chatwoot HMAC signature and fresh timestamp; it carries no message text to the page | `stream.mjs` | acceptance |
| Session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`, 15 minutes; the session is revoked on sign-out | `worker.mjs`, `session.mjs` | `oidc-negative` (attributes), acceptance, screens |
| Messages are rendered as text, never as HTML | `packages/ui/src/dom.js` | screens (broken escaping was caught by a test) |
| OpenID Connect: PKCE (S256 of the verifier that was sent), state, nonce, signature, algorithm allow-list (no `none`, no HS*), issuer, audience, expiry, same subject in token and userinfo, `email_verified` exactly `true` | `worker.mjs`, `oidc.mjs` | `oidc-negative` (one wrong thing per case, plus a control; the nonce check was removed once to confirm the test fails) |
| Emailed link: hashed single-use token, confirm button, rate limits | `emaillink.mjs` | acceptance |
| A visitor is only sent back to a path listed in `RETURN_PATHS` after sign-in | `worker.mjs` | acceptance |
| Every answer carries `X-Content-Type-Options: nosniff`, HSTS and a referrer policy; CSP on the Worker's own pages; `Cache-Control: no-store` on API answers | `worker.mjs` | `oidc-negative` |
| A failed sign-in never shows raw JSON or an internal reason: the visitor is redirected with a short `auth_error` code, the detail goes to the server log | `worker.mjs` | `oidc-negative`, acceptance |
| The provider's picture address is not copied into Chatwoot (Chatwoot would download any address) | `contact.mjs` | acceptance |
| Signing out closes the contact's open live channel | `worker.mjs`, `stream.mjs` | acceptance |

## Not covered
- **Known gaps from the 2026-11-24 independent review, not yet fixed:** the session cookie is not signed (a random value still reaches a Durable Object and is refused there); no rate limit for a signed-in visitor and the idempotency ledger has no expiry; email-link limits can be bypassed with `+` aliases and IPv6 and the link is not tied to the browser that asked for it; a visitor whose email changed at the provider is blocked (`explicit_contact_linking_required`) with no self-service way back; a socket that is open when the 15-minute session simply expires stays open until the page closes it. See `docs/ROADMAP.md`.
- **Attachments** are off. They need server-side type and size checks first.
- **Rate limits** exist only for the emailed link. Cloudflare's own protections apply to the rest.
- **A Chatwoot contact with the same email but another identifier** blocks sign-in on purpose rather than merging.
- The test mode inside the Worker (used when `FULL_PAGE_INBOX_ID` is unset) must stay unset in production.
- No external security review has been done.
