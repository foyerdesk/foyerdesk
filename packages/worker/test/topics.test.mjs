import assert from "node:assert/strict";
import test from "node:test";
import * as t from "../src/topics.mjs";

const mapping = { contactId: 7, inboxId: 5 };
const conv = (over = {}) => ({ id: 1, status: "open", inbox_id: 5, meta: { sender: { id: 7 } }, custom_attributes: { subject: "Billing" }, last_activity_at: 100, contact_last_seen_at: 0,
  messages: [{ message_type: 0, content: "Hello", private: false }], ...over });

test("statuses: the customer sees Open, Pending or Resolved; snoozed is shown as Pending; unknown falls back to Open", () => {
  assert.deepEqual(["open", "pending", "snoozed", "resolved", "weird"].map(t.statusLabel), ["Open", "Pending", "Pending", "Resolved", "Open"]);
  assert.deepEqual(["open", "pending", "snoozed", "resolved"].map(t.tabOf), ["open", "open", "open", "resolved"]);
});

test("actions: unresolved topics can be replied to or resolved; resolved ones replied to or reopened; nothing else", () => {
  assert.deepEqual(t.allowedActions("open"), ["reply", "resolve"]);
  assert.deepEqual(t.allowedActions("pending"), ["reply", "resolve"]);
  assert.deepEqual(t.allowedActions("resolved"), ["reply", "reopen"]);
  assert.equal(t.nextStatus("open", "resolve"), "resolved");
  assert.equal(t.nextStatus("resolved", "reopen"), "open");
  assert.equal(t.nextStatus("open", "reopen"), null);
  assert.equal(t.nextStatus("resolved", "resolve"), null);
  for (const forbidden of ["snooze", "pending", "assign", "delete", ""]) assert.equal(t.nextStatus("open", forbidden), null);
});

test("ownership: only the customer's own topic in the site inbox is visible; everything else is the same 'not found'", () => {
  assert.ok(t.ownedTopic(conv(), mapping));
  assert.equal(t.ownedTopic(conv({ meta: { sender: { id: 8 } } }), mapping), null);   // another customer
  assert.equal(t.ownedTopic(conv({ inbox_id: 6 }), mapping), null);                   // the e-mail inbox
  assert.equal(t.ownedTopic(conv({ meta: {} }), mapping), null);
  for (const bad of [null, undefined, "x", 5, []]) assert.equal(t.ownedTopic(bad, mapping), null);
  assert.equal(t.ownedTopic(conv({ meta: { sender: { id: "7abc" } } }), mapping), null); // no loose number parsing
});

test("new topic: subject is optional, derived from the first line at a word boundary, and bounded", () => {
  assert.equal(t.validateNewTopic({ message: "How do I get my certificate?" }).subject, "How do I get my certificate?");
  const long = "word ".repeat(30);
  const derived = t.validateNewTopic({ message: long }).subject;
  assert.ok(derived.endsWith("…") && derived.length <= 61 && !derived.slice(0, -1).endsWith(" "));
  assert.equal(t.validateNewTopic({ message: "Line one\nline two secret" }).subject, "Line one");
  assert.equal(t.validateNewTopic({ message: "Hi there", subject: "  Course access  " }).subject, "Course access");
  assert.equal(t.validateNewTopic({ message: "Hi there", subject: "ab" }).error, "invalid_subject");
  assert.equal(t.validateNewTopic({ message: "Hi there", subject: "x".repeat(121) }).error, "invalid_subject");
  assert.equal(t.validateNewTopic({ message: "   " }).error, "message_required");
  assert.equal(t.validateNewTopic({ message: "x".repeat(3001) }).error, "message_too_long");
  assert.equal(t.validateNewTopic({ message: 42 }).error, "message_required");
  assert.equal(t.validateNewTopic({ message: "ok\u0000 text" }).message, "ok text");
  assert.equal(t.validateNewTopic({ message: "ok" }).error, "invalid_subject"); // too short to be a subject, asks for one
});

test("abuse guard: ten unresolved topics is the limit; resolved topics do not count", () => {
  const nine = Array.from({ length: 9 }, (_, i) => conv({ id: i }));
  assert.equal(t.canOpenTopic(nine), true);
  assert.equal(t.canOpenTopic([...nine, conv({ id: 99 })]), false);
  const manyResolved = Array.from({ length: 30 }, (_, i) => conv({ id: 300 + i, status: "resolved" }));
  assert.equal(t.canOpenTopic([...nine, ...manyResolved]), true);
});

