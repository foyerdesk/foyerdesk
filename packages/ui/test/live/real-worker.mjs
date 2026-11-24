// Browser against the REAL Worker bundle (Miniflare) and the REAL Chatwoot. A fake sign-in provider logs in one temporary contact
// ("PROBE ..."), deleted at the end. A local proxy serves the screens and forwards /api/* to the Worker (the live socket is refused,
// so the screens use their fallback checks). Usage: node test/live/real-worker.mjs ../worker/.build/worker.js
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { chromium } from "@playwright/test";
const need = (name) => process.env[name] ?? (() => { throw new Error("Set " + name + " (see docs/SETUP_NEW_SITE.md, live tests)"); })();

const script = await readFile(resolve(process.argv[2] ?? "../worker/.build/worker.js"), "utf8");
const token = (await readFile(need("FOYERDESK_CHATWOOT_TOKEN_FILE"), "utf8")).trim();
const CW = `${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}`;
const cw = async (path, init = {}) => { const r = await fetch(CW + path, { ...init, headers: { api_access_token: token, "Content-Type": "application/json", "User-Agent": "curl/8.5.0" }, body: init.body ? JSON.stringify(init.body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const site = "https://support-fixture.invalid", issuer = "https://issuer-fixture.invalid/oidc", clientId = "probe-client";
const { publicKey, privateKey } = await generateKeyPair("ES384");
const jwk = { ...await exportJWK(publicKey), alg: "ES384", use: "sig", kid: "probe" };
const persistence = await mkdtemp(join(tmpdir(), "foyer-real-"));
const subject = "probe-" + randomUUID();
let nonce;
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: "2026-10-19",
  durableObjects: {
    SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "r-sessions" },
    FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "r-thread" },
    SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "r-stream" },
  },
  isolatedResourcePersistencePath: persistence, resourcePersistencePath: persistence,
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.origin === new URL(issuer).origin) {
      if (url.pathname.endsWith("/token")) return Response.json({ id_token: await new SignJWT({ nonce }).setIssuer(issuer).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "ES384", kid: "probe" }).sign(privateKey), access_token: "x" });
      if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.pathname.endsWith("/me")) return Response.json({ sub: subject, email: `${subject}@example.invalid`, email_verified: true, name: "PROBE Real Worker (temporary)" });
    }
    const headers = new Headers(request.headers); headers.set("api_access_token", token); headers.set("User-Agent", "curl/8.5.0");
    return fetch(url, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  },
  bindings: { LOGTO_ISSUER: issuer, LOGTO_CLIENT_ID: clientId, LOGTO_CLIENT_SECRET: "x", CHATWOOT_BASE_URL: need("FOYERDESK_CHATWOOT_URL"), CHATWOOT_ACCOUNT_ID: need("FOYERDESK_CHATWOOT_ACCOUNT"), IDENTIFIER_PREFIX: "probe-", DEFAULT_CONTACT_NAME: "Customer", CALLBACK_URI: site + "/api/auth/callback", CHATWOOT_APPLICATION_TOKEN: token,
    FULL_PAGE_INBOX_ID: "5", CHATWOOT_CONTACT_SOURCE_KEY: "probe-key-" + subject, CHATWOOT_WEBHOOK_SECRET: "x" },
}));
const start = await worker.dispatchFetch(site + "/api/auth/login", { redirect: "manual" });
nonce = new URL(start.headers.get("Location")).searchParams.get("nonce");
const back = await worker.dispatchFetch(site + "/api/auth/callback?code=x&state=" + encodeURIComponent(new URL(start.headers.get("Location")).searchParams.get("state")), { redirect: "manual", headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] } });
assert.equal(back.status, 303);
let cookie = back.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];

