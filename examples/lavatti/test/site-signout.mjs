// The real site build (dist of the old Vite site, React around the module) + real Worker bundle + real Chatwoot, one PROBE contact.
// Question: after Sign out, does the visitor see "You have signed out"? Usage: SITE_DIST=<path to site dist> node test/live/site-signout.mjs <worker.js>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { chromium } from "@playwright/test";
const need = (name) => process.env[name] ?? (() => { throw new Error("Set " + name + " (see docs/SETUP_NEW_SITE.md, live tests)"); })();

const dist = resolve(process.env.SITE_DIST);
const script = await readFile(resolve(process.argv[2]), "utf8");
const token = (await readFile(need("FOYERDESK_CHATWOOT_TOKEN_FILE"), "utf8")).trim();
const CW = `${need("FOYERDESK_CHATWOOT_URL")}/api/v1/accounts/${need("FOYERDESK_CHATWOOT_ACCOUNT")}`;
const cw = async (path, init = {}) => { const r = await fetch(CW + path, { ...init, headers: { api_access_token: token, "Content-Type": "application/json", "User-Agent": "curl/8.5.0" } }); return { status: r.status, data: await r.json().catch(() => null) }; };
const site = "https://support-fixture.invalid", issuer = "https://issuer-fixture.invalid/oidc", clientId = "probe-client";
const { publicKey, privateKey } = await generateKeyPair("ES384");
const jwk = { ...await exportJWK(publicKey), alg: "ES384", use: "sig", kid: "probe" };
const persistence = await mkdtemp(join(tmpdir(), "foyer-site-"));
const subject = "probe-" + randomUUID();
let nonce;
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: "2026-10-19",
  durableObjects: { SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "s-sessions" }, FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "s-thread" }, SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "s-stream" } },
  isolatedResourcePersistencePath: persistence, resourcePersistencePath: persistence,
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.origin === new URL(issuer).origin) {
      if (url.pathname.endsWith("/token")) return Response.json({ id_token: await new SignJWT({ nonce }).setIssuer(issuer).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "ES384", kid: "probe" }).sign(privateKey), access_token: "x" });
      if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.pathname.endsWith("/me")) return Response.json({ sub: subject, email: `${subject}@example.invalid`, email_verified: true, name: "PROBE Site Signout (temporary)" });
    }
    const headers = new Headers(request.headers); headers.set("api_access_token", token); headers.set("User-Agent", "curl/8.5.0");
    return fetch(url, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  },
  bindings: { LOGTO_ISSUER: issuer, LOGTO_CLIENT_ID: clientId, LOGTO_CLIENT_SECRET: "x", CHATWOOT_BASE_URL: need("FOYERDESK_CHATWOOT_URL"), CHATWOOT_ACCOUNT_ID: need("FOYERDESK_CHATWOOT_ACCOUNT"), IDENTIFIER_PREFIX: "probe-", DEFAULT_CONTACT_NAME: "Customer", CALLBACK_URI: site + "/api/auth/callback", CHATWOOT_APPLICATION_TOKEN: token, FULL_PAGE_INBOX_ID: "5", CHATWOOT_CONTACT_SOURCE_KEY: "probe-key-" + subject, CHATWOOT_WEBHOOK_SECRET: "x" },
}));
async function login() {
  const st = await worker.dispatchFetch(site + "/api/auth/login", { redirect: "manual" });
  const params = new URL(st.headers.get("Location")).searchParams; nonce = params.get("nonce");
  const bk = await worker.dispatchFetch(site + "/api/auth/callback?code=x&state=" + encodeURIComponent(params.get("state")), { redirect: "manual", headers: { Cookie: st.headers.get("Set-Cookie").split(";")[0] } });
  return bk.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
}
let cookie = await login();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const log = [];
const proxy = createServer(async (req, res) => { try { await handle(req, res); } catch { try { res.writeHead(502).end(); } catch {} } });
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (req.headers.upgrade) { res.writeHead(426).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const r = await worker.dispatchFetch(site + url.pathname + url.search, { method: req.method, redirect: "manual", body: body.length ? body : undefined, headers: { Cookie: cookie, Origin: site, ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}) } });
    log.push(`${req.method} ${url.pathname} -> ${r.status}`);
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "text/plain" }).end(Buffer.from(await r.arrayBuffer())); return;
  }
  let file = normalize(join(dist, url.pathname));
  try { if (!(await stat(file)).isFile()) throw 0; } catch { file = join(dist, url.pathname === "/" ? "index.html" : url.pathname.replace(/\/$/, "") + ".html"); try { await stat(file); } catch { file = join(dist, "404.html"); } }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(await readFile(file));
}
proxy.listen(4179, "127.0.0.1");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark" });
await ctx.addInitScript(() => { localStorage.setItem("lavatti-ui-theme", "dark"); });
const page = await ctx.newPage();
const seen = []; // every notice text the page ever shows
await page.exposeFunction("__note", (t) => seen.push(t));
await page.addInitScript(() => { new MutationObserver(() => { const n = document.querySelector('[data-testid="guest-title"]'); if (n && n.textContent) window.__note(n.textContent); }).observe(document, { childList: true, subtree: true, characterData: true }); });
let contactId;
try {
  await page.goto("http://127.0.0.1:4179/support#/topic/1", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /reject/i }).click({ timeout: 2000 }).catch(() => {});
  await page.getByTestId("account-card").waitFor();
  console.log("signed in on the real site build");
  await page.getByTestId("sign-out").click();
  await page.waitForTimeout(2500);
  console.log("notices shown, in order:", JSON.stringify([...new Set(seen)]));
  console.log("final title:", await page.getByTestId("guest-title").innerText(), "| body:", await page.getByTestId("guest-notice").innerText());
  console.log("url:", page.url()); if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  console.log("API tail:", log.slice(-5).join(" | "));
  const found = await cw(`/contacts/search?q=${subject}`); contactId = found.data?.payload?.[0]?.id;
} finally {
  if (contactId) { const del = await cw(`/contacts/${contactId}`, { method: "DELETE" }); console.log(`cleanup: contact ${contactId} delete=${del.status} afterwards=${(await cw(`/contacts/${contactId}`)).status}`); }
  await browser.close(); proxy.close(); await worker.dispose(); await rm(persistence, { recursive: true, force: true });
}
