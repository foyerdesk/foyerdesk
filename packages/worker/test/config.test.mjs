import assert from "node:assert/strict";
import test from "node:test";
import { configureChatwoot, participantIdentifier } from "../src/contact.mjs";

test("no Chatwoot address or account is assumed: both must be set", () => {
  assert.throws(() => configureChatwoot({}), /invalid_chatwoot_settings/);
  assert.throws(() => configureChatwoot({ CHATWOOT_BASE_URL: "https://chat.example.com" }), /invalid_chatwoot_settings/);
  assert.throws(() => configureChatwoot({ CHATWOOT_ACCOUNT_ID: "1" }), /invalid_chatwoot_settings/);
  assert.throws(() => configureChatwoot({ CHATWOOT_BASE_URL: "http://chat.example.com", CHATWOOT_ACCOUNT_ID: "1" }), /invalid_chatwoot_settings/);
});

test("the contact identifier starts with foyerdesk- unless the site sets its own prefix", async () => {
  configureChatwoot({ CHATWOOT_BASE_URL: "https://chat.example.com", CHATWOOT_ACCOUNT_ID: "7" });
  assert.match(await participantIdentifier("https://idp.example", "u1"), /^foyerdesk-[0-9a-f]{64}$/);
  configureChatwoot({ CHATWOOT_BASE_URL: "https://chat.example.com", CHATWOOT_ACCOUNT_ID: "7", IDENTIFIER_PREFIX: "acme-" });
  assert.match(await participantIdentifier("https://idp.example", "u1"), /^acme-[0-9a-f]{64}$/);
});
