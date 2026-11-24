# Security

How FoyerDesk is meant to protect customer conversations, and what is checked by tests. To report a problem see [SECURITY.md](../SECURITY.md).

| Rule | Where it is enforced | Tested |
|---|---|---|
| The Chatwoot token never reaches the browser | Worker only; the screens call same-origin `/api/*` | acceptance |
| A topic is only reachable by the contact who owns it, in the site's inbox. A foreign or unknown id gets the same answer | `thread.mjs`, `topics.mjs` | unit, acceptance |
| State-changing requests need the site's own `Origin` | `worker.mjs` | acceptance |
| Requests are idempotent: a retry with the same request id never creates a second topic or message | `thread.mjs` | acceptance |
| Webhook accepted only with a valid Chatwoot HMAC signature and fresh timestamp; it carries no message text to the page | `stream.mjs` | acceptance |
| Session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`; the session is revoked on sign-out | `worker.mjs`, `session.mjs` | acceptance, screens |
| Messages are rendered as text, never as HTML | `packages/ui/src/dom.js` | screens (broken escaping was caught by a test) |
| OpenID Connect: PKCE, state, nonce, signature, issuer, audience, verified email | `worker.mjs`, `oidc.mjs` | acceptance, unit |
| Emailed link: hashed single-use token, confirm button, rate limits | `emaillink.mjs` | acceptance |
| A visitor is only sent back to `/talk` or `/support` after sign-in | `worker.mjs` | acceptance |
| CSP on the Worker's own pages; `Cache-Control: no-store` on API answers | `worker.mjs` | acceptance |

## Not covered
- **Attachments** are off. They need server-side type and size checks first.
- **Rate limits** exist only for the emailed link. Cloudflare's own protections apply to the rest.
- **A Chatwoot contact with the same email but another identifier** blocks sign-in on purpose rather than merging.
- The test mode inside the Worker (used when `FULL_PAGE_INBOX_ID` is unset) must stay unset in production.
- No external security review has been done.
