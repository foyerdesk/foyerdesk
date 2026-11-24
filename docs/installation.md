# Installation

FoyerDesk has two parts: the **Worker** (server side, runs on Cloudflare Workers) and the **screens** (plain browser modules, no framework). They must be served from the **same origin**: the Worker takes over `/api/auth/*` and `/api/support/*` on your site, and the screens call those paths.

## What you need
| Need | Notes |
|---|---|
| Node.js 22 or newer | to run tests and `wrangler` |
| A Cloudflare account with your site's zone | Workers with Durable Objects. The Free plan works; see the budget in [architecture.md](architecture.md) |
| A Chatwoot account (self-hosted or cloud), 4.x | Developed and tested against 4.20.1 only |
| A way to sign customers in | any OpenID Connect provider, or the built-in emailed link (needs a Resend account) |

## 1. Try the screens in two minutes (no Chatwoot, no accounts)
```
npm install
npm run demo -w packages/ui        # opens on http://127.0.0.1:4180/
```
This runs the real screens against a small in-memory stand-in for the Worker. Data is demo data and resets when you stop it.

## 2. Check the code
```
npm install
npm run setup:browser    # once, for the screen tests
npm test                           # worker unit and acceptance tests, then screen tests
```

## 3. Prepare Chatwoot
Follow [chatwoot-integration.md](chatwoot-integration.md): an API-channel inbox, an integration user and its token, a webhook.

## 4. Prepare sign-in
Follow [authentication.md](authentication.md).

## 5. Deploy the Worker
1. Copy `examples/lavatti/wrangler.jsonc` to your own file. Change `name`, `account_id`, the two `routes` (`<your-site>/api/auth/*` and `<your-site>/api/support/*`, with your `zone_name`) and the `vars` (see [configuration.md](configuration.md)). Keep the Durable Object bindings and migrations.
2. Store the secrets:
   ```
   cd packages/worker
   npx wrangler secret put CHATWOOT_APPLICATION_TOKEN --config <your wrangler file>
   npx wrangler secret put CHATWOOT_CONTACT_SOURCE_KEY --config <your wrangler file>   # any long random string; never change it later
   npx wrangler secret put CHATWOOT_WEBHOOK_SECRET --config <your wrangler file>
   npx wrangler secret put OIDC_CLIENT_SECRET --config <your wrangler file>            # only with an OpenID Connect provider
   ```
3. `npx wrangler deploy --config <your wrangler file>`.

## 6. Add the screens to your page
Copy `packages/ui/src/foyerdesk.js`, `api.js`, `dom.js`, `i18n/` and `foyerdesk.css` to your site, then:
```html
<link rel="stylesheet" href="/foyerdesk/foyerdesk.css">
<div id="support"></div>
<script type="module">
  import { mountFoyerdesk } from "/foyerdesk/foyerdesk.js";
  mountFoyerdesk(document.getElementById("support"), { brand: "Support", loginUrl: "/api/auth/login?returnTo=%2Fsupport" });
</script>
```
Options: `lang`, `apiBase`, `authBase`, `loginUrl`, `brand`. Colours are CSS variables on `.fd`; a dark page adds the class `dark` on `<html>`.

## 7. Verify before announcing
1. Open the page, sign in, create a topic, answer it from Chatwoot: the reply must appear within seconds without reloading.
2. Sign out: the page must say "You have signed out".
3. Optional: `npm run test:live -w packages/worker` against your Chatwoot. Set `FOYERDESK_CHATWOOT_URL`, `FOYERDESK_CHATWOOT_ACCOUNT` and `FOYERDESK_CHATWOOT_TOKEN_FILE` (a file that holds the token). It creates one PROBE contact and deletes it.

## Docker
There is no Docker image and no Docker Compose file: the server side is a Cloudflare Worker and the screens are static files. There is no `.env` file either; settings are Worker variables and secrets. For a local Worker with `wrangler dev`, copy `examples/dev.vars.example` to `.dev.vars`. Running the Worker that way is not covered by this repository's tests.
