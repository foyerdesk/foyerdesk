// A small stand-in for the Worker, following the same contract (see docs/UI_PLAN.md and the Worker routes).
export const row = (id, over = {}) => ({ id, subject: `Topic ${id}`, status: "Open", tab: "open", preview: `Preview ${id}`, at: 1795500000 + id, unread: false, ...over });
const msg = (id, direction, text, at = 1795500000 + id * 60) => ({ id, direction, text, at, author: direction === "support" ? "Stan" : null });

export async function mockApi(page, { signedIn = true, topics = [row(1)], messages = {}, account = { name: "Alex Example", email: "alex@example.com", provider: "google", picture: null } } = {}) {
  const st = { signedIn, topics, messages, account, calls: [], posts: [], sockets: [], logout: 0, createFault: null, seenOnOpen: true };
  const find = (id) => st.topics.find((x) => x.id === id);
  await page.routeWebSocket(/\/api\/support\/stream/, (ws) => {
    const entry = { send: (m) => ws.send(m), close: () => ws.close(), closed: false, pings: 0 };
    ws.onMessage((m) => { if (m === "ping") entry.pings += 1; }); ws.onClose(() => { entry.closed = true; });
    st.sockets.push(entry);
  });
  await page.route("**/api/auth/logout", async (route) => { st.logout += 1; st.signedIn = false; await route.fulfill({ status: 204 }); });
  await page.route("**/api/support/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname.replace("/api/support", "");
    st.calls.push(req.method() + " " + path + url.search);
    if (!st.signedIn) return route.fulfill({ status: 401, json: { error: "sign_in_required" } });
    if (path === "/session") return route.fulfill({ json: { account: st.account } });
    if (path === "/topics" && req.method() === "GET") {
      const tab = url.searchParams.get("tab"), page_ = Number(url.searchParams.get("page"));
      const all = st.topics.filter((x) => tab === "all" || (tab === "resolved") === (x.status === "Resolved")).sort((a, b) => b.at - a.at);
      return route.fulfill({ json: { topics: all.slice((page_ - 1) * 25, page_ * 25), page: page_, pages: Math.max(1, Math.ceil(all.length / 25)), total: all.length } });
    }
    if (path === "/topics" && req.method() === "POST") {
      const body = req.postDataJSON(); st.posts.push({ path, body });
      if (st.createFault === "lost") { st.createFault = null; if (!st.created) { st.created = body.requestId; st.topics.push(row(900, { subject: body.subject ?? body.message.split("\n")[0] })); } return route.fulfill({ status: 503, json: { error: "unconfirmed" } }); }
      if (st.createFault === "limit") return route.fulfill({ status: 429, json: { error: "too_many_open_topics" } });
      if (st.created === body.requestId) return route.fulfill({ status: 200, json: { id: 900 } });
      const id = 900; st.topics.push(row(id, { subject: body.subject ?? body.message.split("\n")[0] })); st.messages[id] = [msg(1, "visitor", body.message)];
      return route.fulfill({ status: 201, json: { id } });
    }
    const m = /^\/topics\/(\d+)\/(messages|resolve|reopen)$/.exec(path);
    if (m) {
      const id = Number(m[1]), topic = find(id);
      if (!topic) return route.fulfill({ status: 404, json: { error: "topic_not_found" } });
      const actions = () => (topic.status === "Resolved" ? ["reply", "reopen"] : ["reply", "resolve"]);
      if (m[2] === "messages" && req.method() === "GET") {
        const list = st.messages[id] ?? []; const after = url.searchParams.get("after"), before = url.searchParams.get("before");
        let out = list;
        if (after) out = list.filter((x) => x.id > Number(after)); else if (before) out = list.filter((x) => x.id < Number(before)).slice(-20); else out = list.slice(-20);
        if (st.seenOnOpen && !after) topic.unread = false;
        return route.fulfill({ json: { messages: out, hasMore: !after && (before ? list.filter((x) => x.id < Number(before)).length > 20 : list.length > 20), topic: { id, subject: topic.subject, status: topic.status, actions: actions() } } });
      }
      if (m[2] === "messages") { const b = req.postDataJSON(); st.posts.push({ path, body: b }); (st.messages[id] ??= []).push(msg((st.messages[id]?.length ?? 0) + 1, "visitor", b.message)); return route.fulfill({ json: { accepted: true } }); }
      if (m[2] === "resolve") { topic.status = "Resolved"; topic.tab = "resolved"; return route.fulfill({ json: { status: "Resolved", actions: actions() } }); }
      if (m[2] === "reopen") { topic.status = "Open"; topic.tab = "open"; return route.fulfill({ json: { status: "Open", actions: actions() } }); }
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return st;
}
export { msg };
