// Screenshots and a short GIF for the README. Runs only with SHOTS=<directory>; `npm run media -w packages/ui` writes docs/screenshots.
// The screens are the real ones; the Worker is replaced by the same stand-in the tests use, so the data is demo data.
import { test } from "@playwright/test";
import { mockApi, msg, row } from "./mock.mjs";

const dir = process.env.SHOTS;
test.skip(!dir, "set SHOTS=<directory> to take screenshots");

const T = 1795500000;
const topics = () => [
  row(7, { subject: "Certificate shows the wrong name", status: "Open", preview: "Thanks, we have corrected it. Please check the new file.", at: T + 7000, unread: true }),
  row(6, { subject: "Question about my invoice", status: "Pending", tab: "open", preview: "Could you tell us the order number?", at: T + 6000 }),
  row(5, { subject: "Cannot open lesson 3 on my phone", status: "Open", preview: "The page stays blank after I sign in", at: T + 5000 }),
  row(4, { subject: "How do I change my email address?", status: "Resolved", tab: "resolved", preview: "Done, you can sign in with the new address.", at: T + 4000 }),
  row(3, { subject: "Refund for a duplicate payment", status: "Resolved", tab: "resolved", preview: "The refund was sent on Monday.", at: T + 3000 }),
  row(2, { subject: "Access to the course materials", status: "Resolved", tab: "resolved", preview: "You now have access, welcome!", at: T + 2000 }),
];
const thread = () => ({
  7: [
    msg(1, "visitor", "Hello, my certificate shows a misspelled name. It says Alec instead of Alex.", T + 7000 - 3600),
    msg(2, "support", "Hi Alex, thank you for telling us. Could you confirm the spelling you would like on it?", T + 7000 - 3000),
    msg(3, "visitor", "Alex Example, please.", T + 7000 - 2400),
    msg(4, "support", "Thanks, we have corrected it. Please check the new file.", T + 7000 - 600),
  ],
});
const account = { name: "Alex Example", email: "alex@example.com", provider: "email", picture: null };
// The harness page is taller than the panel; cut the picture where the panel ends.
const shot = async (page, name) => {
  const size = page.viewportSize(), box = await page.locator(".fd").boundingBox();
  await page.screenshot({ path: `${dir}/${name}.png`, clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, Math.ceil(box.y + box.height + 8)) } });
};

test("screenshots", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one project is enough, sizes are set below");
  await page.setViewportSize({ width: 1280, height: 800 });
  const guest = await mockApi(page, { signedIn: false });
  await page.goto("/"); await page.getByTestId("sign-in-panel").waitFor();
  await shot(page, "01-sign-in");
  guest.signedIn = true;

  await page.unroute("**/api/support/**").catch(() => {});
  await mockApi(page, { topics: topics(), messages: thread(), account });
  await page.goto("/"); await page.getByTestId("topic-row").first().waitFor();
  await shot(page, "02-topics");

  await page.goto("/#/topic/7"); await page.getByText("Please check the new file.").first().waitFor();
  await shot(page, "03-conversation");

  await page.goto("/#/new"); await page.getByLabel("Your question").waitFor();
  await page.getByLabel("Subject (optional)").fill("My certificate has a typo");
  await page.getByLabel("Your question").fill("Hello, my name is misspelled on the certificate. Could you fix it?");
  await shot(page, "04-new-topic");

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.goto("/#/topic/7"); await page.getByText("Please check the new file.").first().waitFor();
  await shot(page, "05-dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await page.getByTestId("topic-row").first().waitFor();
  await shot(page, "06-mobile-list");
  await page.goto("/#/topic/7"); await page.getByText("Please check the new file.").first().waitFor();
  await shot(page, "07-mobile-conversation");
});

test("demo animation", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one project is enough");
  const context = await browser.newContext({ viewport: { width: 1000, height: 640 }, recordVideo: { dir: `${dir}/video`, size: { width: 1000, height: 640 } } });
  const page = await context.newPage();
  const api = await mockApi(page, { topics: topics(), messages: thread(), account });
  const pause = (ms) => page.waitForTimeout(ms);
  await page.goto("/"); await page.getByTestId("topic-row").first().waitFor(); await pause(1500);
  await page.getByTestId("topic-row").first().getByRole("link").click();
  await page.getByText("Please check the new file.").first().waitFor(); await pause(1500);
  await page.getByLabel("Reply", { exact: true }).pressSequentially("The new file is perfect, thank you!", { delay: 45 }); await pause(500);
  await page.getByTestId("send").click(); await pause(1500);
  api.messages[7].at(-1).at = T + 7150; // keep the demo timestamps in order
  api.messages[7].push(msg(9, "support", "You are welcome, Alex. Marking this as solved. Write here any time.", T + 7300));
  api.sockets[0].send("changed:7"); await pause(2200);
  await page.getByRole("button", { name: "Mark as resolved" }).click(); await pause(1500);
  await page.getByRole("link", { name: "Back" }).click(); await pause(2000);
  await context.close();
  await page.video().saveAs(`${dir}/demo.webm`);
});
