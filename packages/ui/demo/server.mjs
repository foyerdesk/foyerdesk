// Try the screens without Chatwoot or a sign-in provider: the real browser module with a small in-memory stand-in for the Worker.
// Everything resets when the process stops. Usage: npm run demo -w packages/ui, then open http://127.0.0.1:4180/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const now = () => Math.floor(Date.now() / 1000);
let signedIn = true, nextId = 4;
const topics = new Map([
  [1, { id: 1, subject: "Certificate shows the wrong name", status: "Open", unread: true, messages: [
    { direction: "visitor", text: "Hello, my certificate shows a misspelled name." },
    { direction: "support", text: "Hi, thank you for telling us. Which spelling would you like on it?", author: "Sam" }] }],
  [2, { id: 2, subject: "Question about my invoice", status: "Pending", unread: false, messages: [{ direction: "visitor", text: "Where can I download my invoice?" }] }],
  [3, { id: 3, subject: "How do I change my email address?", status: "Resolved", unread: false, messages: [
    { direction: "visitor", text: "How do I change my email address?" }, { direction: "support", text: "Done, sign in with the new address.", author: "Sam" }] }],
]);
for (const topic of topics.values()) topic.messages.forEach((m, i) => Object.assign(m, { id: i + 1, at: now() - 3600 * (topics.size - topic.id + 1) + i * 60 }));
const actions = (t) => (t.status === "Resolved" ? ["reply", "reopen"] : ["reply", "resolve"]);
const item = (t) => ({ id: t.id, subject: t.subject, status: t.status, tab: t.status === "Resolved" ? "resolved" : "open", preview: t.messages.at(-1).text, at: t.messages.at(-1).at, unread: t.unread });
const send = (res, status, data) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(data === undefined ? undefined : JSON.stringify(data));
const body = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; } };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), path = url.pathname;
  if (path === "/api/auth/login") { signedIn = true; res.writeHead(302, { Location: "/" }).end(); return; }
  if (path === "/api/auth/logout") { signedIn = false; return send(res, 204); }
  if (path === "/api/support/stream") return send(res, 426, { error: "demo has no live socket; the page checks now and then instead" });
  if (path.startsWith("/api/support/")) {
    if (!signedIn) return send(res, 401, { error: "sign_in_required" });
    const route = path.slice("/api/support".length);
    if (route === "/session") return send(res, 200, { account: { name: "Demo Visitor", email: "visitor@example.com", provider: "email", picture: null } });
    if (route === "/topics" && req.method === "GET") {
      const tab = url.searchParams.get("tab") ?? "all";
      const list = [...topics.values()].map(item).filter((t) => tab === "all" || t.tab === tab).sort((a, b) => b.at - a.at);
      return send(res, 200, { topics: list.slice(0, 25), page: 1, pages: 1, total: list.length });
    }
    if (route === "/topics" && req.method === "POST") {
      const data = await body(req), id = nextId++;
      topics.set(id, { id, subject: (data.subject || String(data.message).split("\n")[0]).slice(0, 120), status: "Open", unread: false, messages: [{ id: 1, direction: "visitor", text: String(data.message ?? ""), at: now() }] });
      return send(res, 201, { id });
    }
    const m = /^\/topics\/(\d+)\/(messages|resolve|reopen)$/.exec(route), topic = m && topics.get(Number(m[1]));
    if (!m || !topic) return send(res, 404, { error: "topic_not_found" });
    if (m[2] === "messages" && req.method === "GET") {
      topic.unread = false;
      return send(res, 200, { messages: topic.messages, hasMore: false, topic: { id: topic.id, subject: topic.subject, status: topic.status, actions: actions(topic) } });
    }
    if (m[2] === "messages") {
      const data = await body(req);
      topic.messages.push({ id: topic.messages.length + 1, direction: "visitor", text: String(data.message ?? ""), at: now() });
      if (topic.status === "Resolved") topic.status = "Open";
      return send(res, 200, { accepted: true });
    }
    topic.status = m[2] === "resolve" ? "Resolved" : "Open";
    return send(res, 200, { status: topic.status, actions: actions(topic) });
  }
  const file = path === "/" || path === "/support" || path === "/talk" ? join(root, "test/harness/index.html") : normalize(join(root, path));
  if (!file.startsWith(root)) return send(res, 403);
  try { res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(await readFile(file)); } catch { send(res, 404, { error: "not_found" }); }
}).listen(4180, "127.0.0.1", () => console.log("FoyerDesk demo: http://127.0.0.1:4180/"));
