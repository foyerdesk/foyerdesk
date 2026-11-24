import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
const contract = JSON.parse(await readFile(new URL("../../../docs/contract.json", import.meta.url), "utf8"));
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const scriptPath = resolve(process.argv[2] ?? "/tmp/foyerdesk-worker-acceptance/worker.js");
const script = await readFile(scriptPath, "utf8");
const site = "https://support-fixture.invalid";
const issuer = "https://issuer-fixture.invalid/oidc";
const clientId = "test-client";
const owner = "fixture-owner";
const identifier = "acme-" + createHash("sha256").update(JSON.stringify([issuer, owner])).digest("hex");
const messages = [];
const { publicKey, privateKey } = await generateKeyPair("ES384");
const publicJwk = { ...await exportJWK(publicKey), alg: "ES384", use: "sig", kid: "fixture" };
const persistence = await mkdtemp(join(tmpdir(), "foyerdesk-worker-test-"));
let tokenUser = owner;
let verifiedEmail = true;
const seenCalls = [];
let emailOverride;
let nonce;
let visits = 0;
let writes = 0;
let countryWrites = 0;
let profileClaims = false;
const bulk = new Map(); // conversation id -> long message lists for paging tests
let sentScope = "";
let faults = "none";
let multiUser = false;
const contacts = [];
let topicMode = false;
const topicRows = []; // emulated Chatwoot conversations for the topic tests
let topicFault = "none";
let topicClock = 1795500000;
const threads = new Map();

// Chatwoot's message paging (MessageFinder, v4.20.1): latest 20; before=<id> the 20 before it; after=<id> up to 100 after it.
function chatwootPage(list, params) {
  const sorted = [...list].sort((x, y) => x.id - y.id);
  const before = params.get("before"), after = params.get("after");
  if (before) return sorted.filter((m) => m.id < Number(before)).slice(-20);
  if (after) return sorted.filter((m) => m.id > Number(after)).slice(0, 100);
  return sorted.slice(-20);
}

