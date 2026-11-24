import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import en from "../src/i18n/en.js";
import { languages, translator } from "../src/i18n/index.js";

test("every language file has exactly the keys of en.js and is registered", async () => {
  const files = (await readdir(new URL("../src/i18n/", import.meta.url))).filter((f) => f.endsWith(".js") && f !== "index.js");
  for (const file of files) {
    const code = file.slice(0, -3);
    const dictionary = (await import(`../src/i18n/${file}`)).default;
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(en).sort(), `${file}: keys differ from en.js`);
    assert.ok(languages[code], `${file} is not registered in index.js`);
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, "string", `${file}:${key}`);
      assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), [...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${file}:${key} placeholders differ`);
    }
  }
});

test("translator: variables, unknown language falls back to English, unknown key shows the key", () => {
  const t = translator("fr-CA");
  assert.equal(t("viewAll", { n: 7 }), "View all (7)");
  assert.equal(t("nonexistent"), "nonexistent");
  assert.equal(translator()("signIn"), "Sign in");
  assert.equal(t("pageOf", { page: 1 }), "Page 1 of {pages}");
});

test("no dictionary value contains markup (text is inserted as text, but values must stay plain)", () => {
  for (const [key, value] of Object.entries(en)) assert.ok(!/[<>]/.test(value), key);
});

// The mock API used by the screen tests must have the same fields as the Worker (docs/contract.json, also asserted by the Worker acceptance test).
import { readFile } from "node:fs/promises";
import { msg, row } from "./mock.mjs";
test("mock API shapes equal the contract the Worker is tested against", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../docs/contract.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(row(1)).sort(), contract.listItem);
  assert.deepEqual(Object.keys(msg(1, "support", "x")).sort(), contract.message);
});
