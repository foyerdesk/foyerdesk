# Changelog

## Unreleased - public presentation
Brand assets (logo in light and dark, icon, favicon, social preview), README with real screenshots and an animation of the main scenario, documentation set (installation, configuration, Chatwoot integration, authentication, security, architecture, brand), CONTRIBUTING, CI workflow and Dependabot configuration (not yet run on GitHub), `npm run demo` (screens with demo data), `npm run media` (regenerates screenshots).
Code: sign-in is provider-neutral (OpenID Connect with discovery; Logto extras optional); built-in emailed-link sign-in; floating account card; the page no longer rebuilds while the visitor types; no site-specific names in the code (Chatwoot address and account are required settings, cookie names are `__Host-foyerdesk-*`).

## 0.1.0 - 2026-11-24 (initial import)
Imported from a working support Worker (history paging, live replies, topics API) together with its tests
and the Chatwoot probes. Behaviour unchanged. Known cleanup (not done on purpose, to keep the import faithful): Durable Object classes
`TestSupportSession` and `TestSupportThread` still carry "Test" in their names; renaming needs a Durable Object migration.

## Unreleased - screens (packages/ui)
Topics list with Open and Resolved tabs and paging, new topic (subject optional, one request id per text), topic view with its own scroll, resolve and reopen, side panel with account card, recent topics and unread marks, live refresh from `changed:<id>` pushes, safety checks, sign-out and session-end handling, English dictionary with a parity test for new languages. 38 browser tests; a deliberately broken text escaping was caught by the tests. Not yet run against the real Worker on a live page.

## Unreleased - fixes after the first real use (2026-11-24)
- Closed topics stayed out of sight (the default list and the side panel showed open topics only). The list is now the whole history (tabs All, Open, Resolved; `tab=all` in the API) and the side panel lists closed topics too, marked Resolved.
- Chatwoot's "Please rate the conversation" message appeared as a preview and inside the thread. Forms and rating requests are no longer shown to the customer.
- On a window narrower than 1024 px the open topic hid Sign out completely. A slim bar with Sign out now stays above the topic. Signing out also clears `#/topic/<id>` from the address.
- New real-browser test against the real Worker and a real Chatwoot (`packages/ui/test/live/real-worker.mjs`), which found and now guards the above.
