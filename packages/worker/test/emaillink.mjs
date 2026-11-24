// Acceptance for the built-in email-link sign-in: real Worker code in Miniflare, fake Chatwoot and fake mail service.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const script = await readFile(resolve(process.argv[2] ?? ".build/worker.js"), "utf8");
const site = "https://support-fixture.invalid";
const persistence = await mkdtemp(join(tmpdir(), "emaillink-"));
const contacts = [];
const mails = [];
let mailFails = false;

async function upstream(request) {
  const url = new URL(request.url);
  if (url.hostname === "api.resend.com") {
    assert.equal(request.headers.get("Authorization"), "Bearer re_fixture");
    if (mailFails) return new Response(null, { status: 500 });
    mails.push(await request.json());
    return Response.json({ id: "mail" });
  }
  const path = url.pathname.replace("/api/v1/accounts/1", "");
  if (request.method === "GET" && path === "/contacts/search") {
    const key = url.searchParams.get("q");
    return Response.json({ payload: contacts.filter((row) => row.identifier === key || row.email === key) });
  }
  if (request.method === "POST" && path === "/contacts") { const data = await request.json(); contacts.push({ ...data, id: 100 + contacts.length, contact_inboxes: [] }); return Response.json({}); }
  const put = path.match(/^\/contacts\/(\d+)$/);
  if (request.method === "PUT" && put) { Object.assign(contacts.find((r) => r.id === Number(put[1])), await request.json()); return Response.json({}); }
  const link = path.match(/^\/contacts\/(\d+)\/contact_inboxes$/);
  if (request.method === "POST" && link) { const d = await request.json(); contacts.find((r) => r.id === Number(link[1])).contact_inboxes.push({ inbox: { id: d.inbox_id }, source_id: "src-" + link[1] }); return Response.json({}); }
  throw new Error("Unexpected request " + request.method + " " + url.href);
}

const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: "2026-10-19",
  durableObjects: {
    SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "el-sessions" },
    FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "el-thread" },
    SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "el-stream" },
    EMAIL_LINKS: { className: "EmailLinkStore", useSQLite: true, unsafeUniqueKey: "el-links" },
  },
  isolatedResourcePersistencePath: persistence, resourcePersistencePath: persistence, outboundService: upstream,
  bindings: {
    CHATWOOT_BASE_URL: "https://chat.example.invalid", CHATWOOT_ACCOUNT_ID: "1", IDENTIFIER_PREFIX: "acme-", DEFAULT_CONTACT_NAME: "Customer", CALLBACK_URI: site + "/api/auth/callback", CHATWOOT_APPLICATION_TOKEN: "t", CHATWOOT_WEBHOOK_SECRET: "w",
    FULL_PAGE_INBOX_ID: "4", CHATWOOT_CONTACT_SOURCE_KEY: "k", CHATWOOT_INBOX_IDENTIFIER: "i",
    MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fixture", EMAIL_LINK_FROM: "Support <support@example.invalid>", EMAIL_LINK_BRAND: "Fixture",
  },
}));
const call = (path, options = {}) => worker.dispatchFetch(site + path, { redirect: "manual", ...options });
const start = (email, extra = {}, headers = {}) => call("/api/auth/email/start", { method: "POST", headers: { Origin: site, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ email, ...extra }) });
const tokenOf = (mail) => new URL(mail.text.match(/https:\S+/)[0]).searchParams.get("token");
const verify = (token, origin = site) => call("/api/auth/email/verify", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "token=" + encodeURIComponent(token) });
const checks = [];
const ok = (name) => checks.push(name);

try {
  assert.equal((await start("not-an-email")).status, 400); ok("invalid address refused");
  assert.equal((await call("/api/auth/email/start", { method: "POST", headers: { Origin: "https://evil.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) })).status, 403); ok("foreign origin refused");

  const sent = await start("Alex@Example.COM", { returnTo: "/support", src: "linkedin" });
  assert.equal(sent.status, 202);
  assert.equal(mails.length, 1); assert.deepEqual(mails[0].to, ["alex@example.com"]); assert.match(mails[0].subject, /Fixture/);
  const token = tokenOf(mails[0]); ok("link mailed to the normalised address");

  const page = await call("/api/auth/email/verify?token=" + token);
  assert.equal(page.status, 200); assert.match(await page.text(), /method="post"/);
  const again = await call("/api/auth/email/verify?token=" + token);
  assert.equal(again.status, 200); ok("opening the link only shows a button and does not use the token");

  assert.equal((await verify(token, "https://evil.invalid")).status, 403); ok("confirm from a foreign origin refused");
  const done = await verify(token);
  assert.equal(done.status, 303); assert.equal(done.headers.get("Location"), "/support");
  const cookie = done.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
  assert.equal(contacts.length, 1); assert.equal(contacts[0].email, "alex@example.com");
  assert.equal(contacts[0].contact_inboxes.length, 1); ok("confirming signs in, creates the contact and returns to /support");

  const who = await call("/api/support/session", { headers: { Cookie: cookie } });
  assert.equal(who.status, 200);
  const account = (await who.json()).account;
  assert.equal(account.email, "alex@example.com"); assert.equal(account.provider, "email"); ok("session shows email as the way of signing in");

  assert.equal((await verify(token)).status, 410); ok("a used link cannot be used again");
  assert.equal((await verify("A".repeat(43))).status, 410); assert.equal((await verify("short")).status, 400); ok("unknown and malformed tokens refused");

  // The same person signing in again gets the same contact.
  await start("alex@example.com"); await verify(tokenOf(mails[1]));
  assert.equal(contacts.length, 1); ok("second sign-in reuses the contact");

  // Rate limits: 3 links per address per 10 minutes (two used so far for this address).
  assert.equal((await start("alex@example.com")).status, 202);
  assert.equal((await start("alex@example.com")).status, 429); ok("fourth link for one address is refused");

  // Mail service down: the person is told, no link is claimed as sent.
  mailFails = true;
  assert.equal((await start("down@example.com")).status, 502); mailFails = false; ok("mail outage reported as 502");

  // Disabled when the store is not bound is covered by the route returning 404; here the feature is on.
  console.log(checks.map((c) => "PASS " + c).join("\n"));
} finally { await worker.dispose(); }
