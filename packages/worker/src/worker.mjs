import { createRemoteJWKSet, jwtVerify } from "jose";
import { configureChatwoot, participantIdentifier, provisionApiContact } from "./contact.mjs";
import { sessionMaxAge } from "./session.mjs";
import { readLimited } from "./limits.mjs";
import { EmailLinkStore, confirmPage, linkLifetimeSeconds, mailboxKey, networkKey, normalizeEmail, sendLink, sha256Hex, tokenPattern } from "./emaillink.mjs";
import { oidcEndpoints, oidcSettings, providerTimeout, signingAlgorithms } from "./oidc.mjs";
import { html, script } from "./page.mjs";
import { streamKey, streamTarget, verifyWebhook } from "./stream.mjs";
import { parsePage, parseTab } from "./topics.mjs";

export { TestSupportSession } from "./session.mjs";
export { TestSupportThread } from "./thread.mjs";
export { SupportStream } from "./stream.mjs";
export { EmailLinkStore };

// Pages a visitor may be sent back to after signing in (anything else goes to the home page).
// Pages a visitor may be sent back to after signing in. RETURN_PATHS is a comma-separated list (default "/support"); the first one is also where a failed sign-in is reported.
const returnPaths = (env) => String(env.RETURN_PATHS ?? "/support").split(",").map((path) => path.trim()).filter((path) => /^\/[a-z0-9_\/-]*$/.test(path));
const isReturnPath = (env, path) => typeof path === "string" && returnPaths(env).includes(path);
const cookieName = "__Host-foyerdesk-oidc";
const cookieFlags = "Path=/; Secure; HttpOnly; SameSite=Lax";
const lifetimeSeconds = 900;
const retryCookie = "__Host-foyerdesk-oidc-retry";
const sessionCookie = "__Host-foyerdesk-session";
const reauthCookie = "__Host-foyerdesk-reauth";

const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function result(status, data, reset = false) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (reset) headers["Set-Cookie"] = `${cookieName}=; ${cookieFlags}; Max-Age=0`;
  return Response.json(data, { status, headers });
}

