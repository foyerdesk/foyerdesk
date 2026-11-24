import { expect, test } from "@playwright/test";
import { mockApi, msg, row } from "./mock.mjs";

const open = (page, path = "/") => page.goto(path);
const many = (n, over = {}) => Array.from({ length: n }, (_, i) => row(i + 1, over));

test("guest: one Sign in link, the reason, no topics and no timer checks", async ({ page }) => {
  await page.clock.install();
  const api = await mockApi(page, { signedIn: false });
  await open(page, "/?auth_error=oidc_validation_failed");
  await expect(page.getByTestId("sign-in-panel")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/api/auth/login?returnTo=%2Ftalk");
  await expect(page.getByTestId("guest-title")).toHaveText("Sign-in could not be completed");
  await expect(page.getByTestId("guest-notice")).toHaveText("Please try again.");
  expect(page.url()).not.toContain("auth_error");
  const before = api.calls.length;
  await page.clock.runFor(900_000);
  expect(api.calls.length).toBe(before);
  expect(api.sockets.length).toBe(0);
});

test("signed in: account card, recent topics with 'View all', topics table with status badges", async ({ page }) => {
  const api = await mockApi(page, { topics: [...many(7), row(8, { status: "Pending", subject: "Billing", preview: "Charged twice" })] });
  await open(page);
  await expect(page.getByTestId("account-card")).toContainText("Alex Example");
  await expect(page.getByTestId("account-card")).toContainText("alex@example.com");
  await expect(page.getByTestId("account-provider")).toHaveText("via Google");
  await expect(page.getByTestId("recent-item")).toHaveCount(5);
  await expect(page.getByTestId("view-all")).toHaveText("View all (8)");
  await expect(page.getByTestId("topic-row")).toHaveCount(8);
  await expect(page.getByTestId("topic-row").filter({ hasText: "Billing" })).toContainText("Pending");
  await expect(page.getByTestId("topic-row").filter({ hasText: "Billing" })).toContainText("Charged twice");
  expect(api.sockets.length).toBe(1);
});

test("list: 25 per page with Previous and Next, and a Resolved tab", async ({ page }) => {
  await mockApi(page, { topics: [...many(30), row(100, { status: "Resolved", tab: "resolved", subject: "Old and solved" })] });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(25);
  await expect(page.getByTestId("page-of")).toHaveText("Page 1 of 2");
  await expect(page.getByTestId("prev")).toBeDisabled();
  await page.getByTestId("next").click();
  await expect(page.getByTestId("topic-row")).toHaveCount(6); // 31 topics in the whole history
  await expect(page.getByTestId("page-of")).toHaveText("Page 2 of 2");
  await expect(page.getByTestId("next")).toBeDisabled();
  await page.getByTestId("tab-resolved").click();
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  await expect(page.getByTestId("topic-row")).toContainText("Old and solved");
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("topic-row")).toHaveCount(25);
  await expect(page.getByTestId("page-of")).toHaveText("Page 1 of 2");
});

test("list: empty states say what to do", async ({ page }) => {
  await mockApi(page, { topics: [] });
  await open(page, "/#/"); // the plain address would go to the new-topic form for a visitor with no topics
  await expect(page.getByTestId("empty")).toContainText("No topics yet");
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("empty")).toContainText("No open topics");
  await page.getByTestId("tab-resolved").click();
  await expect(page.getByTestId("empty")).toContainText("No resolved topics yet");
});

