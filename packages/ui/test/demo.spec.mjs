import { expect, test } from "@playwright/test";

// The demo server (npm run demo) is the first thing a new user runs, so it is tested too. It uses its own port and state.
test.describe.configure({ mode: "serial" });
const demo = "http://127.0.0.1:4180";

test("demo: topics show, a new topic and a reply work, resolve and sign out", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "state is shared, run once");
  await page.goto(demo + "/");
  await expect(page.getByTestId("topic-row")).toHaveCount(3);
  await page.getByTestId("new-topic").click();
  await page.getByLabel("Your question").fill("Demo question\nwith a second line");
  await page.getByTestId("create").click();
  await expect(page.getByTestId("topic-title")).toHaveText("Demo question");
  await page.getByLabel("Reply", { exact: true }).fill("One more thing");
  await page.getByTestId("send").click();
  await expect(page.getByText("One more thing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as resolved" }).click();
  await expect(page.getByTestId("topic-status")).toHaveText("Resolved");
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("guest-title")).toHaveText("You have signed out");
  await page.getByRole("link", { name: "Sign in again" }).click();
  await expect(page.getByTestId("topic-row")).toHaveCount(4);
});
