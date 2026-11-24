# Security

Report problems privately through GitHub's "Report a vulnerability" button on the Security tab of this repository, not in public issues. Foyerdesk handles customer conversations: never
paste tokens, cookies or customer messages into reports.

Design rules the tests enforce: the Chatwoot service token never reaches the browser; every topic call checks that the topic belongs to
the signed-in contact and the site's inbox (another customer's topic answers 404 exactly like a missing one); writes need a same-origin
request; webhooks need a valid HMAC signature and a fresh timestamp; the live socket carries no message text.
