# Contributing

Thank you for helping. FoyerDesk is small on purpose: a Worker, some browser modules and Chatwoot. Please keep it that way.

## Ground rules
- Chatwoot's Application API and its signed webhook only. No second database, no fork of Chatwoot.
- One site is one Chatwoot account. The customer never picks a department.
- The service token never reaches the browser; every topic call checks ownership on the server.
- Anything specific to one site belongs in `examples/`, not in `packages/`.
- Say what is verified. A change that adds a claim to the docs adds the test or the probe that proves it, or marks the claim **unverified**.

## Set up
```
npm install
npm run setup:browser
npm test          # Worker unit and acceptance tests, then the screen tests (about a minute)
npm run demo -w packages/ui
```
Live tests (`npm run test:live -w packages/worker`, `npm run test:real -w packages/ui`) need a Chatwoot you control: set `FOYERDESK_CHATWOOT_URL`, `FOYERDESK_CHATWOOT_ACCOUNT`, `FOYERDESK_CHATWOOT_TOKEN_FILE`. They create PROBE contacts and delete them.

## Changing code
1. Write the failing test first when you fix a bug, and check that it fails without your change.
2. Keep screens framework-free. All text goes into `packages/ui/src/i18n/en.js`; a test checks every language has the same keys.
3. A change to the API between Worker and screens updates `docs/contract.json`; both sides' tests read it.
4. Update the docs and `CHANGELOG.md` in the same pull request.

## Pull requests
Small, one purpose, with a description that starts with the problem and the result. List what you ran. Add screenshots for visible changes (`npm run media -w packages/ui` regenerates `docs/screenshots`).

## Security
Do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).

## Licence
By contributing you agree that your work is released under the Apache License 2.0 (see `LICENSE`).