test("new topic: subject optional, a lost answer then a retry reuses one request id, then the topic opens", async ({ page }) => {
  const api = await mockApi(page, { topics: [] });
  await open(page, "/#/new");
  await page.getByLabel("Your question").fill("How do I get my certificate?\nSecond line");
  api.createFault = "lost";
  await page.getByTestId("create").click();
  await expect(page.getByTestId("form-error")).toContainText("Delivery is unconfirmed");
  await expect(page.getByLabel("Your question")).toHaveValue("How do I get my certificate?\nSecond line");
  await page.getByTestId("create").click();
  await expect(page).toHaveURL(/#\/topic\/900$/);
  const ids = api.posts.filter((p) => p.path === "/topics").map((p) => p.body.requestId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(api.posts[0].body.subject).toBeUndefined();
  await expect(page.getByTestId("topic-title")).toHaveText("How do I get my certificate?");
});

test("new topic: empty text is refused on the page, server limits are explained", async ({ page }) => {
  const api = await mockApi(page, { topics: [] });
  await open(page, "/#/new");
  await page.getByTestId("create").click();
  await expect(page.getByTestId("form-error")).toHaveText("Please write your question.");
  expect(api.posts).toHaveLength(0);
  api.createFault = "limit";
  await page.getByLabel("Your question").fill("One more");
  await page.getByTestId("create").click();
  await expect(page.getByTestId("form-error")).toContainText("10 open topics");
});

test("topic: newest message in view, own scroll keeps the composer on screen, reply is sent once", async ({ page }) => {
  const list = Array.from({ length: 60 }, (_, i) => msg(i + 1, i % 2 ? "support" : "visitor", `Message ${i + 1}`));
  const api = await mockApi(page, { topics: [row(5, { subject: "Long one" })], messages: { 5: list } });
  await open(page, "/#/topic/5");
  await expect(page.getByText("Message 60", { exact: true })).toBeInViewport();
  const box = await page.getByTestId("send").boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
  const thread = page.getByTestId("thread");
  expect(await thread.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByLabel("Reply", { exact: true }).fill("Thanks!");
  await page.getByTestId("send").click();
  await expect(page.getByText("Thanks!", { exact: true })).toBeInViewport();
  expect(api.posts.filter((p) => p.path.endsWith("/messages"))).toHaveLength(1);
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("");
});

test("topic: Mark as resolved turns into Reopen, the topic moves between tabs", async ({ page }) => {
  await mockApi(page, { topics: [row(5)], messages: { 5: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/5");
  await expect(page.getByTestId("topic-status")).toHaveText("Open");
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("topic-status")).toHaveText("Resolved");
  await expect(page.getByTestId("reopen")).toBeVisible();
  await expect(page.getByTestId("resolve")).toHaveCount(0);
  await page.getByRole("link", { name: "Back" }).click();
  // a closed topic stays in the history: it is still in the list and in the side panel, marked Resolved
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  await expect(page.getByTestId("topic-row")).toContainText("Resolved");
  await expect(page.getByTestId("recent-item")).toHaveCount(1);
  await expect(page.getByTestId("recent-status")).toHaveText("Resolved");
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("empty")).toContainText("No open topics");
  await page.getByTestId("tab-resolved").click();
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  await page.getByTestId("topic-row").getByRole("link").click();
  await expect(page.getByText("Hi", { exact: true })).toBeVisible(); // its messages are still there
  await page.getByTestId("reopen").click();
  await expect(page.getByTestId("topic-status")).toHaveText("Open");
});

test("topic: older messages load on demand without losing the reading place", async ({ page }) => {
  const list = Array.from({ length: 45 }, (_, i) => msg(i + 1, i % 2 ? "support" : "visitor", `Message ${i + 1}`));
  await mockApi(page, { topics: [row(5)], messages: { 5: list } });
  await open(page, "/#/topic/5");
  await expect(page.getByText("Message 45", { exact: true })).toBeInViewport();
  await page.getByTestId("thread").evaluate((el) => { el.scrollTop = 0; });
  await page.getByTestId("load-earlier").click();
  await expect(page.getByText("Message 24", { exact: true })).toBeAttached();
  await expect(page.getByText("Message 26", { exact: true })).toBeInViewport(); // still where the reader was
});

test("unread: dot in the side panel and the table, badge, tab title; opening the topic clears them", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { unread: true, subject: "Waiting for you" }), row(2)], messages: { 1: [msg(1, "visitor", "Q"), msg(2, "support", "A")] } });
  await open(page);
  await expect(page.getByTestId("unread-badge")).toHaveText("1 new reply");
  await expect(page.getByTestId("unread-dot")).toHaveCount(1);
  await expect(page.getByTestId("row-unread")).toHaveCount(1);
  await expect(page).toHaveTitle(/^\(1\) /);
  await page.getByTestId("topic-row").filter({ hasText: "Waiting for you" }).getByRole("link").click();
  await expect(page.getByText("A", { exact: true })).toBeVisible();
  await expect(page.getByTestId("unread-badge")).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\(1\) /);
});

test("push: 'changed:<id>' shows the new reply in that open topic and ignores other topics", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(5), row(6)], messages: { 5: [msg(1, "visitor", "Q")], 6: [msg(1, "visitor", "Other")] } });
  await open(page, "/#/topic/5");
  await expect(page.getByText("Q", { exact: true })).toBeVisible();
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.waitForTimeout(1100);
  api.messages[5].push(msg(2, "support", "The team replied"));
  const before = api.calls.filter((c) => c.includes("/topics/5/messages")).length;
  api.sockets[0].send("changed:6");
  await page.waitForTimeout(400);
  expect(api.calls.filter((c) => c.includes("/topics/5/messages")).length).toBe(before);
  await page.waitForTimeout(1100);
  api.sockets[0].send("changed:5");
  await expect(page.getByText("The team replied", { exact: true })).toBeInViewport();
  expect(api.calls.at(-1) + api.calls.join()).toContain("after=1");
});

test("a reply that arrives while reading older messages shows 'New message' instead of moving the page", async ({ page }) => {
  const list = Array.from({ length: 40 }, (_, i) => msg(i + 1, i % 2 ? "support" : "visitor", `Message ${i + 1}`));
  const api = await mockApi(page, { topics: [row(5)], messages: { 5: list } });
  await open(page, "/#/topic/5");
  await expect(page.getByText("Message 40", { exact: true })).toBeInViewport();
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.getByTestId("thread").evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(1100);
  api.messages[5].push(msg(41, "support", "Fresh answer"));
  api.sockets[0].send("changed:5");
  await expect(page.getByTestId("new-message")).toBeVisible();
  await expect(page.getByText("Fresh answer", { exact: true })).not.toBeInViewport();
  await page.getByTestId("new-message").click();
  await expect(page.getByText("Fresh answer", { exact: true })).toBeInViewport();
});

