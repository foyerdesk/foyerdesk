import assert from "node:assert/strict";
import test from "node:test";
import { oidcEndpoints, oidcSettings } from "../src/oidc.mjs";

test("old LOGTO_* names select the Logto layout with fixed paths and no discovery request", async () => {
  const settings = oidcSettings({ LOGTO_ISSUER: "https://a.example/oidc", LOGTO_CLIENT_ID: "c", LOGTO_CLIENT_SECRET: "s" });
  assert.equal(settings.flavor, "logto");
  const endpoints = await oidcEndpoints(settings);
  assert.equal(endpoints.userinfo, "https://a.example/oidc/me");
});

test("OIDC_* names read endpoints from the discovery document of any provider", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(String(url), "https://kc.example/realms/x/.well-known/openid-configuration");
    return Response.json({ issuer: "https://kc.example/realms/x", authorization_endpoint: "https://kc.example/a", token_endpoint: "https://kc.example/t", jwks_uri: "https://kc.example/j", userinfo_endpoint: "https://kc.example/u" });
  };
  try {
    const settings = oidcSettings({ OIDC_ISSUER: "https://kc.example/realms/x", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" });
    assert.equal(settings.flavor, "generic");
    assert.deepEqual(await oidcEndpoints(settings), { authorization: "https://kc.example/a", token: "https://kc.example/t", jwks: "https://kc.example/j", userinfo: "https://kc.example/u" });
    await oidcEndpoints(settings);
    assert.equal(calls, 1, "discovery is cached");
  } finally { globalThis.fetch = real; }
});

test("a discovery document for a different issuer is refused", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ issuer: "https://evil.example", authorization_endpoint: "x", token_endpoint: "x", jwks_uri: "x" });
  try {
    await assert.rejects(oidcEndpoints(oidcSettings({ OIDC_ISSUER: "https://idp2.example", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s" })), /discovery_issuer_mismatch/);
  } finally { globalThis.fetch = real; }
});
