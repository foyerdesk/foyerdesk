# Repository roadmap

One place for what is open in this repository: housekeeping, known gaps, verification debts and planned features. Update it in the same pull request that closes or adds an item. State on 2026-11-24.

## Done at publication
Public repository whose history starts from a single commit (later work is ordinary commits), branch protection (check `test`), Dependabot, secret scanning with push protection, CodeQL, private vulnerability reporting, social preview uploaded, README with real screenshots, documentation set, CI green.

## Housekeeping (maintainer)
| Item | Notes |
|---|---|
| Check the name "FoyerDesk" against trademark registers | No other GitHub repository and no unscoped npm package of that name on 2026-11-24 |
| Tag `v0.1.0` and write the release notes | Copy the 0.1.0 entries of `CHANGELOG.md` |
| Review Dependabot pull requests | Five opened at publication, including a major `jose` upgrade (5 to 6). Merge only with `npm test` green |
| Remove one site's ids from `examples/lavatti/wrangler.jsonc` | Cloudflare account id and sign-in client id are public now (not secrets). Replace with placeholders if unwanted |
| Website, Discussions | Add a website URL when one exists; turn on Discussions when questions outnumber bugs |
| Decide about the npm scope `@foyerdesk` | Reserved with a placeholder `@foyerdesk/cli@0.0.1`; nothing is published from this repository yet |
| Review the first CodeQL results regularly | One finding was fixed at publication |

## Known gaps in the code
- The Worker has an internal test mode (used when `FULL_PAGE_INBOX_ID` is unset) that exists only for the acceptance tests. Remove it and move those tests to the real path.
- Two Durable Object classes are still named `TestSupportSession` and `TestSupportThread`. Renaming needs a migration.
- Only the emailed-link endpoint exists; the screens have no email field yet.
- An existing Chatwoot contact with the same email but another identifier blocks sign-in (`explicit_contact_linking_required`). A safe linking flow is not designed.
- No Docker image or Compose file. `wrangler dev` with `examples/dev.vars.example` is not covered by tests.
- Development dependencies (`wrangler`, `miniflare`, through `undici`) have known advisories; production dependencies are clean. Upgrade through Dependabot.

## Verification debts
- OpenID Connect has run end to end against Logto only. Keycloak, Auth0, Entra and Clerk are unverified.
- The emailed link was tested with a fake mail service only.
- Chatwoot 4.20.1 is the only probed version.
- One site is in production; a second site has not been set up from the docs yet.
- No external security review.

## Planned features (not implemented)
The comparison with the reference projects, with priorities, is in [REFERENCE_GAP.md](REFERENCE_GAP.md).
0. ~~Sliding session with an absolute cap~~ done: 30 minutes idle, 8 hours cap.
1. Email field on the sign-in card for the emailed link.
2. A mode for sites that already have their own users (the site signs a short token).
3. Attachments, after server-side type and size checks and a security review.
4. Verified setups for other sign-in providers.
5. More interface languages (dictionary file per language already exists).
6. Rename the Durable Object classes and remove the test mode (see gaps).

## Open legal item
- Written confirmation from the author of DelvyG/chatwoot-portal about the use of its ideas and screen structure (see NOTICE). Until it exists the NOTICE text says so plainly.
