import { DurableObject } from "cloudflare:workers";
import { readLimited } from "./limits.mjs";

// Chatwoot tells the Worker (signed webhook) that a reply exists; the open page is told "changed" over a
// hibernating WebSocket and then reads the messages through the normal authenticated history request.
// The socket never carries message text, so it cannot leak a conversation.
export const streamKey = ({ inboxId, contactId }) => `inbox-${inboxId}-contact-${contactId}`;

const maxSockets = 8; // per contact; the oldest is closed when a ninth tab connects

export class SupportStream extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const open = this.ctx.getWebSockets();
    for (const socket of open.slice(0, Math.max(0, open.length - maxSockets + 1))) {
      try { socket.close(1000, "replaced"); } catch { /* already closed */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async notify(conversationId) {
    let sent = 0;
    const message = Number.isSafeInteger(conversationId) && conversationId > 0 ? `changed:${conversationId}` : "changed";
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); sent += 1; } catch { /* the page reconnects */ }
    }
    return sent;
  }

  // Sign-out: every open page of this contact is closed; a page that is still signed in reconnects with its own session.
  async closeAll() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(4401, "signed_out"); } catch { /* already closed */ }
    }
  }

  async webSocketMessage() { /* nothing is read from the page except the runtime-handled ping */ }
  async webSocketClose(socket, code) { try { socket.close(code === 1005 ? 1000 : code, "closed"); } catch { /* already closed */ } }
  async webSocketError(socket) { try { socket.close(1011, "error"); } catch { /* already closed */ } }
}

const hex = (text) => (/^[0-9a-f]{64}$/i.test(text) ? Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16)) : null);

// Chatwoot signs "<X-Chatwoot-Timestamp>.<raw body>" with HMAC-SHA256 (webhook secret) and sends "sha256=<hex>"
// in X-Chatwoot-Signature (lib/webhooks/trigger.rb, v4.20.1).
export async function verifyWebhook(request, secret, nowMs = Date.now()) {
  if (!secret) return { status: 503, error: "webhook_secret_unavailable" };
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 262144) return { status: 413, error: "request_too_large" };
  const timestamp = request.headers.get("X-Chatwoot-Timestamp") ?? "";
  const signature = hex((request.headers.get("X-Chatwoot-Signature") ?? "").replace(/^sha256=/, ""));
  if (!/^[0-9]{10}$/.test(timestamp) || !signature) return { status: 401, error: "signature_required" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return { status: 401, error: "stale_signature" };
  const body = await readLimited(request, 262144);
  if (body === null) return { status: 413, error: "request_too_large" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${timestamp}.${body}`))) {
    return { status: 401, error: "bad_signature" };
  }
  try { return { status: 200, payload: JSON.parse(body) }; } catch { return { status: 400, error: "invalid_json" }; }
}

// Which page should be told? Only a visible reply (or an emailed reply) in the web inbox; nothing else is worth a wake-up.
export function streamTarget(payload, inboxId) {
  if (payload?.event !== "message_created" || payload.private === true) return null;
  const inbox = Number(payload.inbox?.id ?? payload.conversation?.inbox_id);
  if (inbox !== inboxId) return null;
  const type = payload.message_type;
  const fromTeam = type === "outgoing" || type === 1 || type === "template" || type === 3;
  const fromEmail = payload.content_type === "incoming_email";
  if (!fromTeam && !fromEmail) return null;
  const contactId = Number(payload.conversation?.meta?.sender?.id);
  const conversationId = Number(payload.conversation?.id);
  return Number.isSafeInteger(contactId) && contactId > 0 ? { inboxId, contactId, conversationId: Number.isSafeInteger(conversationId) && conversationId > 0 ? conversationId : null } : null;
}
