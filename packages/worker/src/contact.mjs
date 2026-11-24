// Settings of this deployment, read from the Worker's variables on every request. CHATWOOT_BASE_URL and CHATWOOT_ACCOUNT_ID are required.
// IDENTIFIER_PREFIX starts the identifier stored on each Chatwoot contact (changing it later orphans existing contacts).
// DEFAULT_CONTACT_NAME is the name given to a contact until the sign-in provider reports a real one.
let base = null;
let identifierPrefix = "foyerdesk-";
let defaultName = "Customer";
export function configureChatwoot(env) {
  const origin = String(env.CHATWOOT_BASE_URL ?? "").replace(/\/+$/, "");
  const account = String(env.CHATWOOT_ACCOUNT_ID ?? "");
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin) || !/^[0-9]{1,9}$/.test(account)) throw new Error("invalid_chatwoot_settings");
  base = `${origin}/api/v1/accounts/${account}/contacts`;
  identifierPrefix = String(env.IDENTIFIER_PREFIX ?? "foyerdesk-");
  defaultName = String(env.DEFAULT_CONTACT_NAME ?? "Customer");
}
const inboxId = 2;

export async function participantIdentifier(issuer, subject) {
  const input = new TextEncoder().encode(JSON.stringify([issuer, subject]));
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return identifierPrefix + hex;
}

async function search(query, headers) {
  const url = new URL(base + "/search");
  url.searchParams.set("q", query);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("contact_search_failed_" + response.status);
  const { payload } = await response.json();
  if (!Array.isArray(payload)) throw new Error("invalid_contact_search_response");
  return payload;
}

function confirmedContact(contact) {
  if (contact?.contact_inboxes?.some(({ inbox }) => inbox?.id === inboxId)) return "ready";
  return "linking_required";
}

export async function provisionContact(issuer, user, token) {
  if (user.email_verified !== true || typeof user.email !== "string" || !user.email.trim()) {
    return "email_verification_required";
  }
  if (!token) throw new Error("chatwoot_credential_unavailable");

  const identifier = await participantIdentifier(issuer, user.sub);
  const headers = { api_access_token: token, Accept: "application/json" };
  const find = async () => (await search(identifier, headers)).find((item) => item.identifier === identifier);
  const existing = await find();
  if (existing) return confirmedContact(existing);

  const email = user.email.trim();
  const candidates = await search(email, headers);
  if (candidates.some((item) => item.email?.trim().toLowerCase() === email.toLowerCase() &&
      item.identifier !== identifier)) {
    return "linking_required";
  }

  try {
    await fetch(base, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        inbox_id: inboxId, identifier, email,
        name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : defaultName,
      }),
    });
  } catch {
    // The server may have committed the contact before the response was lost.
    // Re-read by identifier below and never issue a second write in this callback.
  }
  const contact = await find();
  if (contact) return confirmedContact(contact);

  const conflicts = await search(email, headers);
  if (conflicts.some((item) => item.email?.trim().toLowerCase() === email.toLowerCase() &&
      item.identifier !== identifier)) return "linking_required";
  throw new Error("contact_provisioning_unconfirmed");
}