test("text from the server is shown as text: markup in subject, preview and messages does nothing", async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  await mockApi(page, { topics: [row(5, { subject: evil, preview: evil })], messages: { 5: [msg(1, "support", evil)] }, account: { name: evil, email: evil, provider: evil } });
  await open(page);
  await expect(page.getByTestId("topic-row")).toContainText("<img src=x");
  await page.getByTestId("topic-row").getByRole("link").click();
  await expect(page.getByTestId("message")).toContainText("<script>");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator("img[src='x'], .fd script").count()).toBe(0);
});

test("sign out: notice and focus, the live connection closes, nothing is asked afterwards", async ({ page }) => {
  await page.clock.install();
  const api = await mockApi(page);
  await open(page);
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  await expect(page.getByTestId("guest-notice")).toHaveText("Your conversation is saved and will be here when you sign in again.");
  await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByTestId("guest-title")).toBeFocused();
  expect(new URL(page.url()).hash).toBe(""); // no stale "#/topic/..." in the address
  await expect.poll(() => api.sockets[0].closed).toBe(true);
  const calls = api.calls.length;
  await page.clock.runFor(900_000);
  expect(api.calls.length).toBe(calls);
  expect(api.sockets.length).toBe(1);
});

test("sign out: a refresh that was already running cannot bring the dashboard back", async ({ page }) => {
  const api = await mockApi(page);
  let slow = false;
  await page.route("**/api/support/topics?**", async (route) => { if (slow) await new Promise((r) => setTimeout(r, 1200)); await route.fallback(); });
  await open(page);
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.waitForTimeout(1100);
  slow = true;
  api.sockets[0].send("changed");
  await page.waitForTimeout(200);
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  await page.waitForTimeout(2200);
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  await expect(page.getByTestId("account-card")).toHaveCount(0);
});

test("session ends in the background: the next check shows the sign-in panel with the right reason", async ({ page }) => {
  const api = await mockApi(page);
  await open(page);
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.waitForTimeout(1100);
  api.signedIn = false;
  api.sockets[0].send("changed");
  await expect(page.getByTestId("guest-title")).toHaveText("Your session ended");
  await expect(page.getByTestId("guest-notice")).toHaveText("Sign in to continue.");
  await expect.poll(() => api.sockets[0].closed).toBe(true);
});

test("timers: with the connection open a 10-minute idle page makes at most two safety checks; a hidden tab none; without a connection every 20 s", async ({ page }) => {
  await page.clock.install();
  const api = await mockApi(page);
  await open(page);
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.waitForTimeout(300);
  let before = api.calls.length;
  await page.clock.runFor(600_000); await page.waitForTimeout(400);
  expect(api.calls.filter((c, i) => i >= before && c.startsWith("GET /topics")).length).toBeLessThanOrEqual(6);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  before = api.calls.length;
  await page.clock.runFor(600_000); await page.waitForTimeout(300);
  expect(api.calls.length).toBe(before);
});

test("unknown topic: a clear message and no composer", async ({ page }) => {
  await mockApi(page, { topics: [] });
  await open(page, "/#/topic/77");
  await expect(page.getByTestId("topic-error")).toHaveText("This topic was not found.");
  await expect(page.getByTestId("send")).toBeHidden();
});

test("support unreachable: a calm message, not a sign-in panel", async ({ page }) => {
  await page.route("**/api/support/**", (route) => route.fulfill({ status: 502, json: {} }));
  await open(page);
  await expect(page.getByTestId("unavailable")).toBeVisible();
  await expect(page.getByTestId("sign-in-panel")).toHaveCount(0);
});

test("destroy: listeners and timers are removed, the live connection closes, the tab title is restored", async ({ page }) => {
  await page.clock.install();
  const api = await mockApi(page, { topics: [row(1, { unread: true })] });
  await open(page);
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect.poll(() => api.sockets.length).toBe(1);
  await page.evaluate(() => window.__fd.destroy());
  await expect(page).toHaveTitle("Support");
  await expect.poll(() => api.sockets[0].closed).toBe(true);
  const calls = api.calls.length;
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pointerdown")); window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await page.clock.runFor(900_000);
  expect(api.calls.length).toBe(calls);
  await expect(page.locator(".fd")).toHaveCount(0);
});

test("a 200 answer that is not JSON (an error page, a missing route) is treated as unreachable, never as data", async ({ page }) => {
  await page.route("**/api/support/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>shell</html>" }));
  await open(page);
  await expect(page.getByTestId("unavailable")).toBeVisible();
  await expect(page.getByTestId("topic-list")).toHaveCount(0);
});

test("a 200 topics answer without the expected JSON does not break the list", async ({ page }) => {
  await page.route("**/api/support/session", (route) => route.fulfill({ json: { account: { name: "A" } } }));
  await page.route("**/api/support/topics?**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "oops" }));
  await page.routeWebSocket(/stream/, () => {});
  await open(page);
  await expect(page.getByTestId("account-card")).toBeVisible();
  await expect(page.locator(".fd-error")).toBeVisible();
});

test("sign out from inside a topic: the address loses #/topic/<id>, the guest panel shows, back and forth cannot reopen the topic", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(158)], messages: { 158: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/158");
  await expect(page.getByText("Hi", { exact: true })).toBeVisible();
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  expect(page.url()).not.toContain("158");
  await expect(page.getByTestId("topic-title")).toHaveCount(0);
  await page.evaluate(() => { location.hash = "#/topic/158"; });
  await page.waitForTimeout(400);
  await expect(page.getByTestId("sign-in-panel")).toBeVisible(); // a hash change cannot bring the dashboard back
  expect(api.signedIn).toBe(false);
});