async function upstream(request) {
  const url = new URL(request.url);
  if (url.origin === new URL(issuer).origin) {
    if (url.pathname.endsWith("/token")) {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("client_id"), clientId);
      assert.equal(form.get("redirect_uri"), site + "/api/auth/callback");
      assert.ok(form.get("code_verifier"));
      const jwt = await new SignJWT({ nonce }).setIssuer(issuer).setAudience(clientId)
        .setSubject(tokenUser).setIssuedAt().setExpirationTime("5m")
        .setProtectedHeader({ alg: "ES384", kid: "fixture" }).sign(privateKey);
      return Response.json({ id_token: jwt, access_token: "synthetic-access" });
    }
    if (url.pathname.endsWith("/jwks")) return Response.json({ keys: [publicJwk] });
    if (url.pathname.endsWith("/me")) return Response.json({
      sub: tokenUser, email: emailOverride ?? tokenUser + "@example.invalid", email_verified: verifiedEmail,
      ...(profileClaims ? { name: "Alex Example", picture: "https://img.example.invalid/a.png", locale: "en-US", identities: { linkedin: { userId: "li-1" } } } : {}),
    });
  }

  assert.equal(url.origin, "https://chat.example.invalid");
  if (url.pathname.startsWith("/public/api/v1/inboxes/inbox-identifier/")) {
    assert.equal(request.method, "POST");
    seenCalls.push(url.pathname);
    return new Response(null, { status: 200 });
  }
  assert.equal(request.headers.get("api_access_token"), "synthetic-chatwoot-token");
  const path = url.pathname.replace("/api/v1/accounts/1", "");
  if (topicMode && path.startsWith("/conversations")) {
    const detail = (row) => ({ id: row.id, status: row.status, inbox_id: row.inbox_id, contact_id: row.contactId, meta: { sender: { id: row.contactId } },
      custom_attributes: row.custom_attributes, last_activity_at: row.last_activity_at, contact_last_seen_at: 0,
      messages: row.messages.filter((m) => m.message_type !== 2).slice(-1) });
    const touch = (row) => { row.last_activity_at = ++topicClock; };
    if (request.method === "POST" && path === "/conversations/filter") {
      const payload = (await request.json()).payload;
      const want = Object.fromEntries(payload.map((p) => [p.attribute_key, p.values]));
      assert.equal(payload.at(-1).query_operator, null);
      const hit = topicRows.filter((r) => want.contact_id.includes(r.contactId) && want.inbox_id.includes(r.inbox_id) && (!want.status || want.status.includes(r.status)))
        .sort((x, y) => y.last_activity_at - x.last_activity_at);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ payload: hit.slice((page - 1) * 25, page * 25).map(detail), meta: { all_count: hit.length } });
    }
    if (request.method === "POST" && path === "/conversations") {
      if (topicFault === "contact_deleted") return new Response(null, { status: 404 });
      const data = await request.json();
      assert.equal(data.message.message_type, "incoming");
      if (topicFault === "create_committed_then_lost") {
        const lost = { id: 5000 + topicRows.length, contactId: data.contact_id, inbox_id: data.inbox_id, status: "open", custom_attributes: data.custom_attributes,
          messages: [{ id: 1, message_type: 0, content: data.message.content, content_attributes: data.message.content_attributes, private: false }], last_activity_at: ++topicClock };
        topicRows.push(lost);
        return new Response(null, { status: 502 });
      }
      const row = { id: 5000 + topicRows.length, contactId: data.contact_id, inbox_id: data.inbox_id, status: "open", custom_attributes: data.custom_attributes,
        messages: [{ id: 1, message_type: 0, content: data.message.content, content_attributes: data.message.content_attributes, private: false }], last_activity_at: ++topicClock };
      topicRows.push(row);
      return Response.json({ id: row.id });
    }
    const one = path.match(/^\/conversations\/(\d+)(?:\/(messages|toggle_status))?$/);
    const row = one && topicRows.find((r) => r.id === Number(one[1]));
    if (one && !row) return new Response(null, { status: 404 });
    if (one && request.method === "GET" && !one[2]) return Response.json(detail(row));
    if (one && request.method === "GET" && one[2] === "messages") return Response.json({ payload: chatwootPage(row.messages, url.searchParams).map((m) => ({ conversation_id: row.id, ...m })) });
    if (one && request.method === "POST" && one[2] === "messages") {
      const body = await request.json();
      assert.equal(body.message_type, "incoming");
      row.messages.push({ id: row.messages.length + 1, message_type: 0, content: body.content, content_attributes: body.content_attributes, private: false });
      if (row.status === "resolved") { row.status = "open"; row.messages.push({ id: row.messages.length + 1, message_type: 2, content: "Conversation was reopened", private: false }); }
      touch(row);
      return topicFault === "reply_committed_then_lost" ? new Response(null, { status: 502 }) : Response.json({ id: row.messages.length });
    }
    if (one && request.method === "POST" && one[2] === "toggle_status") {
      row.status = (await request.json()).status;
      row.messages.push({ id: row.messages.length + 1, message_type: 2, content: "Status changed", private: false });
      touch(row);
      return Response.json({});
    }
  }
  if (multiUser) {
    if (request.method === "GET" && path === "/contacts/search") {
      const key = url.searchParams.get("q");
      // Like Chatwoot: part of an email matches, 15 rows a page.
      const all = contacts.filter((row) => row.identifier === key || (row.email ?? "").includes(key));
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ payload: all.slice((page - 1) * 15, page * 15) });
    }
    if (request.method === "POST" && path === "/contacts") {
      const data = await request.json();
      contacts.push({ ...data, id: 100 + contacts.length, contact_inboxes: [] });
      return Response.json({});
    }
    const put = path.match(/^\/contacts\/(\d+)$/);
    if (request.method === "PUT" && put) {
      const data = await request.json();
      if (data.additional_attributes) {
        countryWrites++;
        if (faults === "country_write_fails") return new Response(null, { status: 500 });
      }
      Object.assign(contacts.find((row) => row.id === Number(put[1])), data);
      return Response.json({});
    }
    const link = path.match(/^\/contacts\/(\d+)\/contact_inboxes$/);
    if (request.method === "POST" && link) {
      const data = await request.json();
      const contact = contacts.find((row) => row.id === Number(link[1]));
      contact.contact_inboxes.push({ inbox: { id: data.inbox_id }, source_id: data.source_id });
      return Response.json({});
    }
    const list = path.match(/^\/contacts\/(\d+)\/conversations$/);
    if (request.method === "GET" && list) {
      if (Number(list[1]) === 900) return Response.json({ payload: [
        { id: 1002, inbox_id: 4, status: "open" }, { id: 1001, inbox_id: 4, status: "resolved" }] });
      if (!contacts.some((row) => row.id === Number(list[1]))) return new Response(null, { status: 404 });
      const thread = threads.get(Number(list[1]));
      return Response.json({ payload: thread ? [{ id: thread.id, inbox_id: 4 }] : [] });
    }
    if (request.method === "POST" && path === "/conversations") {
      const data = await request.json();
      const contact = contacts.find((row) => row.id === data.contact_id);
      assert.equal(data.source_id, contact.contact_inboxes[0].source_id);
      assert.equal(data.inbox_id, 4);
      assert(!threads.has(contact.id));
      const id = contact.id + 10;
      threads.set(contact.id, { id, messages: [{...data.message, id, message_type: 0}] });
      return Response.json({ id });
    }
    const history = path.match(/^\/conversations\/(\d+)\/messages$/);
    if (request.method === "GET" && history) {
      if (bulk.has(Number(history[1]))) return Response.json({ payload: chatwootPage(bulk.get(Number(history[1])), url.searchParams) });
      if (Number(history[1]) === 1001) return Response.json({ payload: chatwootPage([
        { id: 1, message_type: 0, content: "Old question", private: false },
        { id: 2, message_type: 1, content: "Old answer", private: false }], url.searchParams) });
      if (Number(history[1]) === 1002) return Response.json({ payload: chatwootPage([
        { id: 3, message_type: 0, content: "New question", private: false }], url.searchParams) });
      const thread = [...threads.values()].find((row) => row.id === Number(history[1]));
      return Response.json({ payload: chatwootPage(thread.messages, url.searchParams) });
    }
    throw new Error("Unexpected multi-user fixture request: " + path);
  }
  if (request.method === "GET" && path === "/contacts/8/conversations") {
    visits++;
    if (faults === "lookup_offline") return new Response(null, { status: 503 });
    return Response.json({ payload: messages.length ? [{ id: 44, inbox_id: 4 }] : [] });
  }
  if (request.method === "GET" && path === "/conversations/44/messages") return Response.json({ payload: chatwootPage(messages, url.searchParams) });
  if (request.method === "POST" && ["/conversations", "/conversations/44/messages"].includes(path)) {
    const body = await request.json();
    const message = body.message ?? body;
    assert.equal(message.message_type, "incoming");
    if (path === "/conversations") {
      assert.equal(body.contact_id, 8);
      assert.equal(body.inbox_id, 4);
    }
    writes++;
    messages.push({ ...message, id: writes, message_type: 0 });
    if (faults === "chatwoot_committed_then_lost") return new Response(null, { status: 502 });
    return Response.json({ id: 44 });
  }
  throw new Error("Unexpected fixture request: " + path);
}

function runtime(clockOffset = 0) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: clockOffset ? `const actualNow = Date.now.bind(Date); Date.now = () => actualNow() + ${clockOffset};\n${script}` : script,
    compatibilityDate: "2026-10-19",
    durableObjects: {
      SUPPORT_SESSIONS: { className: "TestSupportSession", useSQLite: true, unsafeUniqueKey: "foyerdesk-acceptance-sessions" },
      FULL_PAGE_THREAD: { className: "TestSupportThread", useSQLite: true, unsafeUniqueKey: "foyerdesk-acceptance-thread" },
      SUPPORT_STREAM: { className: "SupportStream", useSQLite: true, unsafeUniqueKey: "foyerdesk-acceptance-stream" },
    },
    isolatedResourcePersistencePath: persistence, resourcePersistencePath: persistence,
    outboundService: upstream,
    bindings: {
      LOGTO_ISSUER: issuer, LOGTO_CLIENT_ID: clientId, LOGTO_CLIENT_SECRET: "synthetic-secret",
      CHATWOOT_BASE_URL: "https://chat.example.invalid", CHATWOOT_ACCOUNT_ID: "1", IDENTIFIER_PREFIX: "acme-", DEFAULT_CONTACT_NAME: "Customer", RETURN_PATHS: "/talk,/support", CALLBACK_URI: site + "/api/auth/callback", CHATWOOT_APPLICATION_TOKEN: "synthetic-chatwoot-token", CHATWOOT_WEBHOOK_SECRET: "synthetic-webhook-secret",
      FOYERDESK_TEST_MODE: "1", LEGACY_MESSAGES: "1", FULL_PAGE_TEST_IDENTIFIER: identifier, FULL_PAGE_SOURCE_ID: "synthetic-source",
      ...(multiUser ? { FULL_PAGE_INBOX_ID: "4", CHATWOOT_CONTACT_SOURCE_KEY: "fixture-source-key", CHATWOOT_INBOX_IDENTIFIER: "inbox-identifier" } : {}),
    },
  }));
}

