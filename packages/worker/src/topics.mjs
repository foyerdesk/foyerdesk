// Multi-topic support logic (design model, NOT imported by worker.mjs yet, so not deployed).
// Every rule here is tied to a Chatwoot 4.20.1 fact proved by ../../../probes/probe_chatwoot.py or probe_list_limit.py.
// One customer = one Chatwoot contact; one topic = one Chatwoot conversation in the site's web inbox.

export const SUBJECT_MIN = 3, SUBJECT_MAX = 120, MESSAGE_MAX = 3000;
export const MAX_ACTIVE_TOPICS = 10;      // abuse guard: open + pending + snoozed topics per customer
export const PAGE_SIZE = 25;              // POST /conversations/filter?page=N returns 25 per page, newest activity first (probe_list_limit.py). GET /contacts/{id}/conversations stops at 25 and has no paging, so it is NOT used for the list.

// What the customer sees. Chatwoot statuses: open, pending, snoozed, resolved (the standard help-desk set).
// Snoozed means "the team will look later", so the customer sees it as Pending. Customers never see "snoozed".
const LABEL = { open: "Open", pending: "Pending", snoozed: "Pending", resolved: "Resolved" };
export const statusLabel = (status) => LABEL[status] ?? "Open";
export const tabOf = (status) => (status === "resolved" ? "resolved" : "open");

// Customer actions and the Chatwoot call each one needs. A customer can only close a topic, reopen it, or write in it.
// Writing into a resolved topic also reopens it (Chatwoot does that itself: verified), so "reopen" is an explicit shortcut.
export function allowedActions(status) {
  return status === "resolved" ? ["reply", "reopen"] : ["reply", "resolve"];
}
export function nextStatus(status, action) {
  if (!allowedActions(status).includes(action)) return null;
  return action === "resolve" ? "resolved" : action === "reopen" ? "open" : status;
}

// The service token reads any conversation of the account (verified), so the Worker is the only guard.
// A topic that belongs to someone else, another inbox, or does not exist all answer the same: not found.
export function ownedTopic(conversation, mapping) {
  if (!conversation || typeof conversation !== "object") return null;
  const owner = Number(conversation.meta?.sender?.id ?? conversation.contact_id);
  const inbox = Number(conversation.inbox_id);
  return owner === mapping.contactId && inbox === mapping.inboxId ? conversation : null;
}

export const cleanText = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim() : "");

// Subject is optional: when the customer leaves it empty it is the first line of the question, cut at a word.
export function deriveSubject(message, given) {
  const wanted = cleanText(given);
  if (wanted) return wanted.length >= SUBJECT_MIN && wanted.length <= SUBJECT_MAX ? wanted : null;
  const first = cleanText(message).split(/\n/)[0].replace(/\s+/g, " ");
  if (first.length <= 60) return first.length >= SUBJECT_MIN ? first : (cleanText(message).length >= SUBJECT_MIN ? cleanText(message).slice(0, 60) : null);
  const cut = first.slice(0, 60);
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut) + "…";
}

export function validateNewTopic({ message, subject }) {
  const text = cleanText(message);
  if (!text) return { error: "message_required" };
  if (text.length > MESSAGE_MAX) return { error: "message_too_long" };
  const title = deriveSubject(text, subject);
  if (!title) return { error: "invalid_subject" };
  return { message: text, subject: title };
}

// A customer may not open unlimited topics. Only unresolved ones count.
export const canOpenTopic = (conversations) => conversations.filter((c) => c.status !== "resolved").length < MAX_ACTIVE_TOPICS;

// The list the page shows: newest activity first, subject from custom_attributes, last visible text as preview, unread flag.
// Activity messages (type 2) and private notes never reach the customer.
// Chatwoot also stores forms and rating requests ("Please rate the conversation") as messages. The customer cannot answer those here, so they are not shown.
export const showsToCustomer = (m) => !m.private && [0, 1, 3].includes(m.message_type) && typeof m.content === "string" &&
  (m.content_type === undefined || m.content_type === null || m.content_type === "text" || m.content_type === "incoming_email");

export function topicSummary(conversation) {
  const visible = (conversation.messages ?? []).filter(showsToCustomer);
  const last = visible.at(-1);
  const subject = cleanText(conversation.custom_attributes?.subject) || `Topic #${conversation.id}`;
  const lastAt = conversation.last_activity_at ?? 0;
  const seen = conversation.contact_last_seen_at ?? 0;
  return {
    id: conversation.id, subject, status: statusLabel(conversation.status), tab: tabOf(conversation.status),
    preview: last ? last.content.slice(0, 120) : "", at: lastAt,
    unread: Boolean(last && last.message_type !== 0 && lastAt > seen),
  };
}
// The list request. Both ids come from the server-side session, never from the browser. Tab "open" = open + pending + snoozed.
export function listFilter(mapping, tab) {
  const own = { attribute_key: "contact_id", filter_operator: "equal_to", values: [mapping.contactId], query_operator: "AND" };
  // "all" is the history: every topic of this customer, open or closed. The last condition must carry no operator.
  if (tab === "all") return [own, { attribute_key: "inbox_id", filter_operator: "equal_to", values: [mapping.inboxId], query_operator: null }];
  const statuses = tab === "resolved" ? ["resolved"] : ["open", "pending", "snoozed"];
  return [
    own,
    { attribute_key: "inbox_id", filter_operator: "equal_to", values: [mapping.inboxId], query_operator: "AND" },
    { attribute_key: "status", filter_operator: "equal_to", values: statuses, query_operator: null },
  ];
}
export const parsePage = (value) => (value === undefined || value === null || value === "" ? 1 : /^[0-9]{1,4}$/.test(String(value)) && Number(value) >= 1 ? Number(value) : null);
export const parseTab = (value) => (value === undefined || value === "" || value === "all" ? "all" : value === "open" ? "open" : value === "resolved" ? "resolved" : null);

// Chatwoot answers { payload: [...], meta: { all_count } } for the filter; the page shows "page X of Y" like a normal help desk.
export function topicPage(response, mapping, page) {
  const rows = (response?.payload ?? []).filter((c) => ownedTopic(c, mapping)).map(topicSummary).sort((a, b) => b.at - a.at);
  const total = Number.isSafeInteger(response?.meta?.all_count) ? response.meta.all_count : rows.length;
  return { topics: rows, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total };
}

// Creating a topic is not repeatable: a lost response must never produce a second conversation.
// ledger: Map(requestId -> { digest, conversationId | null }). Same id + same body => same topic (or read it back); same id + other body => conflict.
export function createDecision(ledger, requestId, digest) {
  const seen = ledger.get(requestId);
  if (!seen) return { action: "create" };
  if (seen.digest !== digest) return { action: "conflict" };
  return seen.conversationId ? { action: "return", conversationId: seen.conversationId } : { action: "reconcile" };
}

// The page is told "changed" over the live connection. The topic id is not secret to its owner, but the socket
// is per contact, so another customer can never receive it.
export const pushMessage = (conversationId) => `changed:${conversationId}`;
export const parsePush = (data) => { const m = /^changed(?::([0-9]{1,12}))?$/.exec(String(data)); return m ? { conversationId: m[1] ? Number(m[1]) : null } : null; };
