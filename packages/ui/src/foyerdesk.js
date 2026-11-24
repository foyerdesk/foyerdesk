// Foyerdesk screens. Call mountFoyerdesk(element, options). No framework; all text is added as text nodes.
// options: { lang, apiBase, authBase, loginUrl, brand, headingLevel }  (headingLevel: 1 by default; use 2 when the host page has its own h1)
import { h, clear } from "./dom.js";
import { createApi, newRequestId } from "./api.js";
import { translator } from "./i18n/index.js";

const SAFETY_MS = 300_000;   // double-check with the live connection open
const FALLBACK_MS = 20_000;  // checks without it, tab visible
const MIN_GAP_MS = 1_000;
const HEARTBEAT_MS = 50_000;
const SESSION_RESUME_MS = 30_000;

const parseRoute = () => {
  const hash = location.hash.replace(/^#/, "") || "/";
  let m;
  if ((m = /^\/topic\/([0-9]{1,12})$/.exec(hash))) return { name: "topic", id: Number(m[1]) };
  if (hash === "/new") return { name: "new" };
  if (hash === "/resolved") return { name: "list", tab: "resolved" };
  if (hash === "/open") return { name: "list", tab: "open" };
  return { name: "list", tab: "all" }; // the whole history, closed topics included
};

const initials = (name) => (String(name ?? "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?");

export function mountFoyerdesk(root, options = {}) {
  const t = translator(options.lang);
  const api = createApi(options.apiBase, options.authBase);
  const brand = options.brand ?? t("title");
  const loginUrl = options.loginUrl ?? "/api/auth/login?returnTo=" + encodeURIComponent(location.pathname);
  const level = options.headingLevel === 2 ? 2 : 1;
  const brandTag = "h" + level, titleTag = "h" + (level + 1);
  const baseTitle = document.title.replace(/^\(\d+\) /, "");

  const s = {
    epoch: 0, access: "checking", reason: null, account: null,
    recent: { topics: [], total: 0 }, route: parseRoute(), signedIn: false,
    ws: null, wsOpen: false, attempts: 0, timers: { safety: null, retry: null, heartbeat: null, gap: null }, lastRun: 0,
    newDraft: null, replyDraft: null, view: null,
  };
  const wrap = h("div", { class: "fd" });
  root.append(wrap);
  if (new URLSearchParams(location.search).has("auth_error")) {
    s.reason = "authError";
    history.replaceState(null, "", location.pathname + location.hash);
  }

  // ---------- helpers ----------
  const statusKey = (label) => "status_" + String(label).toLowerCase();
  const badge = (label) => h("span", { class: `fd-badge fd-${String(label).toLowerCase()}`, text: t(statusKey(label)) });
  const when = (at) => {
    if (!Number.isFinite(at) || at <= 0) return "";
    const d = new Date(at * 1000), now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  };
  const dayLabel = (at) => new Date(at * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const errorText = (res) => {
    const code = res.data?.error;
    const key = code ? "err_" + code : "";
    return key && t(key) !== key ? t(key) : t("err_generic");
  };
  const updateTitle = () => {
    const n = s.recent.topics.filter((x) => x.unread).length;
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  };

  // Where the visitor came from (for example ?src=linkedin). Kept for the tab and sent along with the sign-in link, so the site can tell the team.
  const sourceKey = "foyerdesk-src";
  const readSource = () => {
    try {
      const fromLink = (new URLSearchParams(location.search).get("src") ?? "").toLowerCase();
      if (/^[a-z0-9_-]{1,32}$/.test(fromLink)) sessionStorage.setItem(sourceKey, fromLink);
      return sessionStorage.getItem(sourceKey) ?? "";
    } catch { return ""; }
  };
  const signInHref = () => {
    const source = readSource();
    return source && !/[?&]src=/.test(loginUrl) ? loginUrl + (loginUrl.includes("?") ? "&" : "?") + "src=" + encodeURIComponent(source) : loginUrl;
  };
  readSource();

  // Text typed but not sent survives a sign-in or an ended session (kept in this tab only, and only offered again to the same account). Signing out deletes it.
  const draftPrefix = "foyerdesk-draft-";
  const draftOwner = () => String(s.account?.email ?? s.account?.name ?? "");
  const loadDraft = (name) => {
    try { const d = JSON.parse(sessionStorage.getItem(draftPrefix + name) ?? "null"); return d && d.owner === draftOwner() && draftOwner() ? d : null; } catch { return null; }
  };
  const saveDraft = (name, fields) => {
    try {
      if (Object.values(fields).every((v) => !String(v).trim())) sessionStorage.removeItem(draftPrefix + name);
      else sessionStorage.setItem(draftPrefix + name, JSON.stringify({ owner: draftOwner(), ...fields }));
    } catch { /* storage unavailable: the text just is not kept */ }
  };
  const clearDrafts = () => {
    try { Object.keys(sessionStorage).filter((k) => k.startsWith(draftPrefix)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* nothing kept */ }
  };

  // ---------- session and guest ----------
  function endSession(reason) {
    s.epoch += 1;
    stopLive();
    s.signedIn = false; s.account = null; s.access = "guest"; s.reason = reason;
    s.recent = { topics: [], total: 0 }; s.view = null;
    if (location.hash) history.replaceState(null, "", location.pathname + location.search); // no stale "#/topic/158" after leaving
    updateTitle();
    renderGuest();
  }

  // A link such as /support#/topic/14 must lead back to that topic after signing in: the server never sees the part after "#", so it is kept here.
  const returnKey = "foyerdesk-return";
  const wantedTarget = /^#\/(topic\/[0-9]{1,12}|new|open|resolved)$/;
  function rememberTarget() { try { if (wantedTarget.test(location.hash)) sessionStorage.setItem(returnKey, location.hash); } catch { /* storage unavailable: the visitor lands on the list */ } }
  function restoreTarget() {
    try { const back = sessionStorage.getItem(returnKey); sessionStorage.removeItem(returnKey); if (back && wantedTarget.test(back) && !location.hash) location.hash = back; } catch { /* nothing kept */ }
  }

  function renderGuest() {
    clear(wrap);
    // Each reason has its own clear title, so a visitor who just signed out sees it said plainly, not as a small grey line.
    const key = { signedOut: "signedOut", expired: "expired", authError: "authError" }[s.reason];
    const title = key ? t(key + "Title") : t("guestTitle");
    const body = key ? t(key + "Body") : t("guestDefault");
    const heading = h(titleTag, { tabindex: "-1", "data-testid": "guest-title", class: "fd-guest-title" + (key ? " fd-reason" : ""), text: title });
    wrap.dataset.state = "guest";
    wrap.append(h("section", { class: "fd-guest", "data-testid": "sign-in-panel" },
      h("div", { class: "fd-auth-card", "data-reason": key ?? "" }, h(brandTag, { class: "fd-brand", text: brand }),
        key ? null : h("p", { class: "fd-muted", text: t("intro") }),
        heading, h("p", { role: "status", "data-testid": "guest-notice", class: "fd-muted", text: body }),
        h("a", { class: "fd-btn fd-primary", href: signInHref(), onclick: rememberTarget, text: key === "signedOut" ? t("signInAgain") : t("signIn") }))));
    if (s.reason === "signedOut") heading.focus();
  }

  function renderPlain(text, testid) {
    clear(wrap);
    wrap.dataset.state = "guest";
    wrap.append(h("section", { class: "fd-guest" }, h("div", { class: "fd-auth-card" }, h(brandTag, { class: "fd-brand", text: brand }), h("p", { role: "status", class: "fd-muted", "data-testid": testid, text }))));
  }

  async function boot(quiet = false) {
    if (!quiet) renderPlain(t("checking"), "checking");
    const mine = s.epoch;
    const res = await api.session();
    if (mine !== s.epoch) return;
    if (res.status === 401) { if (!quiet) { s.access = "guest"; rememberTarget(); renderGuest(); } return; }
    if (res.status !== 200) { if (!quiet) { s.access = "unavailable"; renderPlain(t("unavailable"), "unavailable"); } return; }
    s.account = res.data?.account ?? {}; s.access = "signed-in"; s.signedIn = true;
    restoreTarget(); s.route = parseRoute();
    buildShell();
    openRoute(); // the page is usable at once; the side list fills in when it arrives and never rebuilds what the visitor is typing
    connect();
    scheduleSafety();
    const loaded = await loadRecent();
    if (mine !== s.epoch) return;
    // A visitor with no topics yet (for example one who followed a link from a message) goes straight to writing, not to an empty list.
    if (loaded && s.recent.total === 0 && s.route.name === "list" && !location.hash.replace("#", "")) location.replace("#/new");
  }

  // ---------- shell ----------
  let asideCard, recentBox, badgeBox, main, shell;
  function buildShell() {
    clear(wrap);
    delete wrap.dataset.state;
    asideCard = h("div", { class: "fd-card fd-account", "data-testid": "account-card" });
    recentBox = h("nav", { class: "fd-recent", "aria-label": t("recent") });
    badgeBox = h("div", { "aria-live": "polite" });
    // The account "island" (who is signed in, how, and Sign out) sits above everything and stays on screen while the page or the topic list scrolls.
    const aside = h("aside", { class: "fd-aside" }, h(brandTag, { class: "fd-brand", text: brand }), badgeBox,
      h("a", { class: "fd-btn fd-primary fd-block", href: "#/new", "data-testid": "side-new-topic", text: t("newTopic") }), recentBox);
    const side = h("div", { class: "fd-side" }, asideCard, aside);
    main = h("main", { class: "fd-main" });
    shell = h("div", { class: "fd-shell" }, side, main);
    wrap.append(shell);
    renderAccount(); renderRecent();
  }

  function renderAccount() {
    const a = s.account ?? {};
    const name = a.name || a.email || "";
    clear(asideCard).append(
      h("div", { class: "fd-account-row" },
        a.picture ? h("img", { class: "fd-avatar", src: a.picture, alt: "", referrerpolicy: "no-referrer" }) : h("span", { class: "fd-avatar fd-initials", "aria-hidden": "true", text: initials(name) }),
        h("div", { class: "fd-account-text" },
          h("p", { class: "fd-strong", text: name || t("signedIn") }),
          a.name && a.email ? h("p", { class: "fd-muted fd-small", text: a.email }) : null,
          h("p", { class: "fd-small" }, h("span", { class: "fd-dot", "aria-hidden": "true" }), " " + t("signedIn"), " ",
            a.provider ? h("span", { class: "fd-chip", "data-testid": "account-provider", text: t("via", { provider: ({ linkedin: "LinkedIn", google: "Google", email: "email" })[a.provider] ?? a.provider }) }) : null))),
      h("button", { type: "button", class: "fd-btn fd-ghost fd-signout", "data-testid": "sign-out", onclick: signOut, text: t("signOut") }));
  }

  function renderRecent() {
    const unread = s.recent.topics.filter((x) => x.unread).length;
    clear(badgeBox);
    if (unread > 0) badgeBox.append(h("p", { class: "fd-unread", role: "status", "data-testid": "unread-badge", text: unread === 1 ? t("oneNewReply") : t("manyNewReplies", { n: unread }) }));
    clear(recentBox).append(h("h2", { class: "fd-small fd-muted", text: t("recent") }));
    if (!s.recent.topics.length) recentBox.append(h("p", { class: "fd-muted fd-small", text: t("noRecent") }));
    for (const topic of s.recent.topics.slice(0, 5)) {
      recentBox.append(h("a", { class: "fd-recent-item" + (s.route.name === "topic" && s.route.id === topic.id ? " fd-current" : "") + (topic.tab === "resolved" ? " fd-done" : ""), href: `#/topic/${topic.id}`, "data-testid": "recent-item" },
        topic.unread ? h("span", { class: "fd-unread-dot", "data-testid": "unread-dot", "aria-label": t("oneNewReply") }) : null,
        h("span", { class: "fd-recent-subject", text: topic.subject }),
        topic.status === "Open" ? null : h("span", { class: "fd-recent-status fd-small fd-muted", "data-testid": "recent-status", text: t(statusKey(topic.status)) })));
    }
    if (s.recent.total > 5) recentBox.append(h("a", { class: "fd-small", href: "#/", "data-testid": "view-all", text: t("viewAll", { n: s.recent.total }) }));
    updateTitle();
  }

  async function loadRecent() {
    const mine = s.epoch;
    const res = await api.topics("all", 1);
    if (mine !== s.epoch) return;
    if (res.status === 401) return endSession("expired");
    if (res.status === 200 && res.data) { s.recent = { topics: res.data.topics ?? [], total: res.data.total ?? 0 }; renderRecent(); return true; }
    return false;
  }

  async function signOut() {
    const mine = s.epoch;
    const res = await api.logout();
    if (mine !== s.epoch) return;
    if (res.status >= 200 && res.status < 300) { clearDrafts(); endSession("signedOut"); }
    else main.prepend(h("p", { class: "fd-error", role: "alert", "data-testid": "signout-error", text: t("signOutFailed") }));
  }

  // ---------- routing ----------
  function openRoute() {
    if (!s.signedIn) return;
    s.route = parseRoute();
    s.view = null;
    shell.dataset.view = s.route.name; // on a phone the open topic takes the whole screen
    clear(main);
    if (s.route.name === "new") viewNew();
    else if (s.route.name === "topic") viewTopic(s.route.id);
    else viewList(s.route.tab, 1);
    renderRecent();
  }
  const listeners = [[window, "hashchange", openRoute]];
  window.addEventListener("hashchange", openRoute);

  // ---------- list ----------
  async function viewList(tab, page) {
    const mine = s.epoch;
    const view = { kind: "list", tab, page };
    s.view = view;
    const tabLink = (name, href, key) => h("a", { role: "tab", class: "fd-tab" + (tab === name ? " fd-active" : ""), "aria-selected": String(tab === name), href, "data-testid": "tab-" + name, text: t(key) });
    const tabs = h("div", { class: "fd-tabs", role: "tablist" }, tabLink("all", "#/", "tabAll"), tabLink("open", "#/open", "tabOpen"), tabLink("resolved", "#/resolved", "tabResolved"));
    const body = h("div", { "data-testid": "topic-list" });
    clear(main).append(h("div", { class: "fd-page-head" }, h("h2", { text: t("topics") }), h("a", { class: "fd-btn fd-primary", href: "#/new", "data-testid": "new-topic", text: t("newTopic") })), tabs, body);
    const res = await api.topics(tab, page);
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status === 401) return endSession("expired");
    if (res.status !== 200) { body.append(h("p", { class: "fd-error", role: "alert", text: errorText(res) })); return; }
    renderList(body, res.data, tab, page, view);
  }

  function renderList(body, data, tab, page, view) {
    clear(body);
    if (!data.topics.length) {
      const key = { all: "emptyAll", open: "emptyOpen", resolved: "emptyResolved" }[tab];
      body.append(h("div", { class: "fd-empty", "data-testid": "empty" }, h("p", { class: "fd-strong", text: t(key + "Title") }), h("p", { class: "fd-muted", text: t(key + "Hint") })));
      return;
    }
    const rows = data.topics.map((x) => h("tr", { "data-testid": "topic-row" },
      h("td", { class: "fd-muted", text: String(x.id) }),
      h("td", {}, h("a", { class: "fd-subject", href: `#/topic/${x.id}` }, x.unread ? h("span", { class: "fd-unread-dot", "data-testid": "row-unread" }) : null, x.subject),
        x.preview ? h("div", { class: "fd-preview fd-muted fd-small", text: x.preview }) : null),
      h("td", {}, badge(x.status)), h("td", { class: "fd-muted fd-small", text: when(x.at) })));
    body.append(h("div", { class: "fd-table-wrap" }, h("table", { class: "fd-table" },
      h("thead", {}, h("tr", {}, ...["colNumber", "colSubject", "colStatus", "colUpdated"].map((k) => h("th", { text: t(k) })))), h("tbody", {}, rows))));
    if (data.pages > 1) {
      const go = (p) => viewList(tab, p);
      body.append(h("div", { class: "fd-pager" },
        h("button", { type: "button", class: "fd-btn fd-ghost", disabled: page <= 1, "data-testid": "prev", onclick: () => go(page - 1), text: t("prevPage") }),
        h("span", { class: "fd-muted", "data-testid": "page-of", text: t("pageOf", { page, pages: data.pages }) }),
        h("button", { type: "button", class: "fd-btn fd-ghost", disabled: page >= data.pages, "data-testid": "next", onclick: () => go(page + 1), text: t("nextPage") })));
    }
  }

  // ---------- new topic ----------
  function viewNew() {
    s.view = { kind: "new" };
    const subject = h("input", { id: "fd-subject", name: "subject", type: "text", maxlength: "120", autocomplete: "off" });
    const message = h("textarea", { id: "fd-message", name: "message", rows: "6", maxlength: "3000", required: true, placeholder: t("messagePlaceholder") });
    const error = h("p", { class: "fd-error", role: "alert", "data-testid": "form-error", hidden: true });
    const submit = h("button", { type: "submit", class: "fd-btn fd-primary", "data-testid": "create", text: t("create") });
    const form = h("form", { class: "fd-card fd-form", novalidate: true },
      h("label", { for: "fd-subject", text: t("subject") }), subject, h("p", { class: "fd-muted fd-small", text: t("subjectHint") }),
      h("label", { for: "fd-message", text: t("message") }), message, error,
      h("div", { class: "fd-actions" }, h("a", { class: "fd-btn fd-ghost", href: "#/", text: t("back") }), submit));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = message.value.trim(), title = subject.value.trim();
      if (!text) { error.hidden = false; error.textContent = t("err_message_required"); return; }
      // The same text keeps the same request id, so a retry after a lost answer cannot open a second topic.
      if (!s.newDraft || s.newDraft.message !== text || s.newDraft.subject !== title) s.newDraft = { requestId: newRequestId(), subject: title, message: text };
      submit.disabled = true; submit.textContent = t("creating"); error.hidden = true;
      const mine = s.epoch;
      const res = await api.createTopic({ requestId: s.newDraft.requestId, ...(title ? { subject: title } : {}), message: text });
      if (mine !== s.epoch) return;
      if (res.status === 401) return endSession("expired");
      if ((res.status === 200 || res.status === 201) && res.data?.id) { s.newDraft = null; saveDraft("new", {}); loadRecent(); location.hash = `#/topic/${res.data.id}`; return; }
      submit.disabled = false; submit.textContent = t("create");
      error.hidden = false; error.textContent = errorText(res);
      if (res.data?.error === "conflict") s.newDraft = null;
    });
    const kept = loadDraft("new");
    if (kept) { subject.value = kept.subject ?? ""; message.value = kept.message ?? ""; }
    const keep = () => saveDraft("new", { subject: subject.value, message: message.value });
    subject.addEventListener("input", keep); message.addEventListener("input", keep);
    clear(main).append(h("div", { class: "fd-page-head" }, h("h2", { text: t("newTopicTitle") })), form);
    message.focus();
  }

  // ---------- topic ----------
  function viewTopic(id) {
    const view = { kind: "topic", id, messages: [], hasMore: false, topic: null, atBottom: true, loadingOlder: false };
    s.view = view; s.replyDraft = null;
    const title = h("h2", { "data-testid": "topic-title" });
    const badgeSlot = h("span", { "data-testid": "topic-status" });
    const actionSlot = h("span", {});
    const notice = h("p", { class: "fd-error", role: "alert", "data-testid": "topic-error", hidden: true });
    const list = h("ol", { class: "fd-messages", "aria-label": t("conversation") });
    const olderSlot = h("div", { class: "fd-older" });
    const scroller = h("div", { class: "fd-thread", role: "region", tabindex: "0", "aria-label": t("conversation"), "data-testid": "thread" }, olderSlot, list);
    const jump = h("button", { type: "button", class: "fd-jump", hidden: true, "data-testid": "new-message", text: t("newMessageBelow"), onclick: () => toBottom(true) });
    const box = h("textarea", { id: "fd-reply", rows: "3", maxlength: "3000", "aria-label": t("reply"), placeholder: t("replyPlaceholder") });
    const keptReply = loadDraft("reply-" + id);
    if (keptReply) box.value = keptReply.message ?? "";
    box.addEventListener("input", () => saveDraft("reply-" + id, { message: box.value }));
    const send = h("button", { type: "submit", class: "fd-btn fd-primary", "data-testid": "send", text: t("send") });
    const status = h("p", { class: "fd-muted fd-small", role: "status", "data-testid": "sent", hidden: true });
    const composer = h("form", { class: "fd-composer", novalidate: true }, box, h("div", { class: "fd-actions" }, status, send));
    Object.assign(view, { title, badgeSlot, actionSlot, notice, list, olderSlot, scroller, jump, box, send, status, composer });
    clear(main).append(h("div", { class: "fd-topic" },
      h("div", { class: "fd-topic-head" }, h("a", { class: "fd-btn fd-ghost", href: "#/", text: t("back") }), title, badgeSlot, actionSlot),
      notice, h("div", { class: "fd-thread-wrap" }, scroller, jump), composer));
    scroller.addEventListener("scroll", () => {
      view.atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      if (view.atBottom) jump.hidden = true;
    });
    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      if (!s.replyDraft || s.replyDraft.message !== text) s.replyDraft = { requestId: newRequestId(), message: text };
      send.disabled = true; notice.hidden = true;
      const mine = s.epoch;
      const res = await api.reply(id, { requestId: s.replyDraft.requestId, message: text });
      if (mine !== s.epoch || s.view !== view) return;
      send.disabled = false;
      if (res.status === 401) return endSession("expired");
      if (res.status === 404) { notice.hidden = false; notice.textContent = t("topicNotFound"); return; }
      if (res.status === 200) { s.replyDraft = null; box.value = ""; saveDraft("reply-" + id, {}); status.hidden = false; status.textContent = t("sent"); await pullTopic(view, true); loadRecent(); return; }
      notice.hidden = false; notice.textContent = errorText(res);
    });
    box.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") composer.requestSubmit(); });
    loadTopic(view);
  }

  function toBottom(smooth = false, markSeen = true) {
    const v = s.view; if (!v || v.kind !== "topic") return;
    // A hidden tab never finishes a smooth scroll, so the newest message would stay out of sight.
    v.scroller.scrollTo({ top: v.scroller.scrollHeight, behavior: smooth && !document.hidden ? "smooth" : "auto" });
    v.atBottom = true; if (markSeen) v.jump.hidden = true;
  }

  function applyTopic(view, data) {
    if (data.topic) {
      view.topic = data.topic;
      view.title.textContent = data.topic.subject;
      clear(view.badgeSlot).append(badge(data.topic.status));
      clear(view.actionSlot);
      const acts = data.topic.actions ?? [];
      const act = acts.includes("resolve") ? "resolve" : acts.includes("reopen") ? "reopen" : null;
      if (act) view.actionSlot.append(h("button", { type: "button", class: "fd-btn fd-ghost", "data-testid": act, text: t(act), onclick: () => changeStatus(view, act) }));
    }
  }

  function renderMessages(view, keepFrom) {
    const el = view.scroller; const before = keepFrom ? { height: el.scrollHeight, top: el.scrollTop } : null;
    clear(view.list);
    if (!view.messages.length) view.list.append(h("li", { class: "fd-muted fd-center", text: t("noMessages") }));
    view.messages.forEach((m, i) => {
      const mine = m.direction === "visitor";
      const prev = view.messages[i - 1];
      if (Number.isFinite(m.at) && (!Number.isFinite(prev?.at) || dayLabel(prev.at) !== dayLabel(m.at))) view.list.append(h("li", { role: "presentation", class: "fd-day", text: dayLabel(m.at) }));
      view.list.append(h("li", { class: "fd-msg " + (mine ? "fd-mine" : "fd-theirs"), "data-testid": "message" },
        h("span", { class: "fd-meta fd-small fd-muted", text: (mine ? t("you") : m.author ? t("teamNamed", { name: m.author }) : t("team")) + (Number.isFinite(m.at) ? " · " + when(m.at) : "") }),
        h("p", { class: "fd-bubble", text: m.text })));
    });
    clear(view.olderSlot);
    if (view.hasMore) view.olderSlot.append(h("button", { type: "button", class: "fd-btn fd-ghost", "data-testid": "load-earlier", onclick: () => loadEarlier(view), text: t("loadEarlier") }));
    if (before) el.scrollTop = before.top + (el.scrollHeight - before.height);
  }

  const merge = (current, more) => [...new Map([...current, ...more].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id);

  async function loadTopic(view) {
    const mine = s.epoch;
    const res = await api.messages(view.id);
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status === 401) return endSession("expired");
    if (res.status === 404) { view.notice.hidden = false; view.notice.textContent = t("topicNotFound"); view.composer.hidden = true; return; }
    if (res.status !== 200) { view.notice.hidden = false; view.notice.textContent = errorText(res); return; }
    view.messages = res.data.messages ?? []; view.hasMore = Boolean(res.data.hasMore);
    applyTopic(view, res.data); renderMessages(view); toBottom(false);
    view.lastId = view.messages.at(-1)?.id ?? 0;
    loadRecent(); // reading marks the topic as seen on the server
  }

  async function pullTopic(view, mineSent = false) {
    const mine = s.epoch;
    const res = await api.messages(view.id, `?after=${view.lastId ?? 0}`);
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status === 401) return endSession("expired");
    if (res.status !== 200) return;
    applyTopic(view, res.data);
    const fresh = (res.data.messages ?? []).filter((m) => m.id > (view.lastId ?? 0));
    if (!fresh.length) return;
    view.messages = merge(view.messages, fresh); view.lastId = view.messages.at(-1).id;
    const stick = view.atBottom || mineSent || fresh.every((m) => m.direction === "visitor");
    renderMessages(view);
    if (stick && !document.hidden) toBottom(true);
    else if (stick) toBottom(false, false);
    else view.jump.hidden = false;
    if (document.hidden) { view.pendingUnread = true; }
  }

  async function loadEarlier(view) {
    if (view.loadingOlder || !view.messages.length) return;
    view.loadingOlder = true;
    const mine = s.epoch;
    const res = await api.messages(view.id, `?before=${view.messages[0].id}`);
    view.loadingOlder = false;
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status !== 200) { view.notice.hidden = false; view.notice.textContent = t("loadEarlierFailed"); return; }
    view.notice.hidden = true;
    view.messages = merge(view.messages, res.data.messages ?? []); view.hasMore = Boolean(res.data.hasMore);
    renderMessages(view, true);
  }

  async function changeStatus(view, action) {
    const mine = s.epoch;
    const res = await (action === "resolve" ? api.resolve(view.id) : api.reopen(view.id));
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status === 401) return endSession("expired");
    if (res.status === 200) { applyTopic(view, { topic: { ...view.topic, status: res.data.status, actions: res.data.actions } }); loadRecent(); return; }
    view.notice.hidden = false; view.notice.textContent = errorText(res);
  }

  // ---------- live ----------
  function refresh(changedId) {
    if (!s.signedIn) return;
    if (Date.now() - s.lastRun < MIN_GAP_MS) { clearTimeout(s.timers.gap); s.timers.gap = setTimeout(() => refresh(changedId), MIN_GAP_MS); return; }
    s.lastRun = Date.now();
    loadRecent();
    const v = s.view;
    if (v?.kind === "list") viewListQuiet(v);
    if (v?.kind === "topic" && (changedId === null || changedId === v.id)) pullTopic(v);
  }
  async function viewListQuiet(view) {
    const mine = s.epoch;
    const res = await api.topics(view.tab, view.page);
    if (mine !== s.epoch || s.view !== view) return;
    if (res.status === 401) return endSession("expired");
    const body = main.querySelector('[data-testid="topic-list"]');
    if (res.status === 200 && body) renderList(body, res.data, view.tab, view.page, view);
  }
  function scheduleSafety() {
    clearTimeout(s.timers.safety);
    if (!s.signedIn || document.hidden) return;
    s.timers.safety = setTimeout(() => { refresh(null); scheduleSafety(); }, s.wsOpen ? SAFETY_MS : FALLBACK_MS);
  }
  function connect() {
    if (s.ws || !s.signedIn) return;
    let ws;
    try { ws = new WebSocket(api.streamUrl()); } catch { return; }
    s.ws = ws;
    ws.onopen = () => {
      s.attempts = 0; s.wsOpen = true;
      s.timers.heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, HEARTBEAT_MS);
      scheduleSafety();
    };
    ws.onmessage = (event) => {
      const m = /^changed(?::([0-9]{1,12}))?$/.exec(String(event.data));
      if (m) refresh(m[1] ? Number(m[1]) : null);
    };
    ws.onclose = () => {
      if (s.ws !== ws) return;
      s.ws = null; s.wsOpen = false; clearInterval(s.timers.heartbeat); scheduleSafety();
      if (s.signedIn && s.attempts < 6) { s.timers.retry = setTimeout(connect, Math.min(2000 * 2 ** s.attempts++, 60_000) * (0.75 + Math.random() * 0.5)); }
    };
  }
  function stopLive() {
    clearTimeout(s.timers.safety); clearTimeout(s.timers.retry); clearTimeout(s.timers.gap); clearInterval(s.timers.heartbeat);
    const ws = s.ws; s.ws = null; s.wsOpen = false;
    try { ws?.close(1000, "done"); } catch { /* already closed */ }
  }
  const onVisibility = () => {
    if (document.hidden) { clearTimeout(s.timers.safety); return; }
    if (s.signedIn) { if (Date.now() - s.lastRun >= SESSION_RESUME_MS) refresh(null); scheduleSafety(); }
    const v = s.view; if (v?.kind === "topic" && v.atBottom) toBottom(false);
  };
  const onPointer = () => {
    // A guest may have signed in elsewhere: one check, at most every 30 s, only when the visitor acts.
    if (s.access === "guest" && Date.now() - s.lastRun >= SESSION_RESUME_MS) { s.lastRun = Date.now(); boot(true); }
  };
  document.addEventListener("visibilitychange", onVisibility); listeners.push([document, "visibilitychange", onVisibility]);
  window.addEventListener("pointerdown", onPointer); listeners.push([window, "pointerdown", onPointer]);

  boot();
  return { destroy() { s.epoch += 1; stopLive(); for (const [target, name, fn] of listeners) target.removeEventListener(name, fn); document.title = baseTitle; wrap.remove(); } };
}