test("a link to a topic leads back to that topic after signing in", async ({ page }) => {
  const api = await mockApi(page, { signedIn: false, topics: [row(14, { subject: "Fourteen" })], messages: { 14: [msg(1, "visitor", "Hello from 14")] } });
  // The visitor counts as signed in only when the page they are sent back to is requested (not already when the sign-in link is clicked),
  // otherwise the old page's own re-check could see the new session first and use up the remembered topic.
  let sentToSignIn = false;
  await page.route("**/api/auth/login**", (route) => { sentToSignIn = true; return route.fulfill({ status: 302, headers: { Location: "/support" } }); });
  page.on("request", (request) => { if (sentToSignIn && request.isNavigationRequest() && new URL(request.url()).pathname === "/support") api.signedIn = true; });
  await open(page, "/support#/topic/14");
  await expect(page.getByTestId("sign-in-panel")).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByText("Hello from 14", { exact: true })).toBeVisible();
  await expect(page.getByTestId("topic-title")).toHaveText("Fourteen");
  expect(new URL(page.url()).hash).toBe("#/topic/14");
});

test("only known targets are remembered: a crafted hash is ignored", async ({ page }) => {
  const api = await mockApi(page, { signedIn: false, topics: [row(1)] });
  await page.route("**/api/auth/login**", async (route) => { api.signedIn = true; await route.fulfill({ status: 302, headers: { Location: "/support" } }); });
  await open(page, "/support#/topic/1;alert(1)");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByTestId("topic-list")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("dark host page: the panel, cards, table and badges use dark colours with readable text", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { subject: "Dark mode topic" }), row(2, { status: "Resolved", tab: "resolved" })] });
  await open(page);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.getByTestId("topic-row")).toHaveCount(2);
  const lum = (css) => { const m = css.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const colours = await page.evaluate(() => { const g = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    return { panel: g(".fd", "backgroundColor"), card: g(".fd-card", "backgroundColor"), tableWrap: g(".fd-table-wrap", "backgroundColor"), text: g(".fd-strong", "color"), muted: g(".fd-small.fd-muted", "color"), subject: g(".fd-subject", "color") }; });
  for (const k of ["panel", "card", "tableWrap"]) expect(lum(colours[k]), k).toBeLessThan(0.1);
  for (const k of ["text", "muted", "subject"]) expect(lum(colours[k]), k).toBeGreaterThan(0.3);
});

test("guest card is centred and on a dark page stays dark", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await open(page);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const card = page.locator(".fd-auth-card");
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  const vw = page.viewportSize().width;
  expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThan(8);
  expect(box.width).toBeLessThanOrEqual(420);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".fd-auth-card")).backgroundColor);
  const m = bg.match(/[\d.]+/g).map(Number); expect(m[0] + m[1] + m[2]).toBeLessThan(150);
});

test("the account island and Sign out stay in view with 60 topics and a long thread, on desktop and phone", async ({ page }) => {
  const long = Array.from({ length: 80 }, (_, i) => msg(i + 1, i % 2 ? "agent" : "visitor", `Line ${i + 1}`));
  await mockApi(page, { topics: many(60), messages: { 1: long } });
  await open(page);
  const island = page.getByTestId("account-card"), signOut = page.getByTestId("sign-out");
  await expect(island).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300); // the page really scrolled
  await expect(island).toBeInViewport({ ratio: 1 });
  await expect(signOut).toBeInViewport({ ratio: 1 });
  // On a wide screen the topic list scrolls inside the column and does not push the island out.
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    const box = await island.boundingBox(), win = page.viewportSize();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(await page.locator(".fd-side").evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  }
  await page.evaluate(() => { location.hash = "#/topic/1"; });
  await expect(page.getByText("Line 80", { exact: true })).toBeVisible();
  await page.getByTestId("thread").evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
  await expect(island).toBeInViewport({ ratio: 1 });
  await expect(signOut).toBeInViewport({ ratio: 1 });
});

test("a long name and a long email are cut with an ellipsis inside the account island", async ({ page }) => {
  await mockApi(page, { account: { name: "Alexandrina Montgomery-Featherstonehaugh (temporary)", email: "alexandrina.montgomery-featherstonehaugh@a-very-long-company-domain.example", provider: "email", picture: null } });
  await open(page);
  const card = await page.getByTestId("account-card").boundingBox();
  for (const p of await page.locator(".fd-account-text p").all()) {
    const box = await p.boundingBox();
    if (!box) continue; // the email line is hidden on a phone
    expect(box.x + box.width, await p.innerText()).toBeLessThanOrEqual(card.x + card.width);
  }
  const main = await page.locator(".fd-main").boundingBox();
  if (page.viewportSize().width >= 1024) expect(card.x + card.width).toBeLessThanOrEqual(main.x + 1); // on a wide screen the island never reaches into the content column
  await expect(page.getByTestId("sign-out")).toBeInViewport({ ratio: 1 });
});

