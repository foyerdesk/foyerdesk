import { chromium } from "@playwright/test";
import { mockApi } from "./test/mock.mjs";
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
await p.addInitScript(() => { localStorage.setItem("lavatti-ui-theme", "dark"); });
await mockApi(p, { topics: [{ id: 1, subject: "Test", status: "Open", tab: "open", preview: "x", at: 1795500000, unread: false }], messages: { 1: [{ id: 1, direction: "visitor", text: "hello", at: 1795500000, author: null }] } });
await p.goto("http://127.0.0.1:4190/support#/topic/1", { waitUntil: "networkidle" });
for (const ms of [300, 3000]) { await p.waitForTimeout(ms); console.log(ms, await p.evaluate(() => getComputedStyle(document.querySelector(".fd-thread-wrap")).backgroundColor + " | " + getComputedStyle(document.querySelector(".fd-strong")).color)); }
await p.screenshot({ path: "/tmp/fd-shots/dbg-dark.png" });
await b.close();