let worker = runtime();
function call(path, options = {}) {
  return worker.dispatchFetch(site + path, { redirect: "manual", ...options });
}
async function login(country, src) {
  const start = await call("/api/auth/login" + (src !== undefined ? "?src=" + encodeURIComponent(src) : ""));
  assert.equal(start.status, 302);
  const params = new URL(start.headers.get("Location")).searchParams;
  sentScope = params.get("scope");
  nonce = params.get("nonce");
  return call("/api/auth/callback?code=synthetic&state=" + encodeURIComponent(params.get("state")), {
    headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] },
    ...(country ? { cf: { country } } : {}),
  });
}
function session(response) {
  const values = response.headers.getSetCookie();
  return values.find((value) => value.startsWith("__Host-foyerdesk-session=")).split(";")[0];
}
const endpoint = "/api/support/messages";
const get = (cookie) => call(endpoint, { headers: { Cookie: cookie } });
const send = (cookie, id, message, loseAck = false) => call(endpoint, { method: "POST", headers: {
  Cookie: cookie, Origin: site, "Content-Type": "application/json",
  ...(loseAck ? { "X-Foyerdesk-Test-Lose-Ack": "1" } : {}),
}, body: JSON.stringify({ requestId: id, message }) });
const checks = [];
// A failed sign-in sends the browser back to the page with a code, never raw JSON, and never sets a session.
function assertSignInError(response, code) {
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("Location"), site).searchParams.get("auth_error"), code);
  assert.equal(response.headers.getSetCookie().some((value) => value.startsWith("__Host-foyerdesk-session=") && !value.includes("Max-Age=0")), false);
}

