# Configuration

Settings are Cloudflare Worker **variables** (not secret, in the wrangler file) and **secrets** (`wrangler secret put`). `examples/lavatti/wrangler.jsonc` is a complete working example.

## Chatwoot
| Name | Kind | Required | Meaning |
|---|---|---|---|
| `CHATWOOT_BASE_URL` | variable | yes | `https://` address of Chatwoot, no trailing slash. No default |
| `CHATWOOT_ACCOUNT_ID` | variable | yes | Numeric account id. No default |
| `FULL_PAGE_INBOX_ID` | variable | yes | Numeric id of the API-channel inbox customers write into. When unset the Worker runs a built-in test mode that exists only for the acceptance tests |
| `CHATWOOT_APPLICATION_TOKEN` | secret | yes | Access token of the integration user. Never reaches the browser |
| `CHATWOOT_CONTACT_SOURCE_KEY` | secret | yes | Long random string used to derive each contact's inbox source id (HMAC). Changing it later orphans existing contacts |
| `CHATWOOT_WEBHOOK_SECRET` | secret | yes | Signing secret of the Chatwoot webhook |
| `CHATWOOT_INBOX_IDENTIFIER` | secret | no | Inbox identifier of the API channel. With it the page tells Chatwoot a reply was read, so Chatwoot does not also email it |

## Site
| Name | Kind | Required | Meaning |
|---|---|---|---|
| `CALLBACK_URI` | variable | yes | `https://<your-site>/api/auth/callback`. Its origin is the only origin the Worker answers on |
| `IDENTIFIER_PREFIX` | variable | no | Start of the identifier stored on each Chatwoot contact. Default `foyerdesk-`. Never change it later |
| `DEFAULT_CONTACT_NAME` | variable | no | Name given to a new contact until the provider reports a real one. Default `Customer` |
| `RETURN_PATHS` | variable | no | Comma-separated pages a visitor may be sent back to after signing in, and where a failed sign-in is reported (the first one). Default `/support` |
| `REQUEST_MARKER` | variable | no | Message attribute that carries the request id (recognises retries). Default `foyerdesk_request_id`. Never change it later |

## Sign-in
| Name | Kind | Meaning |
|---|---|---|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | variable | OpenID Connect provider and application |
| `OIDC_CLIENT_SECRET` | secret | Application secret |
| `SESSION_SECRET` | secret, optional | Key for signing the session cookie. When unset a key is derived from `OIDC_CLIENT_SECRET`, else the webhook secret, else the Chatwoot token. Changing it signs everyone out (sessions last 15 minutes) |
| `OIDC_FLAVOR` | variable | `logto` switches on Logto extras (direct provider links, the way of signing in). Default `generic` |
| `LOGTO_ISSUER`, `LOGTO_CLIENT_ID`, `LOGTO_CLIENT_SECRET` | variable, variable, secret | Older names. When `OIDC_ISSUER` is unset they select the Logto layout without a discovery request |
| `MAIL_PROVIDER` | variable | `resend` enables the emailed link (also needs the `EMAIL_LINKS` binding) |
| `RESEND_API_KEY` | secret | Resend key |
| `EMAIL_LINK_FROM` | variable | Sender, for example `Support <support@example.com>` |
| `EMAIL_LINK_BRAND` | variable | Name used in the email and on the confirm page. Default `Support` |

## Bindings
`SUPPORT_SESSIONS`, `FULL_PAGE_THREAD`, `SUPPORT_STREAM` and `EMAIL_LINKS` are Durable Objects (classes `TestSupportSession`, `TestSupportThread`, `SupportStream`, `EmailLinkStore`; the first two keep a `Test` prefix because renaming needs a migration). `SITE_ASSETS` is an optional static assets binding.

## Fixed limits (in code)
Session 15 minutes. Subject 3 to 120 characters, message up to 3000. At most 10 unresolved topics per customer. 25 topics a page, 20 messages a page. Emailed link valid 15 minutes, 3 links per address and 10 per IP in 10 minutes. After sign-in the visitor can only be sent back to a path listed in `RETURN_PATHS` (default `/support`); a failed sign-in is reported on the first one.

## Screens
`mountFoyerdesk(element, { lang, apiBase, authBase, loginUrl, brand })`. Languages: add `packages/ui/src/i18n/<code>.js` next to `en.js`, register it in `i18n/index.js`; a test fails when a key is missing or extra. Only English exists today.
