import { chromium } from "@playwright/test";
import { mockApi, row } from "./test/mock.mjs";
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await mockApi(p, { topics: [row(1), row(2)] });
await p.goto("http://127.0.0.1:4190/support", { waitUntil: "networkidle" });
console.log(await p.evaluate(() => ({ aside: getComputedStyle(document.querySelector(".fd-aside")).display, sheets: [...document.styleSheets].map((s) => s.href?.split("/").pop()) })));
await b.close();
