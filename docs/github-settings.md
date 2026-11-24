# GitHub repository settings (for the maintainer)

State on 2026-11-24, when the repository became public. The previous private repository (with the full working history) is archived as `foyerdesk/foyerdesk-private-archive`; this one starts from a single commit.

| Setting | Value | State |
|---|---|---|
| Visibility | Public | Done |
| Description | Customer support portal for Chatwoot: sign in once, keep every topic, see replies live. Open source, self-hosted on Cloudflare Workers. | Done |
| Topics | `chatwoot`, `customer-support`, `helpdesk`, `customer-portal`, `cloudflare-workers`, `open-source` | Done |
| Website | Empty until a project site exists | Open |
| Social preview | Settings, General, Social preview, upload `assets/brand/social-preview.png` (1280 × 640). GitHub has no API for this | **Manual** |
| Issues | On, bug template in `.github/ISSUE_TEMPLATE` | Done |
| Discussions | Off for now; turn on when questions outnumber bugs | Off |
| Wiki, Projects | Off | Done |
| Merge settings | Squash merge only, delete head branch after merge | Done |
| Branch protection on `main` | Pull request required, status check `test` must pass and be up to date, linear history, no force pushes, no deletion. Administrators are not forced (`enforce_admins` off) | Done |
| Dependabot | Alerts, security updates, and version updates from `.github/dependabot.yml` | Done |
| Secret scanning and push protection | On | Done |
| Code scanning | CodeQL default setup, query suite default | Done; check the first result in the Security tab |
| Private vulnerability reporting | On (`SECURITY.md` points to it) | Done |
| Releases | Tag `v0.1.0` when you are ready; copy the 0.1.0 entries of `CHANGELOG.md` | Not released |

## Still open
1. Upload the social preview (manual, see above).
2. Check "FoyerDesk" against trademark registers. No other GitHub repository and no unscoped npm package of that name was found on 2026-11-24; the npm scope `@foyerdesk` is reserved.
3. `examples/lavatti/wrangler.jsonc` contains one site's Cloudflare account id and sign-in client id (neither is a secret). Replace them with placeholders if you do not want them public.
4. Review the Dependabot pull requests when they appear, including the major `jose` upgrade.