test("list page: newest activity first, own topics only, activity and private notes hidden, unread flag, page count", () => {
  const response = { payload: [
    conv({ id: 1, last_activity_at: 10 }),
    conv({ id: 2, last_activity_at: 30, messages: [{ message_type: 1, content: "We replied", private: false }, { message_type: 2, content: "Assigned", private: false }, { message_type: 1, content: "internal", private: true }] }),
    conv({ id: 3, last_activity_at: 20, meta: { sender: { id: 99 } } }),
    conv({ id: 4, last_activity_at: 5, status: "resolved", custom_attributes: {} }),
  ], meta: { all_count: 60 } };
  const page = t.topicPage(response, mapping, 2);
  assert.deepEqual(page.topics.map((x) => x.id), [2, 1, 4]);
  assert.equal(page.topics[0].preview, "We replied");
  assert.equal(page.topics[0].unread, true);
  assert.equal(page.topics[1].unread, false);          // last message is the customer's own
  assert.equal(page.topics[2].subject, "Topic #4");
  assert.equal(page.topics[2].tab, "resolved");
  assert.deepEqual([page.page, page.pages, page.total], [2, 3, 60]);
  assert.equal(t.topicPage({ payload: [], meta: { all_count: 0 } }, mapping, 1).pages, 1);
  assert.equal(t.topicPage({ payload: [conv()] }, mapping, 1).total, 1);       // no meta: falls back to what came back
  assert.equal(t.topicPage(null, mapping, 1).topics.length, 0);
});

test("list request: contact and inbox come from the session; tab picks statuses; bad page or tab is refused", () => {
  const open = t.listFilter(mapping, "open");
  assert.deepEqual(open.map((x) => [x.attribute_key, x.values]), [["contact_id", [7]], ["inbox_id", [5]], ["status", ["open", "pending", "snoozed"]]]);
  assert.deepEqual(open.map((x) => x.query_operator), ["AND", "AND", null]);   // Chatwoot rejects a last element with an operator
  assert.deepEqual(t.listFilter(mapping, "resolved")[2].values, ["resolved"]);
  assert.deepEqual([undefined, "", "1", "12", "0", "-1", "1.5", "abc", "99999"].map(t.parsePage), [1, 1, 1, 12, null, null, null, null, null]);
  assert.deepEqual([undefined, "", "all", "open", "resolved", "OPEN", "x;y"].map(t.parseTab), ["all", "all", "all", "open", "resolved", null, null]);
  const all = t.listFilter(mapping, "all");
  assert.deepEqual(all.map((x) => [x.attribute_key, x.query_operator]), [["contact_id", "AND"], ["inbox_id", null]]); // history: no status condition at all
});

test("create is never repeated: same request returns the same topic, a changed body conflicts, an unknown outcome reconciles", () => {
  const ledger = new Map();
  assert.deepEqual(t.createDecision(ledger, "r1", "d1"), { action: "create" });
  ledger.set("r1", { digest: "d1", conversationId: null });
  assert.deepEqual(t.createDecision(ledger, "r1", "d1"), { action: "reconcile" });
  assert.deepEqual(t.createDecision(ledger, "r1", "other"), { action: "conflict" });
  ledger.set("r1", { digest: "d1", conversationId: 55 });
  assert.deepEqual(t.createDecision(ledger, "r1", "d1"), { action: "return", conversationId: 55 });
});

test("push: 'changed' with or without a topic id parses; anything else is ignored", () => {
  assert.deepEqual(t.parsePush("changed"), { conversationId: null });
  assert.deepEqual(t.parsePush(t.pushMessage(42)), { conversationId: 42 });
  for (const bad of ["pong", "changed:", "changed:abc", "changed:1; drop", "", null]) assert.equal(t.parsePush(bad), null);
});

test("forms and rating requests are not shown to the customer, text and emailed replies are", () => {
  const m = (over) => ({ message_type: 3, content: "x", private: false, ...over });
  assert.equal(t.showsToCustomer(m({ content_type: "input_csat", content: "Please rate the conversation" })), false);
  assert.equal(t.showsToCustomer(m({ content_type: "input_select" })), false);
  assert.equal(t.showsToCustomer(m({ content_type: "form" })), false);
  assert.equal(t.showsToCustomer(m({ content_type: "text" })), true);
  assert.equal(t.showsToCustomer(m({ message_type: 0, content_type: "incoming_email" })), true);
  assert.equal(t.showsToCustomer(m({ message_type: 0, content_type: undefined })), true);
  assert.equal(t.showsToCustomer(m({ message_type: 2 })), false);
  assert.equal(t.showsToCustomer(m({ private: true, message_type: 1 })), false);
  const page = t.topicPage({ payload: [conv({ id: 9, status: "resolved", messages: [{ message_type: 3, content_type: "input_csat", content: "Please rate the conversation", private: false }] })], meta: { all_count: 1 } }, mapping, 1);
  assert.equal(page.topics[0].preview, "");
});
