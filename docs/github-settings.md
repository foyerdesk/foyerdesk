# GitHub repository settings (for the maintainer)

State on 2026-11-24 and what to do. "Done" means it is already set; the rest needs the repository to be **public** (branch protection and code scanning are not available to a private repository on the Free plan) or a click by an owner.

| Setting | Recommended value | State |
|---|---|---|
| Description | Customer support portal for Chatwoot: sign in once, keep every topic, see replies live. Open source, self-hosted on Cloudflare Workers. | Done |
| Topics | `chatwoot`, `customer-support`, `helpdesk`, `customer-portal`, `cloudflare-workers`, `open-source` | Done |
| Website | Add when a project site exists. Until then leave empty | Empty |
| Social preview | Settings, General, Social preview, upload `assets/brand/social-preview.png` (1280 × 640). GitHub has no API for this | **Manual** |
| Issues | On. Bug template is in `.github/ISSUE_TEMPLATE` | On |
| Discussions | Off for now. Turn on when questions outnumber bugs | Off |
| Wiki, Projects | Off (docs live in the repository) | Wiki off, Projects on: turn off |
| Releases | Tag `v0.1.0` after CI passes on GitHub and the public check list below is done; copy the 0.1.0 entries of `CHANGELOG.md` | Not released |
| Branch protection on `main` | Require a pull request, require the `CI / test` check, block force pushes, require linear history | After public |
| Merge settings | Squash merge only, delete head branch after merge | Manual |
| Dependabot | Alerts and security updates on; version updates come from `.github/dependabot.yml` | Config in repo; switch on in Settings, Code security |
| Secret scanning and push protection | On | After public |
| Code scanning | Enable CodeQL default setup for JavaScript | After public |
| Private vulnerability reporting | On (`SECURITY.md` points to it) | **Manual, after public** |

## Before making it public
1. CI is green on GitHub (run on commit 3eb231a) and passes on a clean copy with `npm ci`. Open Dependabot pull requests (including a major `jose` upgrade) still need review.
2. Publish a clean history: the current history contains internal notes. Squash to one commit and keep the old history in a private backup (a force push; needs the owner's decision).
3. Check the name "FoyerDesk" for conflicts (GitHub, npm, trademark registers). The npm scope `@foyerdesk` is already reserved.
4. Decide who is named in `NOTICE` and `SECURITY.md`.