test("text typed while the side list is still loading is not wiped when the list arrives", async ({ page }) => {
  await mockApi(page, { topics: many(3) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/support/topics?tab=all&page=1", async (route) => { await gate; await route.fallback(); }, { times: 1 });
  await open(page);
  await page.locator('[data-testid="new-topic"]:visible, [data-testid="side-new-topic"]:visible').first().click();
  await page.getByLabel("Your question").fill("Half-written question");
  release();
  await expect(page.getByTestId("recent-item")).toHaveCount(3); // the list arrived
  await expect(page.getByLabel("Your question")).toHaveValue("Half-written question");
});

test("headingLevel 2: the brand and the guest title step down, so a host page can keep its own single h1", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/?level=2");
  await expect(page.getByTestId("sign-in-panel")).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(0);
  await expect(page.locator("h2.fd-brand")).toHaveCount(1);
  await expect(page.locator("h3.fd-guest-title")).toHaveCount(1);
});

test("the reply box says reply, the new-topic box says question", async ({ page }) => {
  await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/1");
  await expect(page.getByLabel("Reply", { exact: true })).toHaveAttribute("placeholder", "Write your reply…");
});

test("phone: the side list does not repeat the topic list; there is one New topic button on the list", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone width only");
  await mockApi(page, { topics: many(4) });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(4);
  await expect(page.getByTestId("recent-item").first()).toBeHidden();
  await expect(page.getByRole("link", { name: "New topic" }).locator("visible=true")).toHaveCount(1);
  await expect(page.getByTestId("account-card")).toBeVisible();
});

test("phone: the topic table fits the screen without sideways scrolling", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone width only");
  await mockApi(page, { topics: many(3).map((t) => ({ ...t, subject: "A rather long subject line that has to wrap instead of pushing the table wider" })) });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(3);
  expect(await page.locator(".fd-table-wrap").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByTestId("topic-row").first()).toContainText("Open");
});

// ---- taken over from the old single-conversation page ----
test("a source link (?src=linkedin) is passed on with the sign-in link, kept for the tab, and a bad value is ignored", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/?src=LinkedIn");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/api/auth/login?returnTo=%2Ftalk&src=linkedin");
  await page.goto("/?auth_error=x"); // the parameter is gone from the address, the tab still remembers it
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", /&src=linkedin$/);
});

test("a bad source value is not sent", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/?src=" + encodeURIComponent("x y<script>"));
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/api/auth/login?returnTo=%2Ftalk");
});

test("a visitor with no topics lands on the new-topic form; Back leads to the (empty) list and does not bounce", async ({ page }) => {
  await mockApi(page, { topics: [] });
  await open(page);
  await expect(page.getByTestId("create")).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByTestId("create")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(new URL(page.url()).hash).toBe("#/");
});

test("a visitor with topics lands on the list", async ({ page }) => {
  await mockApi(page, { topics: [row(1)] });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  await expect(page.getByTestId("create")).toHaveCount(0);
});

test("when the topic list cannot be loaded nobody is sent to the new-topic form", async ({ page }) => {
  await mockApi(page, { topics: [] });
  await page.route("**/api/support/topics?**", (route) => route.fulfill({ status: 500, json: { error: "x" } }));
  await open(page);
  await page.waitForTimeout(800);
  await expect(page.getByTestId("create")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
});

test("an unsent new topic survives a reload, is cleared by sending, and is never offered to another account", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(1)] });
  await open(page, "/#/new");
  await page.getByLabel("Subject (optional)").fill("Kept subject");
  await page.getByLabel("Your question").fill("Kept text");
  await page.reload();
  await expect(page.getByLabel("Your question")).toHaveValue("Kept text");
  await expect(page.getByLabel("Subject (optional)")).toHaveValue("Kept subject");
  api.account = { name: "Someone Else", email: "else@example.com", provider: "email", picture: null };
  await page.reload();
  await expect(page.getByLabel("Your question")).toHaveValue("");
  api.account = { name: "Alex Example", email: "alex@example.com", provider: "google", picture: null };
  await page.getByLabel("Your question").fill("Send me");
  await page.getByTestId("create").click();
  await expect(page.getByTestId("topic-title")).toBeVisible();
  await page.goto("/#/new"); await page.reload();
  await expect(page.getByLabel("Your question")).toHaveValue("");
});

test("an unsent reply survives a reload and signing out deletes drafts", async ({ page }) => {
  await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/1");
  await page.getByLabel("Reply", { exact: true }).fill("Half a reply");
  await page.reload();
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("Half a reply");
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("foyerdesk-draft-")))).toEqual([]);
});

test("an ended session keeps the typed text and offers it again after signing in", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/1");
  await page.getByLabel("Reply", { exact: true }).fill("Important words");
  api.signedIn = false; // the session ends while the visitor is typing
  await page.getByTestId("send").click();
  await expect(page.getByTestId("guest-title")).toHaveText("Your session ended");
  api.signedIn = true;
  await open(page, "/#/topic/1"); // back after signing in, the visitor opens the topic again
  await page.reload();
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("Important words");
});

