// Sign-in must refuse everything that is not a correct answer from the provider. Each case changes ONE thing in an
// otherwise valid sign-in; the control case proves the valid one still works, so a refusal is for the stated reason.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const script = await readFile(resolve(process.argv[2] ?? ".build/worker.js"), "utf8");
const site = "https://support-fixture.invalid";
const issuer = "https://issuer-fixture.invalid/oidc";
const clientId = "test-client";
const owner = "fixture-owner";
const identifier = "acme-" + createHash("sha256").update(JSON.stringify([issuer, owner])).digest("hex");
const good = await generateKeyPair("ES384");
const other = await generateKeyPair("ES384");
const jwk = { ...await exportJWK(good.publicKey), alg: "ES384", use: "sig", kid: "fixture" };

let nonce, challenge, verifierSeen, challengeMatched;
let tweak = {}; // what the fixture provider does wrong this time
const secret = "synthetic-secret-value";

async function idToken() {
  const claims = { ...(tweak.noNonce ? {} : { nonce: tweak.nonce ?? nonce }) };
  const jwt = new SignJWT(claims).setIssuer(tweak.iss ?? issuer).setAudience(tweak.aud ?? clientId).setSubject(owner)
    .setIssuedAt().setExpirationTime(tweak.expired ? Math.floor(Date.now() / 1000) - 600 : "5m");
  if (tweak.alg === "none") {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${enc({ alg: "none", typ: "JWT" })}.${enc({ iss: issuer, aud: clientId, sub: owner, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })}.`;
  }
  if (tweak.alg === "HS256") return jwt.setProtectedHeader({ alg: "HS256", kid: "fixture" }).sign(new TextEncoder().encode("anything-at-all-anything-at-all-32"));
  return jwt.setProtectedHeader({ alg: "ES384", kid: "fixture" }).sign(tweak.foreignKey ? other.privateKey : good.privateKey);
}

async function upstream(request) {
  const url = new URL(request.url);
  if (url.origin !== new URL(issuer).origin) { // a minimal Chatwoot: one conversation that accepts every message
    const path = url.pathname.replace("/api/v1/accounts/1", "");
    if (request.method === "GET" && path === "/contacts/8/conversations") return Response.json({ payload: [{ id: 44, inbox_id: 4 }] });
    if (request.method === "GET" && path === "/conversations/44/messages") return Response.json({ payload: [] });
    if (request.method === "POST" && path === "/conversations/44/messages") return Response.json({ id: 1 });
    return new Response(null, { status: 503 });
  }
  if (url.pathname.endsWith("/token")) {
    const form = new URLSearchParams(await request.text());
    verifierSeen = form.get("code_verifier");
    challengeMatched = createHash("sha256").update(verifierSeen ?? "").digest("base64url") === challenge;
    if (tweak.tokenRefused) return new Response("{}", { status: 400 });
    return Response.json({ id_token: await idToken(), access_token: "synthetic-access" });
  }
  if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [jwk] });
  if (url.pathname.endsWith("/me")) {
    if (tweak.userinfoRefused) return new Response("{}", { status: 401 });
    return Response.json({ sub: tweak.userinfoSub ?? owner, ...(tweak.noEmail ? {} : { email: owner + "@example.invalid" }), email_verified: tweak.emailVerified ?? true });
  }
  throw new Error("unexpected call " + url);
}

const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: "2026-10-19",
  durableObjects: {
    SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "neg-sessions" },
    FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "neg-thread" },
    SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "neg-stream" },
  },
  outboundService: upstream,
  bindings: {
    LOGTO_ISSUER: issuer, LOGTO_CLIENT_ID: clientId, LOGTO_CLIENT_SECRET: secret,
    CHATWOOT_BASE_URL: "https://chat.example.invalid", CHATWOOT_ACCOUNT_ID: "1", IDENTIFIER_PREFIX: "acme-", DEFAULT_CONTACT_NAME: "Customer",
    RETURN_PATHS: "/support", CALLBACK_URI: site + "/api/auth/callback", CHATWOOT_APPLICATION_TOKEN: "synthetic-chatwoot-token", CHATWOOT_WEBHOOK_SECRET: "w",
    FULL_PAGE_TEST_IDENTIFIER: identifier, FULL_PAGE_SOURCE_ID: "synthetic-source",
  },
}));
const call = (path, options = {}) => worker.dispatchFetch(site + path, { redirect: "manual", ...options });

async function start() {
  const response = await call("/api/auth/login");
  assert.equal(response.status, 302);
  const params = new URL(response.headers.get("Location")).searchParams;
  nonce = params.get("nonce"); challenge = params.get("code_challenge");
  assert.equal(params.get("code_challenge_method"), "S256");
  return { state: params.get("state"), cookie: response.headers.get("Set-Cookie").split(";")[0], raw: response.headers.get("Set-Cookie") };
}
async function attempt({ tweakWith = {}, query, cookie, mutateCookie } = {}) {
  tweak = tweakWith;
  const began = await start();
  let jar = cookie ?? began.cookie;
  if (mutateCookie) { const value = JSON.parse(decodeURIComponent(jar.split("=").slice(1).join("="))); mutateCookie(value); jar = "__Host-foyerdesk-oidc=" + encodeURIComponent(JSON.stringify(value)); }
  const url = "/api/auth/callback?" + (query ?? "code=synthetic&state=" + encodeURIComponent(began.state));
  return call(url, { headers: { Cookie: jar } });
}
const errorOf = (response) => {
  assert.equal(response.status, 303, "a failed sign-in redirects to the page");
  const location = new URL(response.headers.get("Location"), site);
  assert.equal(location.pathname, "/support");
  assert.equal(response.headers.getSetCookie().some((c) => c.startsWith("__Host-foyerdesk-session=") && !c.includes("Max-Age=0")), false, "no session on failure");
  return location.searchParams.get("auth_error");
};
const results = [];
const check = async (name, fn) => { await fn(); results.push(name); };

try {
  await check("control: a correct sign-in succeeds and the PKCE challenge is the S256 of the verifier that was sent", async () => {
    const response = await attempt();
    assert.equal(response.status, 303, await response.clone().text());
    assert.equal(response.headers.get("Location"), "/"); // no returnTo asked for
    assert.ok(response.headers.getSetCookie().some((c) => c.startsWith("__Host-foyerdesk-session=")));
    assert.ok(verifierSeen && verifierSeen.length >= 43);
    assert.equal(challengeMatched, true);
  });
  const refused = {
    "a different nonce in the token": [{ tweakWith: { nonce: "someone-elses" } }, "invalid_nonce"],
    "no nonce in the token": [{ tweakWith: { noNonce: true } }, "oidc_validation_failed"],
    "a different audience": [{ tweakWith: { aud: "another-app" } }, "oidc_validation_failed"],
    "a different issuer": [{ tweakWith: { iss: "https://evil.invalid/oidc" } }, "oidc_validation_failed"],
    "a token signed by another key": [{ tweakWith: { foreignKey: true } }, "oidc_validation_failed"],
    "an unsigned token (alg none)": [{ tweakWith: { alg: "none" } }, "oidc_validation_failed"],
    "a token signed with a shared secret (HS256)": [{ tweakWith: { alg: "HS256" } }, "oidc_validation_failed"],
    "an expired token": [{ tweakWith: { expired: true } }, "oidc_validation_failed"],
    "the provider refusing the code": [{ tweakWith: { tokenRefused: true } }, "token_exchange_failed"],
    "the provider's userinfo failing": [{ tweakWith: { userinfoRefused: true } }, "userinfo_failed"],
    "userinfo for a different subject": [{ tweakWith: { userinfoSub: "someone-else" } }, "userinfo_subject_mismatch"],
    "an unverified email": [{ tweakWith: { emailVerified: false } }, "email_verification_required"],
    "email_verified as the text \"true\"": [{ tweakWith: { emailVerified: "true" } }, "email_verification_required"],
    "no email at all": [{ tweakWith: { noEmail: true } }, "email_verification_required"],
    "the provider reporting an error": [{ query: "error=access_denied&state=x" }, null],
  };
  for (const [name, [options, code]] of Object.entries(refused)) {
    await check("refused: " + name, async () => {
      let response;
      if (options.query) { const began = await start(); response = await call("/api/auth/callback?error=access_denied&state=" + encodeURIComponent(began.state), { headers: { Cookie: began.cookie } }); }
      else response = await attempt(options);
      assert.equal(errorOf(response), code ?? "authorization_not_completed");
    });
  }
  await check("refused: a state that is not the one that was issued (first a silent restart, then the error)", async () => {
    tweak = {};
    const began = await start();
    const restart = await call("/api/auth/callback?code=synthetic&state=forged", { headers: { Cookie: began.cookie } });
    assert.equal(restart.status, 303);
    assert.match(restart.headers.get("Location"), /^\/api\/auth\/login/);
    const retry = restart.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-oidc-retry=")).split(";")[0];
    const again = await call("/api/auth/callback?code=synthetic&state=forged", { headers: { Cookie: began.cookie + "; " + retry } });
    assert.equal(errorOf(again), "invalid_transaction");
  });
  await check("refused: a sign-in that took longer than 15 minutes", async () => {
    const began = await start();
    const old = { ...JSON.parse(decodeURIComponent(began.cookie.split("=").slice(1).join("="))) };
    old.at = Date.now() - 16 * 60 * 1000;
    const cookie = "__Host-foyerdesk-oidc=" + encodeURIComponent(JSON.stringify(old)) + "; __Host-foyerdesk-oidc-retry=1";
    assert.equal(errorOf(await call("/api/auth/callback?code=synthetic&state=" + encodeURIComponent(old.state), { headers: { Cookie: cookie } })), "invalid_transaction");
  });
  await check("refused: no sign-in cookie at all", async () => {
    const response = await call("/api/auth/callback?code=synthetic&state=x", { headers: { Cookie: "__Host-foyerdesk-oidc-retry=1" } });
    assert.equal(errorOf(response), "missing_transaction");
  });
  await check("the login and callback answers set the cookie with Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain", async () => {
    const began = await start();
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok(began.raw.includes(flag), flag);
    assert.equal(/Domain=/i.test(began.raw), false);
    const ok = await attempt();
    const sessionCookie = ok.headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session="));
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=900"]) assert.ok(sessionCookie.includes(flag), flag);
    assert.equal(/Domain=/i.test(sessionCookie), false);
  });
  await check("no answer, header or redirect contains a secret", async () => {
    const response = await attempt({ tweakWith: { tokenRefused: true } });
    const dump = JSON.stringify([...response.headers]) + await response.text();
    for (const text of [secret, "synthetic-chatwoot-token", "synthetic-access"]) assert.equal(dump.includes(text), false);
  });
  await check("every answer carries nosniff, HSTS and a referrer policy; API answers are never cached", async () => {
    for (const path of ["/api/support/session", "/api/auth/login", "/app.js", "/", "/nowhere"]) {
      const response = await call(path);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", path);
      assert.ok(response.headers.get("Strict-Transport-Security"), path);
      assert.ok(response.headers.get("Referrer-Policy"), path);
    }
    assert.equal((await call("/api/support/session")).headers.get("Cache-Control"), "no-store");
    assert.match((await call("/")).headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  });
  await check("every state-changing route refuses a foreign origin and a missing origin", async () => {
    const cookie = (await attempt()).headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
    for (const path of ["/api/auth/logout", "/api/support/messages", "/api/support/topics", "/api/support/topics/1/messages", "/api/support/topics/1/resolve", "/api/support/topics/1/reopen"]) {
      for (const origin of [{ Origin: "https://evil.invalid" }, {}]) {
        const response = await call(path, { method: "POST", headers: { Cookie: cookie, ...origin }, body: "{}" });
        assert.equal(response.status, 403, path + " " + JSON.stringify(origin));
      }
    }
  });
  await check("a session id without its signature, or with a wrong one, is refused even when the id is real", async () => {
    const real = (await attempt()).headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
    const value = real.split("=")[1];
    const [id, signature] = value.split(".");
    assert.equal(signature.length, 43);
    assert.equal((await call("/api/support/session", { headers: { Cookie: real } })).status, 200);
    for (const forged of [id, id + "." + "A".repeat(43), id + "." + signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A"), "A".repeat(43) + "." + signature]) {
      assert.equal((await call("/api/support/session", { headers: { Cookie: "__Host-foyerdesk-session=" + forged } })).status, 401, forged);
    }
  });
  await check("one customer cannot write more than 30 times a minute (the 31st is refused with 429)", async () => {
    const cookie = (await attempt()).headers.getSetCookie().find((c) => c.startsWith("__Host-foyerdesk-session=")).split(";")[0];
    const codes = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await call("/api/support/messages", { method: "POST", headers: { Cookie: cookie, Origin: site, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), message: "hello " + i }) });
      codes.push(response.status);
    }
    assert.equal(codes.filter((c) => c === 429).length, 1);
    assert.equal(codes[30], 429);
  });
  await check("a garbage session cookie is the same as none", async () => {
    const response = await call("/api/support/session", { headers: { Cookie: "__Host-foyerdesk-session=" + "a".repeat(43) + "." + "b".repeat(43) } });
    assert.equal(response.status, 401);
  });
  console.log(JSON.stringify({ status: "PASS", scope: "Local Worker runtime, simulated provider", checks: results }, null, 2));
} finally {
  await worker.dispose();
}
