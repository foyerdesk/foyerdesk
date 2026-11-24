import { DurableObject } from "cloudflare:workers";

// Built-in sign-in by emailed link: no outside identity provider. The person proves they control a mailbox.
// Tokens are random, stored only as a hash, valid for 15 minutes and usable once (a Durable Object runs one
// request at a time, so two clicks cannot both succeed). Requesting a link is rate limited per address and per IP.
export const linkLifetimeSeconds = 900;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const emailPattern = /^[^\s@<>()"',;:\\]{1,64}@[^\s@<>()"',;:\\]{1,255}\.[^\s@<>()"',;:\\]{2,63}$/;

export class EmailLinkStore extends DurableObject {
  async put(entry) {
    const expires = Date.now() + linkLifetimeSeconds * 1000;
    await this.ctx.storage.put("link", { ...entry, expires });
    await this.ctx.storage.setAlarm(expires);
  }

  // Reads and deletes in one step: the first caller wins, everyone after gets null.
  async consume() {
    const link = await this.ctx.storage.get("link");
    await this.ctx.storage.deleteAll();
    return link && link.expires > Date.now() ? link : null;
  }

  // Counts attempts in a fixed window; true while under the limit.
  async hit(limit, windowSeconds) {
    const now = Date.now();
    const state = (await this.ctx.storage.get("rate")) ?? { start: now, count: 0 };
    if (now - state.start > windowSeconds * 1000) { state.start = now; state.count = 0; }
    state.count += 1;
    await this.ctx.storage.put("rate", state);
    await this.ctx.storage.setAlarm(state.start + windowSeconds * 1000 + 1000);
    return state.count <= limit;
  }

  async alarm() { await this.ctx.storage.deleteAll(); }
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Mail goes out through a small sender. Resend is built in (one HTTPS call); any other service can be added here.
export async function sendLink(env, { to, url }) {
  if (env.MAIL_PROVIDER !== "resend" || !env.RESEND_API_KEY || !env.EMAIL_LINK_FROM) throw new Error("mail_not_configured");
  const brand = env.EMAIL_LINK_BRAND ?? "Support";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_LINK_FROM, to: [to], subject: `Your ${brand} sign-in link`,
      text: `Open this link to sign in to ${brand} support. It works once and expires in 15 minutes.\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("mail_failed_" + response.status);
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The emailed link only opens this page. Signing in needs a button press (a POST), so mail scanners that
// fetch links in advance cannot use up the token.
export function confirmPage(token, brand = "Support") {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9}main{background:#fff;padding:32px;border-radius:12px;max-width:360px;box-shadow:0 2px 12px #0002;text-align:center}button{font:inherit;padding:12px 24px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}</style>
<main><h1>${escapeHtml(brand)} support</h1><p>Confirm to finish signing in.</p>
<form method="post" action="/api/auth/email/verify"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Sign in</button></form></main></html>`;
}
