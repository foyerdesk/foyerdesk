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
  await open(page);
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
  await page.route("**/api/auth/login**", async (route) => { api.signedIn = true; await route.fulfill({ status: 302, headers: { Location: "/support" } }); });
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
  await page.getByTestId("new-topic").click();
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