try {
  assert.equal((await get("")).status, 401);
  verifiedEmail = false;
  assertSignInError(await login(), "email_verification_required");
  verifiedEmail = true;
  const authorized = await login();
  assert.equal(authorized.status, 303, await authorized.clone().text());
  const cookie = session(authorized);
  assert.deepEqual((await (await get(cookie)).json()).messages, []);
  checks.push("Anonymous and unverified sessions denied; verified login opened an empty thread without writing");

  tokenUser = "fixture-unrelated";
  const denied = await login();
  assertSignInError(denied, "test_identity_required");
  tokenUser = owner;
  checks.push("A different Logto subject could not establish a support session");
  const directOf = async (query) => new URL((await call("/api/auth/login" + query)).headers.get("Location")).searchParams.get("direct_sign_in");
  assert.equal(await directOf("?provider=google"), "social:google");
  assert.equal(await directOf("?provider=linkedin"), "social:linkedin");
  for (const other of ["?provider=email", "?provider=facebook", "?provider=social:google", "?provider=", ""]) {
    assert.equal(await directOf(other), null);
  }
  checks.push("Only google and linkedin skip Logto's own page (direct_sign_in); email, unknown and malformed providers show the normal sign-in page");
  const landing = async (query) => {
    const start = await call("/api/auth/login" + query);
    const params = new URL(start.headers.get("Location")).searchParams;
    nonce = params.get("nonce");
    const back = await call("/api/auth/callback?code=synthetic&state=" + encodeURIComponent(params.get("state")), { headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] } });
    return back.headers.get("Location");
  };
  assert.deepEqual([await landing("?returnTo=%2Ftalk"), await landing("?returnTo=%2Fsupport"), await landing("?returnTo=%2Fevil"), await landing("?returnTo=https%3A%2F%2Fevil.invalid"), await landing("")], ["/talk", "/support", "/", "/", "/"]);
  checks.push("After sign-in the visitor returns to /talk or /support only; any other target goes to the home page");
  assert.equal((await call("/api/support/session")).status, 401);
  const me = await (await call("/api/support/session", { headers: { Cookie: cookie } })).json();
  assert.equal(me.account.email, owner + "@example.invalid");
  assert.equal(me.account.provider, "email");
  assert.equal(me.account.name, null);
  checks.push("The signed-in account (email, sign-in method) is returned only to its own session");

  const first = randomUUID();
  assert.equal((await send(cookie, first, "First question", true)).status, 503);
  assert.equal((await send(cookie, first, "First question")).status, 200);
  assert.equal((await send(cookie, first, "Incorrect repeat body")).status, 409);
  assert.equal(writes, 1);
  checks.push("Lost acknowledgement after acceptance and repeated request produced one Chatwoot write");

  const second = randomUUID();
  faults = "lookup_offline";
  assert.equal((await get(cookie)).status, 502);
  assert.equal((await send(cookie, second, "Question during outage")).status, 503);
  assert.equal(writes, 1);
  faults = "none";
  assert.equal((await send(cookie, second, "Question during outage")).status, 200);
  assert.equal(writes, 2);
  checks.push("Chatwoot lookup outage blocked writes; retry after recovery sent the question once");

  const third = randomUUID();
  faults = "chatwoot_committed_then_lost";
  assert.equal((await send(cookie, third, "Committed question")).status, 503);
  faults = "none";
  assert.equal(writes, 3);
  await worker.dispose();
  worker = runtime();
  assert.equal((await send(cookie, third, "Committed question")).status, 200);
  assert.equal(writes, 3);
  checks.push("Worker restart preserved the pending request and reconciled a committed Chatwoot write without resending");

  const blocked = await call("/api/auth/logout", {method:"POST",headers:{Cookie:cookie,Origin:"https://other.invalid"}});
  assert.equal(blocked.status, 403);
  assert.equal((await get(cookie)).status, 200);
  const logout = await call("/api/auth/logout", {method:"POST",headers:{Cookie:cookie,Origin:site}});
  assert.equal(logout.status, 204);
  const marker = logout.headers.getSetCookie()
    .find((value) => value.startsWith("__Host-foyerdesk-reauth=")).split(";")[0];
  const newLogin = await call("/api/auth/login", {headers:{Cookie:marker}});
  assert.equal(new URL(newLogin.headers.get("Location")).searchParams.get("prompt"), "login");

  assert.equal((await get(cookie)).status, 401);
  const beforeVisits = visits;
  assert.equal((await send(cookie, randomUUID(), "Must not send")).status, 401);
  assert.equal(visits, beforeVisits);
  checks.push("Cross-origin logout denied; revoked session could neither read nor send; next login requests an interactive prompt");
  const expiring = session(await login());
  assert.equal((await get(expiring)).status, 200);
  await worker.dispose();
  worker = runtime(31 * 60 * 1000);
  assert.equal((await get(expiring)).status, 401);
  assert.equal((await send(expiring, randomUUID(), "Expired access")).status, 401);
  checks.push("With the fixture clock advanced beyond the idle limit (30 minutes), history and posting were denied");
  // Sliding session: activity keeps it alive, idleness ends it, and 8 hours is the absolute limit.
  await worker.dispose();
  worker = runtime();
  const sliding = session(await login());
  assert.equal((await get(sliding)).status, 200);
  await worker.dispose();
  worker = runtime(20 * 60 * 1000);
  assert.equal((await get(sliding)).status, 200); // used after 20 minutes: extended to 50
  await worker.dispose();
  worker = runtime(45 * 60 * 1000);
  assert.equal((await get(sliding)).status, 200); // alive at 45 minutes, which a fixed 30-minute session would not be
  await worker.dispose();
  worker = runtime(80 * 60 * 1000);
  assert.equal((await get(sliding)).status, 401); // 35 minutes without any use: over
  checks.push("A session that is used stays signed in beyond 30 minutes; 30 minutes without use ends it");
  await worker.dispose();
  worker = runtime();
  const capped = session(await login());
  const cappedStub = (await worker.getDurableObjectNamespace("SUPPORT_SESSIONS")).getByName(capped.split("=")[1].split(".")[0]);
  const t0 = Date.now();
  let at = t0;
  for (let i = 0; i < 17; i += 1) { at += 29 * 60 * 1000; if (at - t0 < 8 * 3600 * 1000) assert.ok(await cappedStub.read(true, at), "alive at " + (at - t0)); }
  assert.equal(await cappedStub.read(true, t0 + 8 * 3600 * 1000 + 1), null);
  checks.push("Constant use cannot keep a session beyond 8 hours");
  await worker.dispose();
  multiUser = true;
  worker = runtime();
  tokenUser = "first-user";
  const firstUser = session(await login());
  tokenUser = "second-user";
  const secondUser = session(await login());
  assert.equal(contacts.length, 2);
  assert.equal(threads.size, 0);
  tokenUser = "email-collision";
  emailOverride = "first-user@example.invalid";
  const collision = await login();
  assertSignInError(collision, "explicit_contact_linking_required");
  assert.equal(contacts.length, 2);
  emailOverride = undefined;
  checks.push("Matching email for a different identity requires explicit linking and creates no contact");

  // The same person with a new verified address keeps the contact; an address that belongs to another contact is never taken.
  tokenUser = "first-user";
  emailOverride = "first-user-new@example.invalid";
  assert.equal((await login()).status, 303);
  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((row) => row.identifier.endsWith(createHash("sha256").update(JSON.stringify([issuer, "first-user"])).digest("hex"))).email, "first-user-new@example.invalid");
  tokenUser = "second-user";
  emailOverride = "first-user-new@example.invalid";
  assertSignInError(await login(), "explicit_contact_linking_required");
  emailOverride = undefined;
  tokenUser = "first-user";
  emailOverride = "first-user@example.invalid"; // back to the original for the tests that follow
  assert.equal((await login()).status, 303);
  emailOverride = undefined;
  checks.push("A person who changed the verified address at the provider keeps their contact (the address follows); an address owned by another contact is refused");

  // Searching reads past the first 15 rows, so an existing contact behind similar addresses is still found and merged, not duplicated.
  for (let i = 0; i < 16; i += 1) contacts.push({ id: 700 + i, email: `x${i}target@example.invalid`, identifier: `other-${i}`, contact_inboxes: [] });
  contacts.push({ id: 750, email: "target@example.invalid", identifier: null, contact_inboxes: [] });
  const countBefore = contacts.length;
  tokenUser = "page-owner";
  emailOverride = "target@example.invalid";
  assert.equal((await login()).status, 303);
  assert.equal(contacts.length, countBefore);
  assert.ok(contacts.find((row) => row.id === 750).identifier.startsWith("acme-"));
  emailOverride = undefined;
  contacts.splice(countBefore - 17, 17); // leave the fixture as the following tests expect it
  checks.push("A contact whose address is on the second page of search results is found and merged instead of duplicated");

  // signed Chatwoot webhook -> "changed" over a WebSocket to the right contact only.
  const signed = (payload, { secret = "synthetic-webhook-secret", at = Math.floor(Date.now() / 1000), raw } = {}) => {
    const body = raw ?? JSON.stringify(payload);
    return call("/api/support/webhook", { method: "POST", body, headers: { "Content-Type": "application/json",
      "X-Chatwoot-Timestamp": String(at), "X-Chatwoot-Signature": "sha256=" + createHmac("sha256", secret).update(`${at}.${body}`).digest("hex") } });
  };
  const open = async (cookie, extra = {}) => {
    const response = await call("/api/support/stream", { headers: { Cookie: cookie, Origin: site, Upgrade: "websocket", ...extra } });
    if (response.status !== 101) return { status: response.status };
    const socket = response.webSocket; socket.accept();
    const received = [];
    socket.addEventListener("message", (event) => received.push(event.data));
    return { status: 101, socket, received };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const reply = (contactId, over = {}) => ({ event: "message_created", message_type: "outgoing", private: false, id: 5001,
    inbox: { id: 4 }, conversation: { inbox_id: 4, meta: { sender: { id: contactId } } }, ...over });
  const firstContact = contacts[0].id, secondContact = contacts[1].id;
  assert.equal((await call("/api/support/stream", { headers: { Upgrade: "websocket", Origin: site } })).status, 401);
  assert.equal((await call("/api/support/stream", { headers: { Cookie: firstUser, Upgrade: "websocket", Origin: "https://other.invalid" } })).status, 403);
  assert.equal((await call("/api/support/stream", { headers: { Cookie: firstUser, Origin: site } })).status, 426);
  const one = await open(firstUser), two = await open(secondUser);
  assert.equal(one.status, 101);
  assert.equal((await signed(reply(firstContact), { secret: "wrong" })).status, 401);
  assert.equal((await signed(reply(firstContact), { at: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  assert.equal((await call("/api/support/webhook", { method: "POST", body: JSON.stringify(reply(firstContact)) })).status, 401);
  assert.equal((await call("/api/support/webhook")).status, 405);
  await settle();
  assert.deepEqual(one.received, []);
  checks.push("Webhook without, with a wrong, or with a stale signature is refused; the stream needs a session, same origin and an upgrade");
  for (const ignored of [reply(firstContact, { private: true }), reply(firstContact, { inbox: { id: 6 }, conversation: { inbox_id: 6, meta: { sender: { id: firstContact } } } }),
    reply(firstContact, { message_type: "incoming" }), reply(firstContact, { event: "message_updated" }), reply(0)]) {
    assert.equal((await signed(ignored)).status, 204);
  }
  await settle();
  assert.deepEqual(one.received, []);
  checks.push("Private notes, other inboxes, the visitor's own messages, other events and unknown contacts wake nobody");
  assert.equal((await signed(reply(firstContact))).status, 204);
  assert.equal((await signed(reply(firstContact, { message_type: "incoming", content_type: "incoming_email" }))).status, 204);
  await settle();
  assert.deepEqual(one.received, ["changed", "changed"]);
  assert.equal((await signed(reply(firstContact, { conversation: { id: 77, inbox_id: 4, meta: { sender: { id: firstContact } } } }))).status, 204);
  await settle();
  assert.equal(one.received.at(-1), "changed:77"); // the page learns which topic changed
  assert.deepEqual(two.received, []);
  one.socket.send("ping"); await settle();
  assert.equal(one.received.at(-1), "pong");
  checks.push("A signed team reply (or emailed reply) tells only that contact's open page; the other contact's page hears nothing; ping is answered");
  // Signing out closes the live channel: a page signed out in another tab hears nothing more.
  let closedWith;
  one.socket.addEventListener("close", (event) => { closedWith = event.code; });
  tokenUser = "first-user";
  const secondSession = session(await login()); // same person, a second session
  assert.equal((await call("/api/auth/logout", { method: "POST", headers: { Cookie: secondSession, Origin: site } })).status, 204);
  await settle();
  assert.equal(closedWith, 4401);
  assert.deepEqual(two.received.filter((m) => m !== "pong"), []); // the other contact's channel is untouched
  checks.push("Signing out closes the contact's open live channel; another contact's channel stays open");
  // A page left open past its session lifetime is closed by the object itself (code 4401), not kept alive indefinitely.
  // The object is called directly: the sandbox does not relay a close made outside a request to the test client,
  // so the check is whether the object still counts the channel as open (notify returns the number of open channels).
  const lifetimeStream = (await worker.getDurableObjectNamespace("SUPPORT_STREAM")).getByName(`inbox-4-contact-${secondContact}`);
  assert.equal(await lifetimeStream.closeExpired(Date.now()), 0);
  assert.equal(await lifetimeStream.notify(), 1);
  assert.equal(await lifetimeStream.closeExpired(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(await lifetimeStream.notify(), 0);
  assert.equal(await lifetimeStream.closeExpired(Date.now() + 31 * 60 * 1000), 0);
  checks.push("A live channel is closed once the session it was opened with has expired; before that it stays open");
  one.socket.close(); two.socket.close();
  contacts.push({ id: 900, email: "legacy@example.invalid", identifier: null, additional_attributes: { city: "Cairo", created_at_ip: "203.0.113.5" }, contact_inboxes: [{ inbox: { id: 2 }, source_id: "w" }] });
  const before = contacts.length;
  tokenUser = "legacy-owner";
  emailOverride = "legacy@example.invalid";
  assert.equal((await login("US")).status, 303);
  assert.equal(contacts.length, before);
  assert.ok(contacts.find((row) => row.id === 900).identifier.startsWith("acme-"));
  const legacySession = session(await (async () => { const r = await login("US"); return r; })());
  assert.deepEqual((await (await get(legacySession)).json()).messages.map(row => row.text), ["Old question", "Old answer", "New question"]);
  // Long history: Chatwoot returns 20 messages per request, the page must still reach every message.
  const stamp = (id, conversation) => ({ id, message_type: 0, content: "msg " + id, private: false, conversation_id: conversation, created_at: 1700000000 + id });
  bulk.set(1001, Array.from({ length: 30 }, (_, i) => stamp(100 + i, 1001)));
  bulk.set(1002, Array.from({ length: 45 }, (_, i) => stamp(200 + i, 1002)));
  const pageOf = async (query = "") => (await call(endpoint + query, { headers: { Cookie: legacySession } })).json();
  let current = await pageOf();
  assert.deepEqual(current.messages.map((row) => row.id), Array.from({ length: 20 }, (_, i) => 225 + i));
  assert.equal(current.hasMore, true);
  const collected = [...current.messages];
  for (let guard = 0; current.hasMore && guard < 20; guard++) {
    current = await pageOf("?before=" + collected[0].id);
    collected.unshift(...current.messages);
  }
  assert.equal(current.hasMore, false);
  assert.deepEqual(collected.map((row) => row.id), [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 45 }, (_, i) => 200 + i)]);
  checks.push("A 75-message history across two conversations is read completely, page by page, in order, without gaps or repeats");
  assert.deepEqual((await pageOf("?after=244")).messages, []);
  bulk.get(1002).push(stamp(245, 1002));
  assert.deepEqual((await pageOf("?after=244")).messages.map((row) => row.id), [245]);
  checks.push("The refresh asks only for messages after the last one it has");
  for (const bad of ["?before=abc", "?after=-1", "?before=1&after=x", "?before=99999999999"]) {
    assert.equal((await call(endpoint + bad, { headers: { Cookie: legacySession } })).status, 400);
  }
  checks.push("Invalid paging cursors are rejected");
  bulk.clear();
  const legacyAttrs = () => contacts.find((row) => row.id === 900).additional_attributes;
  assert.equal(legacyAttrs().country_code, "US");
  assert.equal(legacyAttrs().country, "United States");
  assert.equal(legacyAttrs().city, "Cairo");
  assert.equal(legacyAttrs().created_at_ip, "203.0.113.5");
  checks.push("Sign-in country is stored on the contact and the attributes Chatwoot already had are kept");
  const countryWritesBefore = countryWrites;
  assert.equal((await login("US")).status, 303);
  assert.equal(countryWrites, countryWritesBefore);
  checks.push("A repeat sign-in from the same country writes nothing");
  assert.equal((await login("EG")).status, 303);
  assert.equal(legacyAttrs().country_code, "EG");
  assert.equal(legacyAttrs().city, "Cairo");
  checks.push("Sign-in from another country updates the stored country");
  for (const odd of ["XX", "T1", "egypt", "E"]) {
    assert.equal((await login(odd)).status, 303);
    assert.equal(legacyAttrs().country_code, "EG");
  }
  checks.push("Unknown or malformed country values are never stored");
  faults = "country_write_fails";
  assert.equal((await login("DE")).status, 303);
  faults = "none";
  assert.equal(legacyAttrs().country_code, "EG");
  checks.push("A failed country write does not block sign-in");
  profileClaims = true;
  const richLogin = await login("EG", "linkedin");
  assert.equal(richLogin.status, 303);
  const richMe = await (await call("/api/support/session", { headers: { Cookie: session(richLogin) } })).json();
  assert.deepEqual(richMe.account, { name: "Alex Example", email: "legacy@example.invalid", provider: "linkedin", picture: "https://img.example.invalid/a.png" });
  checks.push("The session reports the name, email and sign-in method the provider gave");
  const rich = contacts.find((row) => row.id === 900);
  assert.equal(rich.name, "Alex Example");
  assert.equal(rich.custom_attributes.first_source, "linkedin");
  assert.equal(rich.custom_attributes.last_source, "linkedin");
  assert.equal(rich.custom_attributes.login_provider, "linkedin");
  assert.equal(rich.custom_attributes.preferred_language, "en-US");
  assert.equal(rich.avatar_url, undefined); // the provider's picture address is never handed to Chatwoot to download
  assert.ok(sentScope.split(" ").includes("profile") && sentScope.split(" ").includes("identities"));
  checks.push("Sign-in from ?src=linkedin stores source, provider, language and name on the contact (not the picture address)");
  assert.equal((await login("EG", "newsletter")).status, 303);
  assert.equal(rich.custom_attributes.first_source, "linkedin");
  assert.equal(rich.custom_attributes.last_source, "newsletter");
  checks.push("The first source is never overwritten; the last source follows the latest visit");
  assert.equal((await login("EG", "<bad>")).status, 303);
  assert.equal(rich.custom_attributes.last_source, "newsletter");
  checks.push("An invalid source value is ignored");
  rich.name = "Human Edited";
  assert.equal((await login("EG", "linkedin")).status, 303);
  assert.equal(rich.name, "Human Edited");
  checks.push("A name edited by the team is never replaced");
  profileClaims = false;
  assert.equal((await login("EG", "linkedin")).status, 303);
  assert.equal(rich.custom_attributes.login_provider, "email");
  checks.push("A sign-in without a social identity is recorded as login_provider=email");
  emailOverride = undefined;
  checks.push("A contact with a resolved and an open conversation sees both in order instead of an error");
  checks.push("Verified email of an identifier-less legacy contact links that contact without creating a duplicate");

  // Reusing a request UUID across separate identities must not share deduplication state.
  const sharedRequestId = randomUUID();
  assert.equal((await send(firstUser, sharedRequestId, "First user's question")).status, 200);
  assert.equal((await send(secondUser, sharedRequestId, "Second user's question")).status, 200);
  assert.equal(threads.size, 2);
  assert.deepEqual((await (await get(firstUser)).json()).messages.map(row => row.text), ["First user's question"]);
  assert.deepEqual((await (await get(secondUser)).json()).messages.map(row => row.text), ["Second user's question"]);
  tokenUser = "first-user";
  const firstAgain = session(await login());
  assert.equal(contacts.length, 3);
  assert.deepEqual((await (await get(firstAgain)).json()).messages.map(row => row.text), ["First user's question"]);
  checks.push("Two identities use separate contacts, conversations and request ledgers; repeat login reuses the first contact");
  // Reading an operator reply on the page marks the conversation as seen once, so no email is sent for it.
  const firstThread = [...threads.values()][0];
  firstThread.messages.push({ id: 9000, message_type: 0, content_type: "incoming_email", private: false, conversation_id: firstThread.id,
    content: "Thanks\n\nOn Mon, Operator wrote:\n> Operator answer", content_attributes: { email: { text_content: { reply: "Thanks" } } } });
  firstThread.messages.push({ id: 9001, message_type: 1, content: "Operator answer", private: false, conversation_id: firstThread.id });
  assert.equal(seenCalls.length, 0);
  await get(firstAgain); await get(firstAgain);
  assert.equal(seenCalls.length, 1);
  assert.ok(seenCalls[0].endsWith(`/conversations/${firstThread.id}/update_last_seen`));
  checks.push("Reading an operator reply on the page marks it seen exactly once");
  const texts = (await (await get(firstAgain)).json()).messages.map((row) => row.text);
  assert.ok(texts.includes("Thanks") && !texts.some((text) => text.includes("wrote:")));
  checks.push("An email reply is shown without its quoted history");
  firstThread.messages.push({ id: 9003, message_type: 1, content: "Hello from the team", private: false, conversation_id: firstThread.id,
    created_at: 1795443380, sender: { type: "user", name: "Stan Ishchenko", available_name: "Stan Ishchenko" } });
  firstThread.messages.push({ id: 9004, message_type: 1, content: "Automation note", private: false, conversation_id: firstThread.id,
    created_at: 1795443390, sender: { type: "user", name: "API User", available_name: "API User" } });
  const withAuthors = (await (await get(firstAgain)).json()).messages;
  assert.deepEqual(withAuthors.find((row) => row.id === 9003), { id: 9003, text: "Hello from the team", direction: "support", at: 1795443380, author: "Stan" });
  assert.equal(withAuthors.find((row) => row.id === 9004).author, null);
  checks.push("Messages carry their time and the replying team member's first name; the service account is never shown as a person");
  firstThread.messages.splice(firstThread.messages.findIndex((row) => row.id === 9003), 2);
  firstThread.messages.push({ id: 9002, message_type: 3, content: "We are offline, but we will reply", private: false, conversation_id: firstThread.id });
  const withOffline = (await (await get(firstAgain)).json()).messages;
  assert.deepEqual(withOffline.at(-1), { id: 9002, text: "We are offline, but we will reply", direction: "support", at: null, author: null });
  checks.push("The automatic out-of-office message (Chatwoot template message) is shown to the customer as a support message");

  // Operator deletes a contact in Chatwoot while its browser session is still alive.
  tokenUser = "second-user";
  contacts.splice(contacts.findIndex((row) => row.identifier === contacts.at(1).identifier), 1);
  const gone = await get(secondUser);
  assert.equal(gone.status, 401);
  assert.equal((await get(secondUser)).status, 401);
  assert.equal((await send(secondUser, randomUUID(), "After delete")).status, 401);
  const recreated = session(await login());
  assert.equal((await get(recreated)).status, 200);
  checks.push("A contact deleted in Chatwoot ends the browser session with 401 and a fresh login provisions a new contact");

  // ---- topics (several conversations per customer, only through the Chatwoot API) ----
  topicMode = true;
  const asJson = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
  const api = (cookie, path, init = {}) => call("/api/support/topics" + path, { ...init, headers: { Cookie: cookie, Origin: site, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const post = (cookie, path, body) => api(cookie, path, { method: "POST", body: JSON.stringify(body) });
  tokenUser = "topic-a";
  const topicA = session(await login());
  const contactA = contacts.find((row) => row.identifier && row.contact_inboxes.length && contacts.indexOf(row) === contacts.length - 1).id;
  tokenUser = "topic-b";
  const topicB = session(await login());
  const contactB = contacts.at(-1).id;
  assert.notEqual(contactA, contactB);
  assert.equal((await call("/api/support/topics")).status, 401);
  assert.equal((await call("/api/support/topics", { method: "POST", headers: { Cookie: topicA, Origin: "https://other.invalid" }, body: "{}" })).status, 403);
  assert.deepEqual(await asJson(await api(topicA, "")), { status: 200, body: { topics: [], page: 1, pages: 1, total: 0 } });
  const r1 = randomUUID(), r2 = randomUUID(), r3 = randomUUID();
  const firstTopic = await asJson(await post(topicA, "", { requestId: r1, subject: "Billing question", message: "I was charged twice" }));
  assert.equal(firstTopic.status, 201);
  const secondTopic = await asJson(await post(topicA, "", { requestId: r2, message: "How do I get my certificate?" }));
  assert.equal(secondTopic.status, 201);
  assert.equal(topicRows.length, 2);
  assert.equal(topicRows[1].custom_attributes.subject, "How do I get my certificate?");
  checks.push("A customer opens two topics; the subject is given or taken from the first line; each is one Chatwoot conversation of that contact");
  const repeat = await asJson(await post(topicA, "", { requestId: r1, subject: "Billing question", message: "I was charged twice" }));
  assert.deepEqual([repeat.status, repeat.body.id, topicRows.length], [200, firstTopic.body.id, 2]);
  assert.equal((await post(topicA, "", { requestId: r1, subject: "Billing question", message: "Different text" })).status, 409);
  assert.equal((await post(topicA, "", { requestId: "not-a-uuid", message: "x".repeat(10) })).status, 400);
  assert.equal((await post(topicA, "", { requestId: r3, message: "   " })).status, 400);
  assert.equal((await post(topicA, "", { requestId: r3, message: "x".repeat(3001) })).status, 400);
  assert.equal((await post(topicA, "", { requestId: r3, message: "ok" })).status, 400);
  assert.equal(topicRows.length, 2);
  checks.push("The same request id returns the same topic without a second conversation; a changed body, bad id, empty, over-long or subject-less short text is refused");
  topicFault = "create_committed_then_lost";
  const lostId = randomUUID();
  assert.equal((await post(topicA, "", { requestId: lostId, message: "Lost answer topic" })).status, 503);
  assert.equal(topicRows.length, 3);
  topicFault = "none";
  const found = await asJson(await post(topicA, "", { requestId: lostId, message: "Lost answer topic" }));
  assert.deepEqual([found.status, found.body.id, topicRows.length], [200, topicRows[2].id, 3]);
  checks.push("A topic that Chatwoot created but whose answer was lost is found again by the retry: no duplicate conversation");
  const listed = (await asJson(await api(topicA, "?tab=open"))).body;
  assert.deepEqual(listed.topics.map((t) => t.id), [topicRows[2].id, topicRows[1].id, topicRows[0].id]);
  assert.deepEqual(Object.keys(listed).sort(), contract.list);                 // the screens depend on exactly these fields
  assert.deepEqual(Object.keys(listed.topics[0]).sort(), contract.listItem);
  assert.equal(listed.topics.at(-1).subject, "Billing question");
  assert.equal(listed.topics[0].status, "Open");
  assert.equal(listed.total, 3);
  assert.deepEqual((await asJson(await api(topicA, "?tab=resolved"))).body.topics, []);
  assert.deepEqual((await asJson(await api(topicB, ""))).body.topics, []);
  for (const bad of ["?tab=everything", "?page=0", "?page=abc", "?tab=open&page=99999"]) assert.equal((await api(topicA, bad)).status, 400);
  checks.push("The list is newest activity first, split into Open and Resolved tabs, scoped to the signed-in contact; bad tab or page is a 400");
  const mine = firstTopic.body.id;
  const msgs = (await asJson(await api(topicA, `/${mine}/messages`))).body;
  assert.deepEqual(msgs.messages.map((m) => [m.direction, m.text]), [["visitor", "I was charged twice"]]);
  assert.deepEqual([msgs.topic.subject, msgs.topic.status, msgs.topic.actions], ["Billing question", "Open", ["reply", "resolve"]]);
  assert.deepEqual(Object.keys(msgs).sort(), contract.messages);
  assert.deepEqual(Object.keys(msgs.messages[0]).sort(), contract.message);
  assert.deepEqual(Object.keys(msgs.topic).sort(), contract.topic);
  for (const path of [`/${mine}/messages`, `/${mine}/resolve`, `/${mine}/reopen`]) {
    const foreign = path.endsWith("messages") ? await api(topicB, path) : await post(topicB, path, {});
    assert.equal(foreign.status, 404, path);
    assert.deepEqual(await foreign.json(), { error: "topic_not_found" });
  }
  assert.equal((await post(topicB, `/${mine}/messages`, { requestId: randomUUID(), message: "I am not the owner" })).status, 404);
  assert.equal((await api(topicA, "/99999/messages")).status, 404);
  assert.equal((await api(topicA, "/abc/messages")).status, 404);
  assert.equal(topicRows.find((r) => r.id === mine).messages.length, 1);
  assert.equal(topicRows.find((r) => r.id === mine).status, "open");
  checks.push("Another customer reading, writing to, closing or reopening someone else's topic gets the same 'not found' as a missing topic, and nothing changes");
  const rep = randomUUID();
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: rep, message: "Any update?" })).status, 200);
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: rep, message: "Any update?" })).status, 200);
  assert.equal(topicRows.find((r) => r.id === mine).messages.filter((m) => m.content === "Any update?").length, 1);
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: rep, message: "Other" })).status, 409);
  topicFault = "reply_committed_then_lost";
  const repLost = randomUUID();
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: repLost, message: "Reply with lost answer" })).status, 503);
  topicFault = "none";
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: repLost, message: "Reply with lost answer" })).status, 200);
  assert.equal(topicRows.find((r) => r.id === mine).messages.filter((m) => m.content === "Reply with lost answer").length, 1);
  checks.push("A reply is written once even when the request is repeated or the answer was lost");
  // The marker of a lost reply may sit further back than Chatwoot's first page of 20 messages.
  // Another customer is used so the first customer's write allowance stays as the later tests expect; the topic is removed afterwards.
  const deepTopic = (await asJson(await post(topicB, "", { requestId: randomUUID(), message: "Topic for the buried reply" }))).body.id;
  topicFault = "reply_committed_then_lost";
  const repDeep = randomUUID();
  assert.equal((await post(topicB, `/${deepTopic}/messages`, { requestId: repDeep, message: "Reply buried later" })).status, 503);
  topicFault = "none";
  const deepRow = topicRows.find((r) => r.id === deepTopic);
  for (let i = 0; i < 25; i += 1) deepRow.messages.push({ id: deepRow.messages.length + 1, message_type: 1, content: "Team note " + i, private: false });
  assert.equal((await post(topicB, `/${deepTopic}/messages`, { requestId: repDeep, message: "Reply buried later" })).status, 200);
  assert.equal(deepRow.messages.filter((m) => m.content === "Reply buried later").length, 1);
  topicRows.splice(topicRows.indexOf(deepRow), 1);
  checks.push("A repeated reply finds its marker even when 25 other messages arrived after it, so it is not written twice");
  const closed = await asJson(await post(topicA, `/${mine}/resolve`, {}));
  assert.deepEqual([closed.status, closed.body.status, closed.body.actions], [200, "Resolved", ["reply", "reopen"]]);
  assert.deepEqual(Object.keys(closed.body).sort(), contract.statusChange);
  const closedAgain = await asJson(await post(topicA, `/${mine}/resolve`, {}));
  assert.deepEqual([closedAgain.status, closedAgain.body.repeated], [200, true]);
  assert.equal(topicRows.find((r) => r.id === mine).messages.filter((m) => m.content === "Status changed").length, 1);
  assert.deepEqual((await asJson(await api(topicA, "?tab=resolved"))).body.topics.map((t) => [t.id, t.status]), [[mine, "Resolved"]]);
  const history = (await asJson(await api(topicA, ""))).body; // default tab is the whole history
  assert.equal(history.total, 3);
  assert.deepEqual(history.topics.find((t) => t.id === mine).status, "Resolved");
  assert.equal((await asJson(await api(topicA, "?tab=all"))).body.total, 3);
  assert.equal((await asJson(await api(topicA, "?tab=open"))).body.total, 2);
  assert.equal((await asJson(await api(topicA, `/${mine}/messages`))).body.messages.every((m) => m.text !== "Status changed" && m.text !== "Conversation was reopened"), true);
  const reopened = await asJson(await post(topicA, `/${mine}/reopen`, {}));
  assert.deepEqual([reopened.status, reopened.body.status], [200, "Open"]);
  assert.equal((await post(topicA, `/${mine}/archive`, {})).status, 404);
  await post(topicA, `/${mine}/resolve`, {});
  assert.equal((await post(topicA, `/${mine}/messages`, { requestId: randomUUID(), message: "Back to this topic" })).status, 200);
  assert.equal(topicRows.find((r) => r.id === mine).status, "open");
  checks.push("A topic can be closed and reopened (repeat is harmless), moves between tabs, activity messages are never shown, and writing into a closed topic brings it back");
  for (let i = 0; i < 7; i += 1) assert.equal((await post(topicA, "", { requestId: randomUUID(), message: `Extra topic number ${i}` })).status, 201);
  assert.equal(topicRows.filter((r) => r.contactId === contactA && r.status !== "resolved").length, 10);
  const over = await post(topicA, "", { requestId: randomUUID(), message: "One topic too many" });
  assert.equal(over.status, 429);
  assert.equal((await post(topicB, "", { requestId: randomUUID(), message: "Other customer is not limited" })).status, 201);
  await post(topicA, `/${mine}/resolve`, {});
  assert.equal((await post(topicA, "", { requestId: randomUUID(), message: "Room again after closing one" })).status, 201);
  checks.push("Ten unresolved topics is the limit per customer; closing one makes room; the limit is per customer");
  for (let i = 0; i < 30; i += 1) topicRows.push({ id: 9000 + i, contactId: contactB, inbox_id: 4, status: "open", custom_attributes: { subject: `Bulk ${i}` }, messages: [{ id: 1, message_type: 0, content: "x", private: false }], last_activity_at: ++topicClock });
  const p1 = (await asJson(await api(topicB, "?tab=open&page=1"))).body, p2 = (await asJson(await api(topicB, "?tab=open&page=2"))).body;
  assert.deepEqual([p1.topics.length, p2.topics.length, p1.pages, p1.total], [25, 6, 2, 31]);
  assert.equal(new Set([...p1.topics, ...p2.topics].map((t) => t.id)).size, 31);
  checks.push("A customer with more than 25 topics reaches all of them page by page (the Chatwoot per-contact list cap is avoided)");
  // A contact deleted in Chatwoot: starting a topic ends the session instead of failing forever.
  tokenUser = "gone-user";
  const goneCookie = session(await login());
  topicFault = "contact_deleted";
  assert.equal((await post(goneCookie, "", { requestId: randomUUID(), message: "Anyone there?" })).status, 401);
  topicFault = "none";
  assert.equal((await api(goneCookie, "")).status, 401);
  checks.push("When Chatwoot reports the contact gone while a topic is started, the session is ended");
  // The idempotency records are kept 48 hours, then removed: nothing grows without limit.
  const ledgerKey = JSON.stringify([contacts.find((row) => row.id === contactA).identifier, 4]);
  await worker.dispose();
  worker = runtime();
  assert.equal(await (await worker.getDurableObjectNamespace("FULL_PAGE_THREAD")).getByName(ledgerKey).purge(), 0);
  await worker.dispose();
  worker = runtime(49 * 3600 * 1000);
  assert.ok(await (await worker.getDurableObjectNamespace("FULL_PAGE_THREAD")).getByName(ledgerKey).purge() > 0);
  checks.push("Request records are kept for 48 hours and then purged (none removed at once, all old ones removed after 49 hours)");
  topicMode = false;
  console.log(JSON.stringify({ status: "PASS", scope: "Local Worker runtime with simulated upstream Logto and Chatwoot", checks }, null, 2));
} finally {
  await worker.dispose();
  await rm(persistence, { recursive: true, force: true });
}
