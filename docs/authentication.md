# Authentication

FoyerDesk does not store passwords. A customer proves who they are in one of two ways; both end in the same place: a Chatwoot contact, and a session cookie that holds nothing but a random id.

## OpenID Connect (any provider)
Create a web application at your provider with redirect `https://<your-site>/api/auth/callback`, PKCE S256 and scopes `openid profile email`. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and the secret `OIDC_CLIENT_SECRET`.

What the Worker does: reads the endpoints from `<issuer>/.well-known/openid-configuration` (and refuses a document whose `issuer` differs); sends the visitor with PKCE, `state` and `nonce`; exchanges the code; checks the ID token signature against the provider's keys (ES256, ES384, RS256, PS256 or EdDSA), issuer, audience and nonce; reads user info and requires the same `sub`; requires `email` with `email_verified: true`.

Status: run end to end against **Logto** only. Keycloak, Auth0, Entra, Clerk and others use the same standard endpoints but are **unverified** until you have a passing login. `OIDC_FLAVOR=logto` adds Logto's direct provider links (`?provider=google|linkedin`) and shows the provider the visitor used.

## Emailed link (no provider)
Bind `EMAIL_LINKS` and set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_LINK_FROM`. The page posts `{ email }` to `/api/auth/email/start`; the visitor gets a link; the link opens a page with a **Sign in** button (so mail scanners that open links cannot use it up); the button posts the token once.

Rules: token is random, stored only as a hash, valid 15 minutes, single use; 3 links per address and 10 per IP in 10 minutes; the answer is the same for every valid address; same-origin `Origin` is required.
Status: tested with a fake mail service only. The built-in screen has no email field yet; a site that wants this must post to `/api/auth/email/start` itself.

## Sessions
After sign-in the Worker stores the identity in a Durable Object and sets `__Host-foyerdesk-session` (`Secure`, `HttpOnly`, `SameSite=Lax`, path `/`). A session lasts 15 minutes and is revoked on sign-out (`POST /api/auth/logout`). Other cookies: `__Host-foyerdesk-oidc` (the sign-in in progress), `-oidc-retry`, `-reauth`.

## Sign-in errors
The visitor is sent back with `?auth_error=<code>`; the screens show "Sign-in could not be completed". Codes in the Worker answers include `missing_transaction`, `invalid_transaction`, `token_exchange_failed`, `oidc_validation_failed`, `email_verification_required` and `explicit_contact_linking_required`.
