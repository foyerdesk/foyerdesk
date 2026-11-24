# Facts about Chatwoot 4.20.1 that Foyerdesk relies on

Proved by `probes/probe_chatwoot.py` and `probes/probe_list_limit.py` against a live installation (temporary contact, deleted at the end), and by source.

- One contact holds several conversations in one inbox; the subject is kept in `custom_attributes.subject`.
- Close and reopen: `POST /conversations/{id}/toggle_status` (`resolved`, `open`). A message written into a resolved conversation is accepted and reopens it.
- Statuses: open, pending, snoozed, resolved. The customer sees Open, Pending (snoozed too) and Resolved.
- The service token reads every conversation of the account: ownership must be checked by Foyerdesk (conversation `meta.sender.id` and `inbox_id`).
- `GET /contacts/{id}/conversations` returns at most 25, no paging. `POST /conversations/filter?page=N` with `contact_id`, `inbox_id`, `status` pages properly (25 a page, `meta.all_count`), newest activity first. The last condition must have `query_operator: null`.
- `GET /conversations/{id}/messages` returns the latest 20; `?before=<id>` the 20 before; `?after=<id>` up to 100 after.
- Status changes are stored as activity messages (type 2); they must not be shown to the customer.
- Webhook signature: header `X-Chatwoot-Signature: sha256=` + HMAC-SHA256(secret, `<X-Chatwoot-Timestamp>.<raw body>`).