// A browser that comes back from the provider must never be left on raw JSON: send it to the page with a short code the
// screens turn into "Sign-in could not be completed". The detail stays in the server log.
function signInError(env, code, detail) {
  if (detail) console.error("sign_in_failed", code, detail);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    Location: (returnPaths(env)[0] ?? "/") + "?auth_error=" + code });
  headers.append("Set-Cookie", `${cookieName}=; ${cookieFlags}; Max-Age=0`);
  headers.append("Set-Cookie", `${retryCookie}=; ${cookieFlags}; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}

async function login(request, env) {
  const oidc = oidcSettings(env);
  if (!oidc.clientSecret) return result(503, { error: "client_secret_unavailable" });
  let endpoints;
  try { endpoints = await oidcEndpoints(oidc); } catch { return result(502, { error: "provider_unavailable" }); }
  const wanted = new URL(request.url).searchParams.get("returnTo");
  const returnTo = isReturnPath(env, wanted) ? wanted : "/";
  const rawSource = (new URL(request.url).searchParams.get("src") ?? "").toLowerCase();
  const source = /^[a-z0-9_-]{1,32}$/.test(rawSource) ? rawSource : undefined;
  const transaction = { verifier: random(), state: random(), nonce: random(), at: Date.now(), returnTo, source };
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(transaction.verifier));
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    client_id: oidc.clientId,
    redirect_uri: env.CALLBACK_URI,
    response_type: "code",
    scope: oidc.flavor === "logto" ? "openid profile email identities" : "openid profile email",
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: b64url(new Uint8Array(challenge)),
    code_challenge_method: "S256",
  });
  // A visitor who picked a provider on the page goes straight to it. Anything else shows Logto's own sign-in page.
  const provider = new URL(request.url).searchParams.get("provider");
  if (oidc.flavor === "logto" && (provider === "google" || provider === "linkedin")) url.searchParams.set("direct_sign_in", "social:" + provider);
  if ((request.headers.get("Cookie") ?? "").split("; ").includes(reauthCookie + "=1")) {
    url.searchParams.set("prompt", "login");
  }
  return new Response(null, { status: 302, headers: {
    Location: url.href,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Set-Cookie": `${cookieName}=${encodeURIComponent(JSON.stringify(transaction))}; ${cookieFlags}; Max-Age=${lifetimeSeconds}`,
  } });
}

// Shared end of every sign-in: the Chatwoot contact, the server-side session and the cookies. A provider only has to
// say who the person is (identifier, verified email) and where to send them back.
async function finishSignIn(request, env, { identifier, userInfo, transaction }) {
  let mapping;
  if (env.FULL_PAGE_INBOX_ID !== undefined) {
    const inboxId = Number(env.FULL_PAGE_INBOX_ID);
    if (!Number.isSafeInteger(inboxId) || inboxId < 1) throw new Error("invalid_inbox");
    try {
      mapping = await provisionApiContact(identifier, userInfo, env.CHATWOOT_APPLICATION_TOKEN, inboxId, env.CHATWOOT_CONTACT_SOURCE_KEY, {
        country: request.cf?.country, source: /^[a-z0-9_-]{1,32}$/.test(transaction.source ?? "") ? transaction.source : undefined,
        provider: Object.keys(userInfo.identities ?? {})[0] ?? "email",
      });
    } catch (error) {
      return signInError(env, "contact_provisioning_unavailable", error instanceof Error ? error.message : "unknown");
    }
    if (!mapping) return signInError(env, "explicit_contact_linking_required");
  } else {
    if (!env.FULL_PAGE_TEST_IDENTIFIER || identifier !== env.FULL_PAGE_TEST_IDENTIFIER) {
      return signInError(env, "test_identity_required");
    }
    if (!env.FULL_PAGE_SOURCE_ID) return signInError(env, "test_disabled");
    mapping = { contactId: 8, inboxId: 4, sourceId: env.FULL_PAGE_SOURCE_ID };
  }
  const sessionId = random();
  const shown = (value, max) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  const account = { name: shown(userInfo.name, 120), email: shown(userInfo.email, 200),
    provider: Object.keys(userInfo.identities ?? {})[0] ?? "email",
    picture: typeof userInfo.picture === "string" && /^https:\/\//.test(userInfo.picture) ? userInfo.picture.slice(0, 500) : null };
  await env.SUPPORT_SESSIONS.getByName(sessionId).save({ identifier, mapping, account });
  const headers = new Headers({ Location: isReturnPath(env, transaction.returnTo) ? transaction.returnTo : "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", `${cookieName}=; ${cookieFlags}; Max-Age=0`);
  headers.append("Set-Cookie", `${reauthCookie}=; ${cookieFlags}; Max-Age=0`);
  headers.append("Set-Cookie", `${retryCookie}=; ${cookieFlags}; Max-Age=0`);
  headers.append("Set-Cookie", `${sessionCookie}=${await signedSession(env, sessionId)}; ${cookieFlags}; Max-Age=${sessionMaxAge}`);
  return new Response(null, { status: 303, headers });
}

function restartOrFail(request, env, error) {
  const home = returnPaths(env)[0] ?? "/";
  const cookies = request.headers.get("Cookie") ?? "";
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", `${cookieName}=; ${cookieFlags}; Max-Age=0`);
  if (cookies.split("; ").includes(retryCookie + "=1")) {
    headers.append("Set-Cookie", `${retryCookie}=; ${cookieFlags}; Max-Age=0`);
    headers.set("Location", home + "?auth_error=" + error);
    return new Response(null, { status: 303, headers });
  }
  headers.append("Set-Cookie", `${retryCookie}=1; ${cookieFlags}; Max-Age=120`);
  headers.set("Location", "/api/auth/login?returnTo=" + encodeURIComponent(home));
  return new Response(null, { status: 303, headers });
}

const keySets = new Map(); // the provider's keys are cached by the library between sign-ins
async function callback(request, url, env) {
  let transaction;
  try {
    const cookie = (request.headers.get("Cookie") ?? "").split("; ")
      .find((value) => value.startsWith(cookieName + "="));
    transaction = JSON.parse(decodeURIComponent(cookie?.slice(cookieName.length + 1) ?? ""));
  } catch {
    return restartOrFail(request, env, "missing_transaction");
  }
  if (typeof transaction?.at !== "number" || typeof transaction.verifier !== "string" ||
      typeof transaction.nonce !== "string" || !transaction.state ||
      transaction.state !== url.searchParams.get("state") ||
      Date.now() - transaction.at > lifetimeSeconds * 1000) {
    return restartOrFail(request, env, "invalid_transaction");
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code) {
    return signInError(env, "authorization_not_completed");
  }
  const oidc = oidcSettings(env);
  if (!oidc.clientSecret) return signInError(env, "client_secret_unavailable");
  try {
    const endpoints = await oidcEndpoints(oidc);
    const response = await fetch(endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: env.CALLBACK_URI,
        code_verifier: transaction.verifier, client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
      }),
      signal: AbortSignal.timeout(providerTimeout),
    });
    if (!response.ok) return signInError(env, "token_exchange_failed");
    const tokens = await response.json();
    if (!keySets.has(endpoints.jwks)) keySets.set(endpoints.jwks, createRemoteJWKSet(new URL(endpoints.jwks), { timeoutDuration: providerTimeout }));
    const jwks = keySets.get(endpoints.jwks);
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: oidc.issuer, audience: oidc.clientId, algorithms: signingAlgorithms,
      requiredClaims: ["sub", "exp", "iat", "nonce"],
    });
    if (payload.nonce !== transaction.nonce) return signInError(env, "invalid_nonce");

    const userInfoResponse = await fetch(endpoints.userinfo, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(providerTimeout),
    });
    if (!userInfoResponse.ok) return signInError(env, "userinfo_failed");
    const userInfo = await userInfoResponse.json();
    if (userInfo.sub !== payload.sub) return signInError(env, "userinfo_subject_mismatch");
    const emailVerified = typeof userInfo.email === "string" && userInfo.email_verified === true;
    const identifier = await participantIdentifier(oidc.issuer, userInfo.sub);
    if (!emailVerified) return signInError(env, "email_verification_required");
    return await finishSignIn(request, env, { identifier, userInfo, transaction });
  } catch (error) {
    return signInError(env, "oidc_validation_failed", error instanceof Error ? error.message : "unknown");
  }
}


const textHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };

// POST /api/auth/email/start  {email, returnTo?, src?}: always answers the same for a valid address, so it cannot be
// used to find out who has an account.
async function emailStart(request, url, env) {
  if (!env.EMAIL_LINKS || !env.MAIL_PROVIDER) return result(404, { error: "not_found" }); // off unless a mail service is set
  if (request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  let data;
  try {
    const text = await readLimited(request, 2000);
    if (text === null) return result(413, { error: "request_too_large" });
    data = JSON.parse(text);
  } catch { return result(400, { error: "invalid_body" }); }
  const email = normalizeEmail(data?.email);
  if (!email) return result(400, { error: "invalid_email" });
  const ip = networkKey(request.headers.get("CF-Connecting-IP") ?? "unknown");
  // The network is counted first: a flood from one place cannot use up the owner's allowance for their own address.
  if (!await env.EMAIL_LINKS.getByName("rate-i:" + await sha256Hex(ip)).hit(10, 600)) return result(429, { error: "too_many_requests" });
  if (!await env.EMAIL_LINKS.getByName("rate-a:" + await sha256Hex(mailboxKey(email))).hit(3, 600)) return result(429, { error: "too_many_requests" });
  const token = random();
  const rawSource = typeof data.src === "string" ? data.src.toLowerCase() : "";
  await env.EMAIL_LINKS.getByName("token:" + await sha256Hex(token)).put({
    email, returnTo: isReturnPath(env, data.returnTo) ? data.returnTo : "/",
    source: /^[a-z0-9_-]{1,32}$/.test(rawSource) ? rawSource : undefined,
  });
  try {
    await sendLink(env, { to: email, url: `${url.origin}/api/auth/email/verify?token=${token}` });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.error("email_link_send_failed", reason);
    // The mail service refusing this one address looks the same as success; only a service-wide failure is reported.
    if (/^mail_failed_4/.test(reason)) return result(202, { sent: true, expiresInSeconds: linkLifetimeSeconds });
    return result(502, { error: "mail_unavailable" });
  }
  return result(202, { sent: true, expiresInSeconds: linkLifetimeSeconds });
}

// GET shows a confirm button; POST uses the token.
async function emailVerify(request, url, env) {
  if (!env.EMAIL_LINKS || !env.MAIL_PROVIDER) return result(404, { error: "not_found" }); // off unless a mail service is set
  if (request.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!tokenPattern.test(token)) return new Response("This link is not valid.", { status: 400, headers: textHeaders });
    const waiting = await env.EMAIL_LINKS.getByName("token:" + await sha256Hex(token)).peek();
    if (!waiting) return new Response("This link has expired or was already used. Request a new one.", { status: 410, headers: textHeaders });
    return new Response(confirmPage(token, env.EMAIL_LINK_BRAND, waiting.email), { headers: { ...textHeaders, "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  const form = await readLimited(request, 2000);
  const token = form === null ? "" : String(new URLSearchParams(form).get("token") ?? "");
  if (!tokenPattern.test(token)) return new Response("This link is not valid.", { status: 400, headers: textHeaders });
  const link = await env.EMAIL_LINKS.getByName("token:" + await sha256Hex(token)).consume();
  if (!link) return new Response("This link has expired or was already used. Request a new one.", { status: 410, headers: textHeaders });
  const userInfo = { sub: link.email, email: link.email, email_verified: true };
  const identifier = await participantIdentifier("foyerdesk:email-link", link.email);
  const done = await finishSignIn(request, env, { identifier, userInfo, transaction: { returnTo: link.returnTo, source: link.source } });
  // The link is not used up by a failure on our side (Chatwoot down): the person may press the button again.
  if (done.status === 303 && (done.headers.get("Location") ?? "").includes("auth_error=")) {
    await env.EMAIL_LINKS.getByName("token:" + await sha256Hex(token)).put({ email: link.email, returnTo: link.returnTo, source: link.source });
  }
  return done;
}

// The session cookie is "<id>.<signature>". The signature key is derived (HKDF) from a secret the Worker already has, so no new
// secret is needed. A cookie with a wrong signature is dropped here, before any Durable Object is asked, so random
// values cannot be used to burn the daily Durable Object quota.
const signingKeys = new Map();
async function signingKey(env) {
  // SESSION_SECRET if set; otherwise a secret the Worker already has (sign-in with e-mail links needs no OIDC secret).
  const secret = env.SESSION_SECRET ?? oidcSettings(env).clientSecret ?? env.CHATWOOT_WEBHOOK_SECRET ?? env.CHATWOOT_APPLICATION_TOKEN ?? "";
  if (!secret) return null;
  if (!signingKeys.has(secret)) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    signingKeys.set(secret, await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("foyerdesk"), info: new TextEncoder().encode("session-cookie-v1") }, base, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return signingKeys.get(secret);
}
async function signedSession(env, id) {
  const key = await signingKey(env);
  if (!key) throw new Error("signing_key_unavailable");
  return id + "." + b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id))));
}
async function sessionIdFrom(request, env) {
  const match = (request.headers.get("Cookie") ?? "").match(/(?:^|; )__Host-foyerdesk-session=([a-zA-Z0-9_-]{43})\.([a-zA-Z0-9_-]{43})(?:;|$)/);
  if (!match) return undefined;
  const key = await signingKey(env);
  if (!key) return undefined;
  const signature = Uint8Array.from(atob(match[2].replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
  return (await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(match[1]))) ? match[1] : undefined;
}

// Who is signed in, for the line shown on the page. Sessions created before this field existed return account null.
async function whoAmI(request, env) {
  const sessionId = await sessionIdFrom(request, env);
  const identity = sessionId ? await env.SUPPORT_SESSIONS.getByName(sessionId).read() : null;
  if (!identity) return result(401, { error: "sign_in_required" });
  return result(200, { account: identity.account ?? null });
}

async function messages(request, url, env) {
  const sessionId = await sessionIdFrom(request, env);
  const identity = sessionId ? await env.SUPPORT_SESSIONS.getByName(sessionId).read() : null;
  if (!identity) return result(401, { error: "sign_in_required" });
  const { identifier, mapping } = identity;
  if (env.FULL_PAGE_INBOX_ID === undefined) {
    if (!env.FULL_PAGE_SOURCE_ID || !env.FULL_PAGE_TEST_IDENTIFIER) return result(503, { error: "test_disabled" });
    if (identifier !== env.FULL_PAGE_TEST_IDENTIFIER || mapping.inboxId !== 4) {
      return result(403, { error: "test_identity_required" });
    }
  } else if (mapping.inboxId !== Number(env.FULL_PAGE_INBOX_ID)) {
    return result(401, { error: "sign_in_required" });
  }
  const contactGone = async () => {
    await env.SUPPORT_SESSIONS.getByName(sessionId).revoke();
    const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
    headers.append("Set-Cookie", `${sessionCookie}=; ${cookieFlags}; Max-Age=0`);
    return new Response(JSON.stringify({ error: "sign_in_required" }), { status: 401, headers });
  };
  const threadKey = env.FULL_PAGE_INBOX_ID === undefined ? "contact-8-inbox-4" : JSON.stringify([identifier, mapping.inboxId]);
  const thread = env.FULL_PAGE_THREAD.getByName(threadKey);
  if (request.method === "GET") {
    try {
      const cursor = (name) => {
        const value = url.searchParams.get(name);
        return value === null ? undefined : /^[0-9]{1,10}$/.test(value) ? Number(value) : null;
      };
      const before = cursor("before"), after = cursor("after");
      if (before === null || after === null) return result(400, { error: "invalid_cursor" });
      return result(200, after !== undefined ? await thread.since(mapping, after) : await thread.page(mapping, { before }));
    } catch (error) {
      if (String(error?.message).includes("contact_gone")) return contactGone();
      return result(502, { error: "history_unavailable" });
    }
  }
  if (request.method !== "POST") return result(405, { error: "method_not_allowed" });
  if (request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  let data;
  try {
    const body = await readLimited(request, 12000);
    if (body === null) return result(413, { error: "request_too_large" });
    data = JSON.parse(body);
    if (!data || typeof data.requestId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.requestId) ||
        typeof data.message !== "string" || !data.message.trim() || data.message.trim().length > 3000) {
      return result(400, { error: "invalid_message" });
    }
  } catch {
    return result(400, { error: "invalid_message" });
  }
  try {
    const outcome = await thread.send(mapping, data.requestId.toLowerCase(), data.message.trim());
    if (outcome === "conflict") return result(409, { error: "request_id_conflict" });
    if (outcome === "rate_limited") return result(429, { error: "rate_limited" });
    if (outcome !== "accepted") return result(503, { error: "delivery_unconfirmed" });
    // Enable a repeatable loss-of-acknowledgement test only on this isolated page.
    if (env.FULL_PAGE_INBOX_ID === undefined && request.headers.get("X-Foyerdesk-Test-Lose-Ack") === "1") {
      return result(503, { error: "test_acknowledgement_withheld" });
    }
    return result(200, { accepted: true });
  } catch (error) {
    if (String(error?.message).includes("contact_gone")) return contactGone();
    return result(503, { error: "delivery_unconfirmed" });
  }
}

async function logout(request, url, env) {
  if (request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  const sessionId = await sessionIdFrom(request, env);
  if (sessionId) {
    const identity = await env.SUPPORT_SESSIONS.getByName(sessionId).read();
    await env.SUPPORT_SESSIONS.getByName(sessionId).revoke();
    // An open page keeps no live channel after sign-out.
    if (identity?.mapping && env.SUPPORT_STREAM) {
      try { await env.SUPPORT_STREAM.getByName(streamKey(identity.mapping)).closeAll(); } catch { /* the sockets end with the page */ }
    }
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `${sessionCookie}=; ${cookieFlags}; Max-Age=0`);
  headers.append("Set-Cookie", `${reauthCookie}=1; ${cookieFlags}; Max-Age=86400`);
  return new Response(null, { status: 204, headers });
}

// ---- Topics. New routes next to /api/support/messages; the single-thread route above is unchanged. ----
const idPattern = /^[0-9]{1,12}$/;
const requestIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function topicsApi(request, url, env) {
  // A write from another site is refused before anything else is looked at.
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  const sessionId = await sessionIdFrom(request, env);
  const identity = sessionId ? await env.SUPPORT_SESSIONS.getByName(sessionId).read(false) : null;
  if (!identity || env.FULL_PAGE_INBOX_ID === undefined || identity.mapping.inboxId !== Number(env.FULL_PAGE_INBOX_ID)) {
    return result(401, { error: "sign_in_required" });
  }
  const { identifier, mapping } = identity;
  const thread = env.FULL_PAGE_THREAD.getByName(JSON.stringify([identifier, mapping.inboxId]));
  const route = url.pathname.slice("/api/support/topics".length).split("/").filter(Boolean);
  const write = request.method === "POST";
  if (write && request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  if (!write && request.method !== "GET") return result(405, { error: "method_not_allowed" });
  const gone = async () => {
    await env.SUPPORT_SESSIONS.getByName(sessionId).revoke();
    const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
    headers.append("Set-Cookie", `${sessionCookie}=; ${cookieFlags}; Max-Age=0`);
    return new Response(JSON.stringify({ error: "sign_in_required" }), { status: 401, headers });
  };
  const readBody = async () => {
    const body = await readLimited(request, 12000);
    if (body === null) return { error: result(413, { error: "request_too_large" }) };
    try { const data = JSON.parse(body); return data && typeof data === "object" ? { data } : { error: result(400, { error: "invalid_request" }) }; }
    catch { return { error: result(400, { error: "invalid_request" }) }; }
  };
  const failure = (error) => {
    const text = String(error?.message);
    if (text.includes("contact_gone")) return gone();
    if (text.includes("topic_not_found")) return result(404, { error: "topic_not_found" });
    return result(502, { error: "topics_unavailable" });
  };
  const status = (code) => ({ conflict: 409, unconfirmed: 503, too_many_open_topics: 429, rate_limited: 429 })[code] ?? 400;
  try {
    // /api/support/topics
    if (route.length === 0) {
      if (!write) {
        const tab = parseTab(url.searchParams.get("tab") ?? undefined), page = parsePage(url.searchParams.get("page") ?? undefined);
        if (tab === null || page === null) return result(400, { error: "invalid_query" });
        return result(200, await thread.listTopics(mapping, tab, page));
      }
      const { data, error } = await readBody();
      if (error) return error;
      if (typeof data.requestId !== "string" || !requestIdPattern.test(data.requestId)) return result(400, { error: "invalid_request_id" });
      const created = await thread.createTopic(mapping, data.requestId.toLowerCase(), { subject: data.subject, message: data.message });
      return created.error ? result(status(created.error), { error: created.error }) : result(created.repeated ? 200 : 201, { id: created.id });
    }
    if (!idPattern.test(route[0])) return result(404, { error: "topic_not_found" });
    const id = Number(route[0]);
    // /api/support/topics/{id}/messages
    if (route.length === 2 && route[1] === "messages") {
      if (!write) {
        const cursor = (name) => { const value = url.searchParams.get(name); return value === null ? undefined : /^[0-9]{1,10}$/.test(value) ? Number(value) : null; };
        const before = cursor("before"), after = cursor("after");
        if (before === null || after === null) return result(400, { error: "invalid_cursor" });
        return result(200, await thread.topicMessages(mapping, id, { before, after }));
      }
      const { data, error } = await readBody();
      if (error) return error;
      if (typeof data.requestId !== "string" || !requestIdPattern.test(data.requestId)) return result(400, { error: "invalid_request_id" });
      const sent = await thread.replyTopic(mapping, id, data.requestId.toLowerCase(), data.message);
      return sent.error ? result(status(sent.error), { error: sent.error }) : result(200, { accepted: true });
    }
    // /api/support/topics/{id}/resolve and /reopen
    if (route.length === 2 && write && (route[1] === "resolve" || route[1] === "reopen")) {
      const changed = await thread.changeTopic(mapping, id, route[1]);
      return changed.error ? result(status(changed.error), { error: changed.error }) : result(200, changed);
    }
    return result(404, { error: "not_found" });
  } catch (error) {
    return failure(error);
  }
}

// Chatwoot -> Worker: a reply exists. Verified by signature; the page is only told "changed".
async function webhook(request, env) {
  if (request.method !== "POST") return result(405, { error: "method_not_allowed" });
  const checked = await verifyWebhook(request, env.CHATWOOT_WEBHOOK_SECRET);
  if (checked.status !== 200) return result(checked.status, { error: checked.error });
  const target = streamTarget(checked.payload, Number(env.FULL_PAGE_INBOX_ID));
  if (!target) return new Response(null, { status: 204 });
  try {
    await env.SUPPORT_STREAM.getByName(streamKey(target)).notify(target.conversationId ?? undefined);
  } catch {
    return result(502, { error: "notify_failed" }); // the page's slow safety check still finds the reply
  }
  return new Response(null, { status: 204 });
}

// The page opens one socket after sign-in. Same-origin only; the session decides which contact's stream it joins.
async function stream(request, url, env) {
  if (request.headers.get("Upgrade") !== "websocket") return result(426, { error: "websocket_required" });
  if (request.headers.get("Origin") !== url.origin) return result(403, { error: "same_origin_required" });
  const sessionId = await sessionIdFrom(request, env);
  const identity = sessionId ? await env.SUPPORT_SESSIONS.getByName(sessionId).read() : null;
  if (!identity || env.FULL_PAGE_INBOX_ID === undefined || identity.mapping.inboxId !== Number(env.FULL_PAGE_INBOX_ID)) {
    return result(401, { error: "sign_in_required" });
  }
  return env.SUPPORT_STREAM.getByName(streamKey(identity.mapping)).fetch(request);
}

// Every answer, including the site's own files, carries the same baseline headers.
function withBaseHeaders(response) {
  if (response.status === 101 || response.webSocket) return response;
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("X-Content-Type-Options", "nosniff");
  if (!wrapped.headers.has("Referrer-Policy")) wrapped.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  wrapped.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return wrapped;
}

// The built-in test mode and the single-thread route /api/support/messages are off unless asked for (FOYERDESK_TEST_MODE=1,
// LEGACY_MESSAGES=1). A missing FULL_PAGE_INBOX_ID is a configuration mistake, not a reason to open a test mode.
const flag = (value) => String(value ?? "") === "1";

async function handle(request, env) {
    configureChatwoot(env);
    const url = new URL(request.url);
    if (url.origin !== new URL(env.CALLBACK_URI).origin) return result(404, { error: "not_found" });
    if (env.FULL_PAGE_INBOX_ID === undefined && !flag(env.FOYERDESK_TEST_MODE) && url.pathname.startsWith("/api/")) return result(503, { error: "misconfigured" });
    if (url.pathname === "/api/support/messages" && env.FULL_PAGE_INBOX_ID !== undefined && !flag(env.LEGACY_MESSAGES)) return result(404, { error: "not_found" });
    if (url.pathname === "/api/auth/email/start" && request.method === "POST") return emailStart(request, url, env);
    if (url.pathname === "/api/auth/email/verify" && (request.method === "GET" || request.method === "POST")) return emailVerify(request, url, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, url, env);
    if (url.pathname === "/api/support/messages") return messages(request, url, env);
    if (url.pathname === "/api/support/topics" || url.pathname.startsWith("/api/support/topics/")) return topicsApi(request, url, env);
    if (url.pathname === "/api/support/webhook") return webhook(request, env);
    if (url.pathname === "/api/support/stream") return stream(request, url, env);
    if (request.method !== "GET") return result(405, { error: "method_not_allowed" });
    if (url.pathname === "/api/support/session") return whoAmI(request, env);
    if (url.pathname === "/api/auth/login") return login(request, env);
    if (url.pathname === "/api/auth/callback") return callback(request, url, env);
    if (url.pathname === "/app.js") return new Response(script, { headers: {
      "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store",
    } });
    if (url.pathname === "/") return new Response(html, { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
    if (env.SITE_ASSETS && !url.pathname.startsWith("/api/")) return env.SITE_ASSETS.fetch(request);
    return result(404, { error: "not_found" });
}

export default { fetch: async (request, env) => withBaseHeaders(await handle(request, env)) };
