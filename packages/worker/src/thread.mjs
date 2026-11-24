import { DurableObject } from "cloudflare:workers";
import * as topics from "./topics.mjs";
import { trimSlashes } from "./contact.mjs";

const chatwootOrigin = (env) => trimSlashes(String(env.CHATWOOT_BASE_URL));
const base = (env) => `${chatwootOrigin(env)}/api/v1/accounts/${String(env.CHATWOOT_ACCOUNT_ID)}`;
// Name of the message attribute that carries the visitor's request id, so a retried request is recognised. Changing it loses that recognition for old messages.
let requestMarker = "foyerdesk_request_id";
const writeLimit = 30;

export class TestSupportThread extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (env.REQUEST_MARKER) requestMarker = String(env.REQUEST_MARKER);
  }

  // Request records (the idempotency ledger) are kept 48 hours, then removed by a daily alarm. A retry later than that is a new request.
  async remember() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
  }

  // Removes request records older than 48 hours; returns how many. Called by the daily alarm.
  async purge() {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    let removed = 0;
    for (const prefix of ["request:", "topic-request:"]) {
      const rows = await this.ctx.storage.list({ prefix });
      const old = [...rows].filter(([, value]) => !(value?.at > cutoff)).map(([key]) => key);
      if (old.length) await this.ctx.storage.delete(old);
      removed += old.length;
    }
    return removed;
  }

  async alarm() {
    await this.purge();
    const left = (await this.ctx.storage.list({ prefix: "request:" })).size + (await this.ctx.storage.list({ prefix: "topic-request:" })).size;
    if (left) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
  }

  // At most `writeLimit` writes a minute per customer. Kept in memory on purpose: it costs no storage write, and a restarted object only forgets the last minute.
  tooMany() {
    const now = Date.now();
    this.recent = (this.recent ?? []).filter((at) => now - at < 60000);
    if (this.recent.length >= writeLimit) return true;
    this.recent.push(now);
    return false;
  }

  async api(path, data) {
    const response = await fetch(base(this.env) + path, {
      method: data ? "POST" : "GET",
      headers: { api_access_token: this.env.CHATWOOT_APPLICATION_TOKEN, "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404 && path.startsWith("/contacts/")) throw new Error("contact_gone");
    if (response.status === 404 && path.startsWith("/conversations/")) throw new Error("topic_not_found");
    if (response.status === 404 && path === "/conversations") throw new Error("contact_gone"); // the contact or its inbox link was deleted
    if (!response.ok) throw new Error("chatwoot_request_failed");
    return response.json();
  }

  // All conversations of this contact in this inbox, oldest first.
  async getConversations({ contactId, inboxId }) {
    const { payload } = await this.api(`/contacts/${contactId}/conversations`);
    return payload.filter((row) => row.inbox_id === inboxId).sort((x, y) => x.id - y.id);
  }

  // Conversation that receives new messages: the newest one that is not resolved.
  // Undefined means a new conversation is created (all previous ones are resolved).
  async getConversation(mapping) {
    const open = (await this.getConversations(mapping)).filter((row) => row.status !== "resolved");
    return open.at(-1)?.id;
  }

  async getMessages(id) {
    if (id === undefined) return [];
    return (await this.api(`/conversations/${id}/messages`)).payload;
  }

  // Chatwoot returns at most 20 messages per request: the latest 20, or with before=<id> the 20 before it, or with
  // after=<id> up to 100 after it (MessageFinder, v4.20.1). History is therefore read in pages, never "everything".
  // An email reply is stored with its quoted history; show only the new text (Chatwoot keeps it in text_content.reply).
  visible(messages) {
    const textOf = (m) => m.content_type === "incoming_email"
      ? (m.content_attributes?.email?.text_content?.reply?.trim() || m.content) : m.content;
    // Time and the replying team member's first name are shown on the page. Template/automatic messages have no author.
    const authorOf = (m) => m.message_type === 1 && m.sender?.type === "user" && typeof m.sender.available_name === "string" &&
      m.sender.available_name.trim() && !/api/i.test(m.sender.available_name) ? m.sender.available_name.trim().split(/\s+/)[0].slice(0, 40) : null;
    return messages.filter(topics.showsToCustomer)
      .map((m) => ({ id: m.id, conversation_id: m.conversation_id, message_type: m.message_type, text: textOf(m),
        direction: m.message_type === 0 ? "visitor" : "support",
        at: Number.isFinite(m.created_at) ? m.created_at : null, author: authorOf(m) }))
      .sort((x, y) => x.id - y.id);
  }

  async deliver(mapping, rows, hasMore) {
    const last = rows.at(-1);
    if (last?.message_type === 1) await this.markSeen(mapping, { id: last.id, conversation_id: last.conversation_id });
    return { messages: rows.map(({ id, text, direction, at, author }) => ({ id, text, direction, at, author })), hasMore };
  }

  // One page of the thread, newest first when walking conversations: the latest `limit` messages, or the `limit` before `before`.
  // The thread spans the contact's conversations in this inbox (the newest `maxConversations`).
  async page(mapping, { before, limit = 20, maxConversations = 6 } = {}) {
    const conversations = (await this.getConversations(mapping)).reverse();
    const walk = conversations.slice(0, maxConversations);
    const rows = [];
    let more = conversations.length > maxConversations;
    let visited = 0;
    for (const conversation of walk) {
      const raw = (await this.api(`/conversations/${conversation.id}/messages` + (before ? `?before=${before}` : ""))).payload;
      visited += 1;
      rows.push(...this.visible(raw));
      if (raw.length >= 20) more = true; // this conversation may hold older messages
      if (rows.length >= limit) break;
    }
    if (visited < walk.length) more = true; // older conversations were not read yet
    rows.sort((x, y) => y.id - x.id);
    if (rows.length > limit) { rows.length = limit; more = true; }
    return this.deliver(mapping, rows.reverse(), more);
  }

  // Messages newer than `after`, for the cheap periodic refresh. Looks at the newest three conversations.
  async since(mapping, after) {
    const conversations = (await this.getConversations(mapping)).reverse().slice(0, 3);
    const rows = [];
    for (const conversation of conversations) {
      rows.push(...this.visible((await this.api(`/conversations/${conversation.id}/messages?after=${after}`)).payload));
    }
    rows.sort((x, y) => x.id - y.id);
    return this.deliver(mapping, rows, false);
  }

  // The customer is reading the reply on the page: tell Chatwoot, so it does not send the reply by email.
  async markSeen(mapping, last) {
    const identifier = this.env.CHATWOOT_INBOX_IDENTIFIER;
    const seenKey = "seen:" + last.conversation_id;
    if (!identifier || (await this.ctx.storage.get(seenKey) ?? 0) >= last.id) return;
    try {
      const response = await fetch(
        `${chatwootOrigin(this.env)}/public/api/v1/inboxes/${identifier}/contacts/${mapping.sourceId}` +
        `/conversations/${last.conversation_id}/update_last_seen`,
        { method: "POST", signal: AbortSignal.timeout(5000) });
      if (response.ok) await this.ctx.storage.put(seenKey, last.id);
    } catch { /* a missed mark only means an extra email */ }
  }

  async finish(requestId, digest) {
    await this.ctx.storage.put({ ["request:" + requestId]: { at: Date.now(), digest, status: "accepted" }, pending: null });
    return "accepted";
  }

  // ---- Topics: one topic = one Chatwoot conversation of this customer in the site inbox ----
  // The service token can read every conversation of the account, so every topic call starts with an owner check.
  async ownedTopic(mapping, id) {
    let conversation;
    try { conversation = await this.api(`/conversations/${id}`); } catch (error) {
      if (String(error?.message).includes("topic_not_found")) throw new Error("topic_not_found");
      throw error;
    }
    if (!topics.ownedTopic(conversation, mapping)) throw new Error("topic_not_found");
    return conversation;
  }

  async listTopics(mapping, tab, page) {
    const response = await this.api(`/conversations/filter?page=${page}`, { payload: topics.listFilter(mapping, tab) });
    return topics.topicPage(response, mapping, page);
  }

  // One page of one topic's messages, same cursors as the single thread: latest 20, ?before=, ?after=.
  async topicMessages(mapping, id, { before, after } = {}) {
    const conversation = await this.ownedTopic(mapping, id);
    const query = before ? `?before=${before}` : after ? `?after=${after}` : "";
    const raw = (await this.api(`/conversations/${id}/messages${query}`)).payload;
    const rows = this.visible(raw);
    const delivered = await this.deliver(mapping, rows, !after && raw.length >= 20);
    return { ...delivered, topic: { id: conversation.id, subject: topics.cleanText(conversation.custom_attributes?.subject) || `Topic #${conversation.id}`,
      status: topics.statusLabel(conversation.status), actions: topics.allowedActions(conversation.status) } };
  }

  // The same request id must never create or write twice, even when the answer was lost on the way back.
  async digestOf(...parts) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))))).join(",");
  }

  async createTopic(mapping, requestId, input) {
    if (this.tooMany()) return { error: "rate_limited" };
    const valid = topics.validateNewTopic(input ?? {});
    if (valid.error) return { error: valid.error };
    const digest = await this.digestOf("create", valid.subject, valid.message);
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.remember();
      const key = "topic-request:" + requestId;
      const seen = await this.ctx.storage.get(key);
      if (seen && seen.digest !== digest) return { error: "conflict" };
      if (seen?.conversationId) return { id: seen.conversationId, repeated: true };
      if (seen) { // answer lost last time: find the topic the first attempt created before anything is written again
        const found = (await this.api(`/conversations/filter?page=1`, { payload: topics.listFilter(mapping, "open") })).payload
          ?.find((row) => row.custom_attributes?.request_id === requestId && topics.ownedTopic(row, mapping));
        if (found) { await this.ctx.storage.put(key, { at: Date.now(), digest, conversationId: found.id }); return { id: found.id, repeated: true }; }
      } else {
        const open = await this.api(`/conversations/filter?page=1`, { payload: topics.listFilter(mapping, "open") });
        if ((open.meta?.all_count ?? 0) >= topics.MAX_ACTIVE_TOPICS) return { error: "too_many_open_topics" };
        await this.ctx.storage.put(key, { at: Date.now(), digest, conversationId: null });
      }
      let created;
      try {
        created = await this.api("/conversations", { inbox_id: mapping.inboxId, contact_id: mapping.contactId, source_id: mapping.sourceId,
          status: "open", custom_attributes: { subject: valid.subject, request_id: requestId },
          message: { content: valid.message, message_type: "incoming", private: false, content_attributes: { [requestMarker]: requestId } } });
      } catch (error) { if (String(error?.message).includes("contact_gone")) throw error; return { error: "unconfirmed" }; }
      await this.ctx.storage.put(key, { at: Date.now(), digest, conversationId: created.id });
      return { id: created.id };
    });
  }

  async replyTopic(mapping, id, requestId, text) {
    if (this.tooMany()) return { error: "rate_limited" };
    const message = topics.cleanText(text);
    if (!message) return { error: "message_required" };
    if (message.length > topics.MESSAGE_MAX) return { error: "message_too_long" };
    await this.ownedTopic(mapping, id);
    const digest = await this.digestOf("reply", id, message);
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.remember();
      const key = "topic-request:" + requestId;
      const seen = await this.ctx.storage.get(key);
      if (seen && seen.digest !== digest) return { error: "conflict" };
      if (seen?.status === "accepted") return { accepted: true, repeated: true };
      if (seen) { // unknown outcome: read the topic back before writing again
        const raw = (await this.api(`/conversations/${id}/messages`)).payload;
        if (raw.some((m) => m.message_type === 0 && m.content_attributes?.[requestMarker] === requestId)) {
          await this.ctx.storage.put(key, { at: Date.now(), digest, status: "accepted" });
          return { accepted: true, repeated: true };
        }
      } else {
        await this.ctx.storage.put(key, { at: Date.now(), digest, status: "pending" });
      }
      try {
        await this.api(`/conversations/${id}/messages`, { message_type: "incoming", content: message, private: false, content_attributes: { [requestMarker]: requestId } });
      } catch { return { error: "unconfirmed" }; }
      await this.ctx.storage.put(key, { at: Date.now(), digest, status: "accepted" });
      return { accepted: true };
    });
  }

  // The customer can only close or reopen their own topic. Asking for the state it already has is not an error (double click).
  async changeTopic(mapping, id, action) {
    if (this.tooMany()) return { error: "rate_limited" };
    const conversation = await this.ownedTopic(mapping, id);
    const target = action === "resolve" ? "resolved" : action === "reopen" ? "open" : null;
    if (!target) return { error: "invalid_action" };
    if ((target === "resolved") === (conversation.status === "resolved")) {
      return { status: topics.statusLabel(conversation.status), actions: topics.allowedActions(conversation.status), repeated: true };
    }
    if (!topics.nextStatus(conversation.status, action)) return { error: "conflict" };
    await this.api(`/conversations/${id}/toggle_status`, { status: target });
    return { status: topics.statusLabel(target), actions: topics.allowedActions(target) };
  }

  async send(mapping, requestId, text) {
    if (this.tooMany()) return "rate_limited";
    const digest = Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )).join(",");
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.remember();
      const existing = await this.ctx.storage.get("request:" + requestId);
      if (existing && existing.digest !== digest) return "conflict";
      if (existing?.status === "accepted") return "accepted";

      const pending = await this.ctx.storage.get("pending");
      const conversation = await this.getConversation(mapping);
      if (pending) {
        if (pending !== requestId) return "pending";
        const messages = await this.getMessages(conversation);
        const found = messages.some((m) => m.message_type === 0 && m.content_attributes?.[requestMarker] === requestId);
        return found ? this.finish(requestId, digest) : "pending";
      }

      await this.ctx.storage.put({ ["request:" + requestId]: { at: Date.now(), digest, status: "pending" }, pending: requestId });
      const message = { message_type: "incoming", content: text, private: false,
        content_attributes: { [requestMarker]: requestId } };
      try {
        if (conversation === undefined) {
          await this.api("/conversations", { inbox_id: mapping.inboxId, contact_id: mapping.contactId,
            source_id: mapping.sourceId, status: "open", message });
        } else {
          await this.api(`/conversations/${conversation}/messages`, message);
        }
      } catch {
        // A failed or lost response is ambiguous. Keep the reservation for readback.
        return "pending";
      }
      return this.finish(requestId, digest);
    });
  }
}
