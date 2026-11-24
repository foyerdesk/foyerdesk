import { chromium } from "@playwright/test";
import { mockApi, msg, row } from "./test/mock.mjs";
const T = 1795500000;
const topics = [row(7, { subject: "Question about the onboarding call", preview: "Thanks, we will confirm the time shortly.", at: T + 7000, unread: true }), row(6, { subject: "Invoice for November", status: "Pending", preview: "Could you tell us the PO number?", at: T + 6000 }), row(5, { subject: "Access to the shared drive", status: "Resolved", tab: "resolved", preview: "Done, you have access.", at: T + 5000 })];
const messages = { 7: [msg(1, "visitor", "Hello, can we move the onboarding call to Thursday?", T + 3000), msg(2, "support", "Of course. Does 15:00 work for you?", T + 4000), msg(3, "visitor", "Yes, 15:00 is perfect.", T + 5000), msg(4, "support", "Thanks, we will confirm the time shortly.", T + 7000)] };
const b = await chromium.launch();
for (const [mode, dark] of [["light", false], ["dark", true]]) for (const [name, size] of [["desktop", { width: 1366, height: 900 }], ["phone", { width: 390, height: 844 }]]) for (const state of ["guest", "list", "topic"]) {
  const ctx = await b.newContext({ viewport: size }); const p = await ctx.newPage();
  await p.addInitScript((d) => { try { localStorage.setItem("lavatti-ui-theme", d ? "dark" : "light"); localStorage.setItem("cookie-consent", "rejected"); } catch {} }, dark);
  await mockApi(p, { signedIn: state !== "guest", topics, messages });
  await p.goto("http://127.0.0.1:4190/support" + (state === "topic" ? "#/topic/7" : ""), { waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `/tmp/fd-shots/site-${mode}-${name}-${state}.png` });
  await ctx.close();
}
await b.close();
