import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test", testMatch: /.*\.spec\.mjs/, timeout: 30_000, retries: 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:4177", trace: "retain-on-failure" },
  webServer: [
    { command: "node test/harness/server.mjs", url: "http://127.0.0.1:4177/", reuseExistingServer: true },
    { command: "node demo/server.mjs", url: "http://127.0.0.1:4180/", reuseExistingServer: false },
  ],
  projects: [
    { name: "desktop", use: { viewport: { width: 1366, height: 768 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
