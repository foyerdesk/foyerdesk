// Settings and endpoints of the sign-in provider. Any OpenID Connect provider works (Keycloak, Auth0, Entra, Google,
// Logto, Clerk, Authentik, ...). Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET; endpoints come from the
// provider's discovery document. Logto extras (direct provider links, the identities claim) apply only when
// OIDC_FLAVOR=logto. The older LOGTO_* names keep working and select the Logto layout without a discovery request.
const discovered = new Map();
const discoveryTtl = 3600 * 1000;
export const providerTimeout = 8000; // every call to the provider

export const signingAlgorithms = ["ES256", "ES384", "RS256", "PS256", "EdDSA"];

export function oidcSettings(env) {
  const legacy = env.OIDC_ISSUER === undefined && env.LOGTO_ISSUER !== undefined;
  return {
    issuer: env.OIDC_ISSUER ?? env.LOGTO_ISSUER,
    clientId: env.OIDC_CLIENT_ID ?? env.LOGTO_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? env.LOGTO_CLIENT_SECRET,
    flavor: legacy ? "logto" : (env.OIDC_FLAVOR ?? "generic"),
    legacy,
  };
}

export async function oidcEndpoints(settings) {
  const { issuer } = settings;
  if (settings.legacy) {
    return { authorization: issuer + "/auth", token: issuer + "/token", jwks: issuer + "/jwks", userinfo: issuer + "/me" };
  }
  const cached = discovered.get(issuer);
  if (cached && Date.now() - cached.at < discoveryTtl) return cached.endpoints;
  const response = await fetch(issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(providerTimeout) });
  if (!response.ok) throw new Error("discovery_failed");
  const document = await response.json();
  if (document.issuer !== issuer) throw new Error("discovery_issuer_mismatch");
  const endpoints = { authorization: document.authorization_endpoint, token: document.token_endpoint, jwks: document.jwks_uri, userinfo: document.userinfo_endpoint };
  for (const [name, value] of Object.entries(endpoints)) {
    if (typeof value !== "string" || !value.startsWith("https://")) throw new Error("discovery_endpoint_not_https_" + name);
  }
  discovered.set(issuer, { at: Date.now(), endpoints });
  return endpoints;
}