// ---- found in the owner's screenshots of the live page ----
test("desktop: with a short list, a heading above and a footer below, the account card stays under the host header while the page scrolls", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "wide screens only");
  await page.setViewportSize({ width: 1372, height: 573 });
  await mockApi(page, { topics: [row(1), row(2)] });
  await open(page, "/?spacer=230&after=300");
  await page.addStyleTag({ content: ".fd { --fd-chrome: 6.5rem; }" }); // the host's floating header covers the top 104px
  await expect(page.getByTestId("topic-row")).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 214)); // as far as the owner scrolled in the screenshot
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBe(214);
  const card = await page.getByTestId("account-card").boundingBox();
  expect(card.y, "the card must not slide under the header").toBeGreaterThanOrEqual(104);
  await expect(page.getByTestId("sign-out")).toBeInViewport({ ratio: 1 });
});

test("only one New topic button is visible on the list, on a wide screen and on a phone", async ({ page }) => {
  await mockApi(page, { topics: [row(1), row(2)] });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(2);
  const visible = await page.getByRole("link", { name: "New topic" }).evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden").length);
  expect(visible).toBe(1);
});

// ---- from the independent review (ui_qa) ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("errors say what is wrong: no connection, too many requests, service down", async ({ page }) => {
  await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/1");
  await page.getByLabel("Reply", { exact: true }).fill("Keep me");
  const cases = [[null, /No connection/], [429, /Too many requests/], [503, /not available right now/]];
  for (const [status, text] of cases) {
    await page.route("**/topics/1/messages", (route) => (route.request().method() === "POST" ? (status ? route.fulfill({ status, json: {} }) : route.abort()) : route.fallback()), { times: 1 });
    await page.getByTestId("send").click();
    await expect(page.locator(".fd-topic .fd-error, [role=alert]").filter({ hasText: text }).first()).toBeVisible();
    await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("Keep me");
    await expect(page.getByTestId("send")).toBeEnabled();
  }
});

test("words typed while a reply is on its way are not erased, and a second Ctrl+Enter does not send twice", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await page.route("**/topics/1/messages", async (route) => { if (route.request().method() === "POST") await sleep(700); await route.fallback(); });
  await open(page, "/#/topic/1");
  const box = page.getByLabel("Reply", { exact: true });
  await box.fill("First");
  await box.press("Control+Enter");
  await box.press("Control+Enter"); // a second press while the first is on its way
  await expect(page.getByTestId("send")).toHaveText("Sending…");
  await box.pressSequentially(" and more");
  await expect(page.getByTestId("send")).toHaveText("Send message");
  expect(api.posts.filter((p) => p.path.endsWith("/messages"))).toHaveLength(1);
  await expect(box).toHaveValue("First and more");
});

test("sign out: an already ended session counts as signed out; a failure shows one message and can be retried", async ({ page }) => {
  await mockApi(page, { topics: [row(1)] });
  await open(page);
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 500, json: {} }));
  for (let i = 0; i < 3; i++) await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("signout-error")).toHaveCount(1);
  await expect(page.getByTestId("sign-out")).toBeEnabled();
  await page.unroute("**/api/auth/logout");
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 401, json: {} }));
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
});

test("a failed list shows Try again, and Try again recovers it", async ({ page }) => {
  await mockApi(page, { topics: [row(1)] });
  let fail = true;
  await page.route("**/api/support/topics?tab=all&page=1", (route) => (fail ? route.fulfill({ status: 500, json: {} }) : route.fallback()));
  await open(page, "/#/");
  await expect(page.getByTestId("list-error")).toContainText("not available right now");
  fail = false;
  await page.getByTestId("retry").first().click();
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
});

test("a topic that failed to load hides the reply box and offers Try again", async ({ page }) => {
  await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  let fail = true;
  await page.route("**/api/support/topics/1/messages", (route) => (fail && route.request().method() === "GET" ? route.fulfill({ status: 500, json: {} }) : route.fallback()));
  await open(page, "/#/topic/1");
  await expect(page.getByTestId("retry")).toBeVisible();
  await expect(page.getByLabel("Reply", { exact: true })).toBeHidden();
  fail = false;
  await page.getByTestId("retry").click();
  await expect(page.getByText("Hi", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Reply", { exact: true })).toBeVisible();
});

test("the list shows Loading while it waits, and no raw keys such as status_ or err_ are ever visible", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { status: "Snoozed" })] });
  await page.route("**/api/support/topics?tab=all&page=1", async (route) => { await sleep(900); await route.fallback(); });
  await open(page, "/#/");
  await expect(page.getByTestId("loading")).toBeVisible();
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  const visible = await page.locator(".fd").innerText();
  expect(visible).not.toMatch(/\bstatus_|\berr_/);
});

test("keyboard focus stays on the same item when the server pushes an update", async ({ page }) => {
  const api = await mockApi(page, { topics: many(30) });
  await open(page, "/#/");
  await expect(page.getByTestId("topic-row")).toHaveCount(25);
  await page.getByTestId("next").focus();
  api.sockets[0].send("changed");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("next");
});