export const lastWriteStatus = { value: null };
async function postAndReconcile(path, payload, headers) {
  try {
    const written = await fetch(base + path, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    lastWriteStatus.value = written.status;
  } catch {
    lastWriteStatus.value = "network";
    // A write may have completed. The caller independently reads the result.
  }
}

// Cloudflare reports the visitor country as a two-letter code ("XX" unknown, "T1" Tor). The value describes the
// network location at sign-in, not nationality or residence. A failed write must never block sign-in.
function validCountryCode(value) {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1" ? value : null;
}

const placeholderName = () => defaultName;
const cleanText = (value, max) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// Keeps the Chatwoot contact card in step with what Logto and Cloudflare report at sign-in.
// Every field is optional and a failed write never blocks sign-in.
async function syncProfile(contact, user, context, headers) {
  const code = validCountryCode(context.country);
  const attributes = { ...(contact.additional_attributes ?? {}) };
  const custom = { ...(contact.custom_attributes ?? {}) };
  const update = {};
  if (code && attributes.country_code !== code) {
    let name = code;
    try { name = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { /* keep the code */ }
    update.additional_attributes = { ...attributes, country_code: code, country: name };
  }
  const source = cleanText(context.source, 32);
  if (source) {
    if (!custom.first_source) custom.first_source = source;
    custom.last_source = source;
  }
  const provider = cleanText(context.provider, 32);
  if (provider) custom.login_provider = provider;
  const language = cleanText(user.locale, 16);
  if (language) custom.preferred_language = language;
  if (JSON.stringify(custom) !== JSON.stringify(contact.custom_attributes ?? {})) update.custom_attributes = custom;
  const realName = cleanText(user.name, 120);
  if (realName && (!contact.name || contact.name === placeholderName()) && realName !== contact.name) update.name = realName;
  const picture = cleanText(user.picture, 500);
  if (picture && /^https:\/\//.test(picture) && !contact.thumbnail && !contact.avatar_url) update.avatar_url = picture;
  if (!Object.keys(update).length) return;
  try {
    await fetch(base + "/" + contact.id, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(update), signal: AbortSignal.timeout(5000),
    });
  } catch { /* best effort */ }
}

export async function provisionApiContact(identifier, user, token, inboxId, sourceKey, context = {}) {
  if (!token) throw new Error("chatwoot_credential_unavailable");
  const headers = { api_access_token: token, Accept: "application/json" };
  const exact = async () => (await search(identifier, headers)).find((row) => row.identifier === identifier);
  const email = user.email.trim();
  if (!email) throw new Error("verified_email_required");
  const hasCollision = async () => (await search(email, headers)).some((row) =>
    row.email?.trim().toLowerCase() === email.toLowerCase() && row.identifier !== identifier
  );

  let contact = await exact();
  if (!contact) {
    // Chatwoot's own identify rule (ContactIdentifyAction, v4.20.1): an identifier-less contact with the
    // same email may be identified. The email here was verified by the sign-in provider. A contact that already owns a
    // different identifier is never taken over.
    const legacy = (await search(email, headers)).filter((row) =>
      row.email?.trim().toLowerCase() === email.toLowerCase() && !row.identifier);
    if (legacy.length === 1) {
      try {
        await fetch(base + "/" + legacy[0].id, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ identifier }), signal: AbortSignal.timeout(5000),
        });
      } catch { /* re-read below */ }
      contact = await exact();
    }
  }
  if (!contact) {
    if (await hasCollision()) return null;
    await postAndReconcile("", {
      identifier, email,
      name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : defaultName,
    }, headers);
    contact = await exact();
    if (!contact && await hasCollision()) return null;
  }
  if (!contact) throw new Error("contact_provisioning_unconfirmed_write_" + lastWriteStatus.value);
  if (contact.email?.toLowerCase() !== email.toLowerCase()) return null;
  await syncProfile(contact, user, context, headers);

  const findMapping = (row) => {
    const associations = (row?.contact_inboxes ?? []).filter((item) => item.inbox?.id === inboxId);
    if (associations.length > 1) throw new Error("ambiguous_api_inbox_association");
    const sourceId = associations[0]?.source_id;
    return sourceId ? { contactId: row.id, inboxId, sourceId } : null;
  };
  const existing = findMapping(contact);
  if (existing) return existing;

  if (!sourceKey) throw new Error("contact_source_key_unavailable");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(sourceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([identifier, inboxId])));
  const sourceId = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await postAndReconcile(`/${contact.id}/contact_inboxes`, { inbox_id: inboxId, source_id: sourceId }, headers);
  const current = await exact();
  const mapping = findMapping(current);
  if (!mapping || mapping.contactId !== contact.id) throw new Error("inbox_association_unconfirmed_write_" + lastWriteStatus.value);
  return mapping;
}