const root = fileURLToPath(new URL("../..", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const log = [];
const proxy = createServer(async (req, res) => {
  try { await handle(req, res); } catch { try { res.writeHead(502).end(); } catch { /* connection already gone (test is shutting down) */ } }
});
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (req.headers.upgrade) { res.writeHead(426).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = await worker.dispatchFetch(site + url.pathname + url.search, { method: req.method, redirect: "manual", body: body.length ? body : undefined,
      headers: { Cookie: cookie, Origin: site, ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}) } });
    log.push(`${req.method} ${url.pathname}${url.search} -> ${r.status}`);
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "text/plain" }).end(out);
    return;
  }
  const file = url.pathname === "/" || url.pathname === "/support" ? join(root, "test/harness/index.html") : normalize(join(root, url.pathname));
  try { const b = await readFile(file); res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(b); } catch { res.writeHead(404).end(); }
}
proxy.listen(4178, "127.0.0.1");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push("pageerror: " + e.message)); page.on("console", (m) => { if (m.type() === "error" && !/426|WebSocket/.test(m.text())) errors.push("console: " + m.text()); });
const say = (s) => console.log(s);
const rows = async () => (await page.getByTestId("topic-row").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
const recents = async () => (await page.getByTestId("recent-item").allTextContents()).map((t) => t.trim());
let contactId;
try {
  await page.goto("http://127.0.0.1:4178/support");
  await page.getByTestId("account-card").waitFor();
  say("signed in: " + (await page.getByTestId("account-card").innerText()).replace(/\n/g, " | "));
  // two topics
  await page.getByTestId("new-topic").click();
  await page.getByLabel("Subject (optional)").fill("PROBE Billing");
  await page.getByLabel("Your question").fill("PROBE I was charged twice");
  await page.getByTestId("create").click();
  try { await page.getByTestId("topic-title").waitFor({ timeout: 8000 }); } catch (error) {
    if (process.env.SHOTS) { await page.screenshot({ path: process.env.SHOTS + "/real-create-fail.png" }); console.log("URL " + page.url() + "\n" + log.slice(-8).join("\n")); }
    throw error;
  }
  const idA = Number(page.url().split("/").pop());
  say(`topic A created, url ${page.url()}`);
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/real-before-back.png" });
  await page.getByRole("link", { name: "Back" }).click();
  await page.getByTestId("new-topic").click();
  await page.getByLabel("Your question").fill("PROBE How do I get my certificate?");
  await page.getByTestId("create").click();
  await page.getByTestId("topic-title").waitFor();
  const idB = Number(page.url().split("/").pop());
  say(`topic B created (subject from first line): "${await page.getByTestId("topic-title").innerText()}"`);
  // reload keeps the messages
  await page.reload(); await page.getByTestId("message").first().waitFor();
  say(`after reload topic B shows ${await page.getByTestId("message").count()} message(s)`);
  // operator reply from Chatwoot (real), then a check
  const rep = await cw(`/conversations/${idA}/messages`, { method: "POST", body: { content: "PROBE reply from the team", message_type: "outgoing", private: false } });
  say(`operator reply posted to A: ${rep.status}`);
  // close A
  await page.goto(`http://127.0.0.1:4178/support#/topic/${idA}`); await page.reload();
  await page.getByTestId("message").first().waitFor();
  say(`topic A messages: ${(await page.getByTestId("message").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim()).join(" || ")}`);
  await page.getByTestId("resolve").click();
  await page.getByTestId("reopen").waitFor();
  say("A resolved, badge: " + await page.getByTestId("topic-status").innerText());
  assert.equal(await page.getByTestId("topic-status").innerText(), "Resolved");
  await page.getByRole("link", { name: "Back" }).click();
  await page.getByTestId("tab-all").waitFor(); await page.waitForTimeout(700);
  const all = await rows();
  say("ALL (history) rows after resolving A: " + JSON.stringify(all));
  assert.equal(all.length, 2, "both topics stay in the history");
  assert.ok(all.some((r) => /PROBE Billing/.test(r) && /Resolved/.test(r)), "the closed topic is still listed, marked Resolved");
  assert.ok(!all.some((r) => /rate the conversation/i.test(r)), "the rating request is not shown as a preview");
  const side = await recents();
  say("sidebar recent topics: " + JSON.stringify(side));
  assert.ok(side.some((r) => /PROBE Billing/.test(r) && /Resolved/.test(r)), "the closed topic is still in the side panel");
  await page.getByTestId("tab-open").click(); await page.waitForTimeout(500);
  assert.equal((await rows()).length, 1); say("OPEN tab: " + JSON.stringify(await rows()));
  await page.getByTestId("tab-resolved").click(); await page.waitForTimeout(500);
  assert.equal((await rows()).length, 1); say("RESOLVED tab: " + JSON.stringify(await rows()));
  // open the closed topic again: every message is still there, no rating request
  await page.getByTestId("topic-row").getByRole("link").click();
  await page.getByTestId("message").first().waitFor();
  const texts = (await page.getByTestId("message").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  say("closed topic A messages: " + texts.join(" || "));
  assert.ok(texts.some((t) => /charged twice/.test(t)) && texts.some((t) => /reply from the team/.test(t)), "the whole conversation is kept");
  assert.ok(!texts.some((t) => /rate the conversation/i.test(t)), "no rating request in the thread");
  // writing into the closed topic brings it back
  await page.getByLabel("Reply", { exact: true }).fill("PROBE one more thing");
  await page.getByTestId("send").click();
  for (let i = 0; i < 40 && (await page.getByTestId("topic-status").innerText()) !== "Open"; i++) await page.waitForTimeout(250); // Chatwoot reopens asynchronously
  assert.equal(await page.getByTestId("topic-status").innerText(), "Open"); say("write into closed topic -> status " + await page.getByTestId("topic-status").innerText());
  // sign out from inside a topic, on a wide and on a narrow window
  for (const width of [1366, 800]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto(`http://127.0.0.1:4178/support#/topic/${idB}`); await page.reload();
    await page.getByTestId("message").first().waitFor();
    assert.ok(await page.getByTestId("sign-out").isVisible(), `Sign out is visible inside a topic at ${width}px`);
    const box = await page.getByTestId("send").boundingBox(); assert.ok(box.y + box.height <= 768, `composer on screen at ${width}px`);
    await page.getByTestId("sign-out").click(); await page.waitForTimeout(1200);
    assert.equal(await page.getByTestId("sign-in-panel").count(), 1, "guest panel");
    assert.equal(new URL(page.url()).hash, "", "address cleaned");
    assert.match(await page.getByTestId("guest-title").innerText(), /You have signed out/);
    say(`sign out inside a topic at ${width}px: guest panel, url ${page.url()}, notice ok`);
    if (width === 1366) { // sign back in for the narrow run: the proxy still sends the old cookie, so log in again
      const st = await worker.dispatchFetch(site + "/api/auth/login", { redirect: "manual" });
      nonce = new URL(st.headers.get("Location")).searchParams.get("nonce");
      const bk = await worker.dispatchFetch(site + "/api/auth/callback?code=x&state=" + encodeURIComponent(new URL(st.headers.get("Location")).searchParams.get("state")), { redirect: "manual", headers: { Cookie: st.headers.get("Set-Cookie").split(";")[0] } });
      cookie = bk.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
    }
  }
  say("API log tail:\n  " + log.slice(-6).join("\n  "));
  assert.deepEqual(errors, [], "no browser errors");
  say("ALL REAL-WORKER CHECKS PASSED");
  const found = await cw(`/contacts/search?q=${subject}`); contactId = found.data?.payload?.[0]?.id;
} finally {
  if (contactId) { const del = await cw(`/contacts/${contactId}`, { method: "DELETE" }); say(`cleanup: contact ${contactId} delete=${del.status} afterwards=${(await cw(`/contacts/${contactId}`)).status}`); }
  else say("cleanup: no contact found by search, check Contacts for names starting with PROBE");
  await browser.close(); proxy.close(); await worker.dispose(); await rm(persistence, { recursive: true, force: true });
}