test("an ended session while writing in a topic returns to that topic after 'Sign in again'", async ({ page }) => {
  const api = await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Hi")] } });
  await open(page, "/#/topic/1");
  await page.getByLabel("Reply", { exact: true }).fill("Do not lose me");
  api.signedIn = false;
  await page.getByTestId("send").click();
  await expect(page.getByTestId("guest-title")).toHaveText("Your session ended");
  await page.getByRole("link", { name: "Sign in" }).evaluate((a) => a.addEventListener("click", (e) => e.preventDefault(), { once: true })); // stay here, as the sign-in page would send the visitor back
  await page.getByRole("link", { name: "Sign in" }).click();
  api.signedIn = true;
  await page.goto("/"); // the Worker returns the visitor to the page without the part after "#"
  await expect(page.getByLabel("Reply", { exact: true })).toHaveValue("Do not lose me");
  expect(new URL(page.url()).hash).toBe("#/topic/1");
});

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: text and buttons reach a contrast of 4.5 to 1`, async ({ page }) => {
    await mockApi(page, { topics: [row(1, { unread: true }), row(2, { status: "Pending" }), row(3, { status: "Resolved", tab: "resolved" })], messages: { 1: [msg(1, "visitor", "Mine"), msg(2, "support", "Theirs")] } });
    await open(page, "/#/");
    if (theme === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.getByTestId("topic-row")).toHaveCount(3);
    const measure = () => page.evaluate(() => {
      const parse = (c) => c.match(/[\d.]+/g).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const backdrop = (el) => { // what the element sits on: layers with transparency are blended down to the first solid colour
        const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if ((c[3] ?? 1) > 0) layers.push(c); if ((c[3] ?? 1) === 1) break; }
        let base = [255, 255, 255]; if (!layers.length || (layers.at(-1)[3] ?? 1) < 1) base = parse(getComputedStyle(document.documentElement).colorScheme === "dark" ? "rgb(13,21,38)" : "rgb(255,255,255)");
        for (const c of layers.reverse()) { const a = c[3] ?? 1; base = base.map((v, i) => v * (1 - a) + c[i] * a); }
        return base;
      };
      const ratio = (el) => { const fg = parse(getComputedStyle(el).color), bg = backdrop(el); const a = fg[3] ?? 1; const mix = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); const [x, y] = [lum(mix), lum(bg)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const pick = { "new-topic button": ".fd-page-head .fd-primary", "side New topic": '[data-testid="side-new-topic"]', "status badge Open": ".fd-badge.fd-open", "status badge Pending": ".fd-badge.fd-pending", "status badge Resolved": ".fd-badge.fd-resolved", "provider chip": ".fd-chip", "muted text": ".fd-muted", "topic link": ".fd-subject", "table text": ".fd-table td", "heading": ".fd h2" };
      return Object.fromEntries(Object.entries(pick).map(([name, sel]) => { const el = document.querySelector(sel); return [name, el ? Math.round(ratio(el) * 100) / 100 : null]; }));
    });
    const result = await measure();
    for (const [name, value] of Object.entries(result)) if (value !== null) expect(value, `${theme}: ${name}`).toBeGreaterThanOrEqual(4.5);
  });
}

for (const [width, height] of [[390, 844], [767, 800], [768, 700], [900, 600], [1023, 640], [1024, 640], [1280, 573], [911, 512]]) {
  test(`an open topic fits ${width} x ${height} below a heading of any height: reply box and Send stay in view`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "sizes are set in the test");
    await page.setViewportSize({ width, height });
    const list = Array.from({ length: 60 }, (_, i) => msg(i + 1, i % 2 ? "support" : "visitor", `Message ${i + 1}`));
    await mockApi(page, { topics: [row(1)], messages: { 1: list } });
    await open(page, "/?spacer=130#/topic/1"); // 130 px stands in for the host's header and spacing above the screens
    await expect(page.getByText("Message 60", { exact: true })).toBeVisible();
    await page.waitForTimeout(200);
    const send = await page.getByTestId("send").boundingBox();
    expect(send.y + send.height, "Send is inside the window").toBeLessThanOrEqual(height);
    expect(await page.getByTestId("thread").evaluate((el) => el.scrollHeight > el.clientHeight), "the thread scrolls inside").toBe(true);
    const topEdge = await page.locator(".fd-topic").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    if (height - 120 - topEdge - 16 >= 256) { // there is room for a usable topic even with a phone keyboard open
      await page.setViewportSize({ width, height: height - 120 });
      await page.waitForTimeout(300);
      const again = await page.getByTestId("send").boundingBox();
      expect(again.y + again.height, "Send stays in view after the window shrinks").toBeLessThanOrEqual(height - 120);
    }
  });
}

test("while the session is being checked the panel says so and is not the guest panel; the screens add no second main landmark", async ({ page }) => {
  await mockApi(page, { topics: [row(1)] });
  await page.route("**/api/support/session", async (route) => { await sleep(800); await route.fallback(); });
  await open(page, "/#/");
  await expect(page.getByTestId("checking")).toBeVisible();
  expect(await page.locator(".fd").getAttribute("data-state")).toBe("checking");
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  expect(await page.locator("main").count()).toBe(0);
});

// ---- from the independent UI review (2026-11-24), each fails on the code before the fix ----
test("an unknown Chatwoot status is shown as a neutral label, never as a raw key, and no raw key appears anywhere", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { status: "Snoozed", subject: "Waiting" })] });
  await open(page);
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  const text = await page.locator(".fd").innerText();
  expect(text).not.toMatch(/\b(status|err)_[a-z_]+/);
});

test("a picture that fails to load is replaced by the initials; a non-https picture is never loaded", async ({ page }) => {
  await page.route("https://img.example.invalid/**", (route) => route.fulfill({ status: 404, body: "" }));
  await mockApi(page, { account: { name: "Alex Example", email: "a@b.c", provider: "google", picture: "https://img.example.invalid/gone.png" } });
  await open(page);
  await expect(page.getByTestId("account-card").locator("img")).toHaveCount(0);
  await expect(page.getByTestId("account-card").locator(".fd-initials")).toHaveText("AE");
  const second = await page.context().newPage();
  await mockApi(second, { account: { name: "Alex Example", email: "a@b.c", provider: "google", picture: "javascript:alert(1)" } });
  await open(second);
  await expect(second.getByTestId("account-card")).toBeVisible();
  await expect(second.getByTestId("account-card").locator("img")).toHaveCount(0);
});

test("initials survive an emoji in the name", async ({ page }) => {
  await mockApi(page, { account: { name: "😀 Alex", email: "a@b.c", provider: "google", picture: null } });
  await open(page);
  const initials = await page.getByTestId("account-card").locator(".fd-initials").textContent();
  expect(initials).not.toContain("\uFFFD");
  expect(Array.from(initials ?? "")).toEqual(["😀", "A"]);
});

test("the topic filter is a navigation with the current page marked, and an unread row says so in words", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { unread: true, subject: "Needs a look" }), row(2)] });
  await open(page);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Filter topics" }).locator("[aria-current=page]")).toHaveText("All");
  await expect(page.getByTestId("topic-row").filter({ hasText: "Needs a look" }).getByRole("link")).toHaveAccessibleName(/^Unread: Needs a look/);
});

test("Back and a reload keep the tab and the page of the list", async ({ page }) => {
  const resolved = Array.from({ length: 30 }, (_, i) => row(100 + i, { status: "Resolved", tab: "resolved", subject: `Done ${i}` }));
  await mockApi(page, { topics: [row(1), ...resolved], messages: { 100: [msg(1, "visitor", "old")] } });
  await open(page, "/#/resolved");
  await page.getByTestId("next").click();
  await expect(page.getByTestId("page-of")).toContainText("2");
  expect(page.url()).toContain("#/resolved?page=2");
  await page.getByTestId("topic-row").first().getByRole("link").click();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByTestId("page-of")).toContainText("2");
  expect(page.url()).toContain("#/resolved?page=2");
  await page.reload();
  await expect(page.getByTestId("page-of")).toContainText("2");
});

test("a 200-character subject without spaces does not push the status out of a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockApi(page, { topics: [row(1, { subject: "A".repeat(200) })] });
  await open(page);
  const wrap = page.locator(".fd-table-wrap");
  await expect(wrap).toBeVisible();
  expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const badgeBox = await page.locator(".fd-table .fd-badge").boundingBox();
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(390);
});

test("dates follow the interface language, not the browser's, and a day label from another year carries the year", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ru-RU" });
  const page = await context.newPage();
  const lastYear = Math.floor(new Date(new Date().getFullYear() - 1, 11, 31, 12).getTime() / 1000);
  await mockApi(page, { topics: [row(1)], messages: { 1: [msg(1, "visitor", "Old", lastYear), msg(2, "support", "Reply", lastYear + 86400)] } });
  await open(page, "/#/topic/1");
  const days = await page.locator(".fd-day").allTextContents();
  expect(days.length).toBe(2);
  expect(days.join(" ")).toMatch(/[A-Za-z]{3}/);
  expect(days.join(" ")).not.toMatch(/[А-Яа-я]/);
  expect(days[0]).toContain(String(new Date().getFullYear() - 1));
  await context.close();
});

test("with reduced motion the thread is never scrolled smoothly", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__smooth = 0; const original = Element.prototype.scrollTo; Element.prototype.scrollTo = function (arg, ...rest) { if (arg && arg.behavior === "smooth") window.__smooth += 1; return original.call(this, arg, ...rest); }; });
  const api = await mockApi(page, { topics: [row(1)], messages: { 1: Array.from({ length: 5 }, (_, i) => msg(i + 1, i % 2 ? "support" : "visitor", `m${i}`)) } });
  await open(page, "/#/topic/1");
  await expect(page.getByTestId("message")).toHaveCount(5);
  api.messages[1].push(msg(6, "support", "new one"));
  api.sockets[0]?.send("changed:1");
  await expect(page.getByTestId("message")).toHaveCount(6);
  expect(await page.evaluate(() => window.__smooth)).toBe(0);
  await context.close();
});

test("the composer says what a reply does in a closed topic, 'sent' goes away when typing again, the message list is a labelled log", async ({ page }) => {
  await mockApi(page, { topics: [row(1, { status: "Resolved", tab: "resolved" })], messages: { 1: [msg(1, "visitor", "Hello")] } });
  await open(page, "/#/topic/1");
  await expect(page.getByTestId("composer-hint")).toContainText("Replying reopens this topic");
  await expect(page.getByRole("log", { name: "Messages" })).toBeVisible();
  await page.getByLabel("Reply").fill("Thanks");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("sent")).toBeVisible();
  await page.getByLabel("Reply").fill("more");
  await expect(page.getByTestId("sent")).toBeHidden();
});
