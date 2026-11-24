// Runs the built Worker in Miniflare against the REAL Chatwoot (account 1, inbox 5) with a fake sign-in provider.
// It creates one temporary contact (name starts with "PROBE") and deletes it, with all its conversations, at the end.
// Usage: node live-topics.mjs /tmp/foyerdesk-worker-acceptance/worker.js
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
const need = (name) => process.env[name] ?? (() => { throw new Error("Set " + name + " (see docs/SETUP_NEW_SITE.md, live tests)"); })();

const script = await readFile(resolve(process.argv[2] ?? "/tmp/foyerdesk-worker-acceptance/worker.js"), "utf8");
const token = (await readFile(need("FOYERDESK_CHATWOOT_TOKEN_FILE"), "utf8")).trim();
const site = "https://support-fixture.invalid", issuer = "https://issuer-fixture.invalid/oidc", clientId = "probe-client";
const { publicKey, privateKey } = await generateKeyPair("ES384");
const jwk = { ...await exportJWK(publicKey), alg: "ES384", use: "sig", kid: "probe" };
const persistence = await mkdtemp(join(tmpdir(), "foyer-live-"));
const subject = "probe-" + randomUUID();
let nonce;
const seen = [];

const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: "2026-10-19",
  durableObjects: {
    SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "live-sessions" },
    FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "live-thread" },
    SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "live-stream" },
  },
  isolatedResourcePersistencePath: persistence, resourcePersistencePath: persistence,
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.origin === new URL(issuer).origin) {
      if (url.pathname.endsWith("/token")) {
        const jwt = await new SignJWT({ nonce }).setIssuer(issuer).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime("5m")
          .setProtectedHeader({ alg: "ES384", kid: "probe" }).sign(privateKey);
        return Response.json({ id_token: jwt, access_token: "synthetic" });
      }
      if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.pathname.endsWith("/me")) return Response.json({ sub: subject, email: `${subject}@example.invalid`, email_verified: true, name: "PROBE Foyerdesk topics (temporary)" });
    }
    assert.equal(url.origin, new URL(need("FOYERDESK_CHATWOOT_URL")).origin, "unexpected outbound " + url);
    seen.push(request.method + " " + url.pathname.replace("/api/v1/accounts/1", ""));
    const headers = new Headers(request.headers); headers.set("api_access_token", token); headers.set("User-Agent", "curl/8.5.0");
    return fetch(url, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  },
  bindings: { LOGTO_ISSUER: issuer, LOGTO_CLIENT_ID: clientId, LOGTO_CLIENT_SECRET: "synthetic", CHATWOOT_BASE_URL: need("FOYERDESK_CHATWOOT_URL"), CHATWOOT_ACCOUNT_ID: need("FOYERDESK_CHATWOOT_ACCOUNT"), IDENTIFIER_PREFIX: "probe-", DEFAULT_CONTACT_NAME: "Customer", CALLBACK_URI: site + "/api/auth/callback",
    CHATWOOT_APPLICATION_TOKEN: token, FULL_PAGE_INBOX_ID: "5", CHATWOOT_CONTACT_SOURCE_KEY: "probe-key-" + subject, CHATWOOT_WEBHOOK_SECRET: "x" },
}));
const call = (path, init = {}) => worker.dispatchFetch(site + path, { redirect: "manual", ...init });
const results = [];
const ok = (name) => { results.push(name); console.log("PASS", name); };
let contactId;
try {
  const start = await call("/api/auth/login");
  const params = new URL(start.headers.get("Location")).searchParams;
  nonce = params.get("nonce");
  const back = await call("/api/auth/callback?code=x&state=" + encodeURIComponent(params.get("state")), { headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] } });
  assert.equal(back.status, 303, await back.clone().text());
  const cookie = back.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
  const api = (path, init = {}) => call("/api/support/topics" + path, { ...init, headers: { Cookie: cookie, Origin: site, "Content-Type": "application/json" } });
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

  const empty = await j(await api("?tab=open"));
  assert.deepEqual([empty.status, empty.body.topics.length], [200, 0]); ok("signed in with a fake provider; real Chatwoot contact created; empty list through the real filter endpoint");
  const r1 = randomUUID(), r2 = randomUUID();
  const a = await j(await post("", { requestId: r1, subject: "PROBE billing", message: "PROBE first topic" })), b = await j(await post("", { requestId: r2, message: "PROBE second topic about certificates" }));
  assert.deepEqual([a.status, b.status], [201, 201]); ok("two topics created in the real inbox 5");
  assert.equal((await j(await post("", { requestId: r1, subject: "PROBE billing", message: "PROBE first topic" }))).body.id, a.body.id); ok("repeat of the same request id returned the same conversation (no duplicate)");
  const list = (await j(await api("?tab=open"))).body;
  assert.deepEqual([list.total, list.topics.map((t) => t.subject).sort()], [2, ["PROBE billing", "PROBE second topic about certificates"]]); ok("real list: 2 open topics, subject stored and read back");
  const m = (await j(await api(`/${a.body.id}/messages`))).body;
  assert.ok(m.messages.some((x) => x.text === "PROBE first topic" && x.direction === "visitor")); assert.deepEqual(m.topic.actions, ["reply", "resolve"]); ok("topic messages come back with status and allowed actions");
  assert.equal((await post(`/${a.body.id}/messages`, { requestId: randomUUID(), message: "PROBE follow-up" })).status, 200); ok("reply written to the real conversation");
  // A conversation that really exists and belongs to somebody else: the service token can read it, the Worker must not.
  const cw = (path) => fetch(`${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}${path}`, { headers: { api_access_token: token, "User-Agent": "curl/8.5.0" } });
  const all = await (await cw("/conversations?status=all")).json();
  const others = (all.data?.payload ?? []).filter((c) => c.inbox_id === 5 && ![a.body.id, b.body.id].includes(c.id));
  assert.ok(others.length > 0, "no foreign conversation exists in inbox 5: the isolation check cannot be proved right now");
  const foreignId = others[0].id;
  assert.equal((await cw(`/conversations/${foreignId}`)).status, 200); // the token can read it
  const foreign = await j(await api(`/${foreignId}/messages`));
  assert.deepEqual([foreign.status, foreign.body.error], [404, "topic_not_found"]);
  assert.equal((await post(`/${foreignId}/resolve`, {})).status, 404);
  assert.equal((await post(`/${foreignId}/messages`, { requestId: randomUUID(), message: "PROBE must not be written" })).status, 404);
  assert.equal((await (await cw(`/conversations/${foreignId}`)).json()).status, others[0].status); ok(`a real conversation of ANOTHER contact (id ${foreignId}) is readable with the token but the Worker answers 404 for read, write and close, and its status is unchanged`);
  const closed = await j(await post(`/${a.body.id}/resolve`, {})); assert.equal(closed.body.status, "Resolved");
  assert.equal((await j(await api("?tab=resolved"))).body.topics.length, 1); assert.equal((await j(await api("?tab=open"))).body.total, 1); ok("closing moves the topic to the Resolved tab in real Chatwoot");
  const back2 = await j(await post(`/${a.body.id}/reopen`, {})); assert.equal(back2.body.status, "Open"); ok("reopen works in real Chatwoot");
  await post(`/${a.body.id}/resolve`, {});
  assert.equal((await post(`/${a.body.id}/messages`, { requestId: randomUUID(), message: "PROBE write into a closed topic" })).status, 200);
  assert.equal((await j(await api(`/${a.body.id}/messages`))).body.topic.status, "Open"); ok("writing into a closed topic reopens it in real Chatwoot");
  const msgs = (await j(await api(`/${a.body.id}/messages`))).body.messages;
  assert.ok(msgs.length >= 3 && msgs.every((x) => !/resolved|reopened|marked|assigned/i.test(x.text.replace(/^PROBE.*/i, "")))); ok("messages carry no system activity text for the customer: " + msgs.map((x) => x.text).join(" | ").slice(0, 120));
  // find the contact to delete it
  const found = await fetch(`${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}/contacts/search?q=${subject}`, { headers: { api_access_token: token, "User-Agent": "curl/8.5.0" } }).then((r) => r.json());
  contactId = found.payload?.[0]?.id;
} finally {
  if (contactId) {
    const del = await fetch(`${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}/contacts/${contactId}`, { method: "DELETE", headers: { api_access_token: token, "User-Agent": "curl/8.5.0" } });
    const gone = await fetch(`${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}/contacts/${contactId}`, { headers: { api_access_token: token, "User-Agent": "curl/8.5.0" } });
    console.log(`cleanup: contact ${contactId} delete=${del.status} afterwards=${gone.status}`);
  } else console.log("cleanup: no temporary contact found (search by identifier is eventually consistent; check Contacts for names starting with PROBE)");
  await worker.dispose(); await rm(persistence, { recursive: true, force: true });
}
console.log(`\n${results.length} live checks passed`);
