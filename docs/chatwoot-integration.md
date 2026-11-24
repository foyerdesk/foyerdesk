# Chatwoot integration

FoyerDesk uses Chatwoot's **Application API** with one integration user, and one **webhook**. It keeps no database of its own. Developed and probed against **Chatwoot 4.20.1**; other versions are untested. The facts the design relies on are in [CHATWOOT_FACTS.md](CHATWOOT_FACTS.md) and are checked by `probes/`.

## Set up one site (one Chatwoot account per site)
1. **Inbox.** Settings, Inboxes, add an **API channel**. Note its numeric id (`FULL_PAGE_INBOX_ID`) and, optionally, its identifier (`CHATWOOT_INBOX_IDENTIFIER`).
2. **Integration user.** Create a user of that account only (administrator, as Chatwoot requires for these calls) and copy its access token (`CHATWOOT_APPLICATION_TOKEN`). Do not reuse one token across accounts.
3. **Webhook.** Settings, Integrations, Webhooks: URL `https://<your-site>/api/support/webhook`, event `message_created` only. Copy the signing secret (`CHATWOOT_WEBHOOK_SECRET`).
4. **Business hours** (optional): decide whether Chatwoot's automatic "we are busy" message should answer new topics.

## How customers map to Chatwoot
| FoyerDesk | Chatwoot |
|---|---|
| Customer | Contact with identifier `<IDENTIFIER_PREFIX><sha256(issuer, subject)>` and the verified email |
| Topic | One conversation in the site's inbox; the subject is `custom_attributes.subject` |
| Customer message | Incoming message; the request id is stored in its `content_attributes` |
| Team reply | Outgoing message |
| Mark as solved / Reopen | `toggle_status` (`resolved` / `open`); writing into a resolved topic reopens it |

Customers see **Open**, **Pending** (also snoozed) and **Resolved**. Activity and private messages are never shown.

## Calls the Worker makes
Contacts: search, create, update, link to the inbox. Conversations: filtered list (`POST /conversations/filter`, paged), create, read messages (`before` / `after`), post message, `toggle_status`. The per-contact conversation list is not used because it stops at 25.

## What FoyerDesk does not do
It does not read or change agents, teams, labels, assignments or automation rules, and it does not create Chatwoot contacts before sign-in. A conversation is created only when the customer sends a first message.

## Known limits
- An existing Chatwoot contact that has the same email but a different identifier is never merged silently: sign-in stops with `explicit_contact_linking_required` and an operator has to resolve it in Chatwoot.
- Attachments are not supported.
- Only Chatwoot 4.20.1 has been probed.
