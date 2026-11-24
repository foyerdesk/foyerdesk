export const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Support</title>
<style>
* {box-sizing:border-box}
body {margin:0;background:#eff3f8;color:#14263a;font:1rem/1.55 system-ui,sans-serif}
main {max-width:58rem;margin:auto;min-height:100dvh;display:flex;flex-direction:column;background:#f9fbfd;border-inline:1px solid #dce4ee}
header {display:flex;gap:1rem;justify-content:space-between;align-items:center;padding:1.25rem clamp(1rem,5vw,2.5rem);background:white;border-bottom:1px solid #dce4ee}
h1 {font-size:1.25rem;margin:0}
ol:empty {display:none}
ol {flex:1;display:flex;flex-direction:column;gap:1.25rem;list-style:none;margin:0;padding:1.5rem clamp(1rem,5vw,2.5rem)}
.message {max-width:min(82%,38rem);display:flex;flex-direction:column;gap:.25rem;align-self:flex-start}
.message--visitor {align-self:flex-end;align-items:flex-end}
.sender {font-size:.8rem;font-weight:650;color:#485e75}
.bubble {margin:0;padding:.75rem 1rem;border:1px solid #dce4ee;border-radius:.25rem 1rem 1rem 1rem;background:white;white-space:pre-wrap;overflow-wrap:anywhere}
.message--visitor .bubble {background:#193c61;color:white;border-color:transparent;border-radius:1rem .25rem 1rem 1rem}
form {padding:1rem clamp(1rem,5vw,2.5rem) 1.25rem;background:white;border-top:1px solid #dce4ee}
label {display:block;font-weight:650;margin-bottom:.4rem}
textarea {width:100%;min-height:5.5rem;padding:.75rem;border:1px solid #63748b;border-radius:.65rem;font:inherit;resize:vertical}
button {padding:.65rem .9rem;border:0;border-radius:.5rem;background:#193c61;color:white;font:inherit}
button:disabled {opacity:.55}
#logout {background:#edf2f7;color:#193c61}
#status {margin:.4rem 0;color:#485e75;font-size:.875rem}
#status:empty {display:none}
</style>
<script src="/app.js" defer></script>
</head>
<body>
<main>
<header><h1>Support</h1><button type="button" id="logout" hidden>Sign out</button></header>
<ol id="thread" aria-label="Conversation"></ol>
<form id="composer">
<label for="question">Your question</label>
<textarea id="question" required maxlength="3000"></textarea>
<p id="status" role="status">Checking your session…</p>
<button type="submit" id="send" disabled>Send message</button>
</form>
</main>
</body>
</html>`;

export const script = `
const endpoint = "/api/support/messages";
const thread = document.querySelector("#thread");
const form = document.querySelector("#composer");
const field = document.querySelector("#question");
const status = document.querySelector("#status");
const send = document.querySelector("#send");
const logout = document.querySelector("#logout");
const draftKey = "foyerdesk-draft";
let signedIn = false;
let shouldRefresh = true;
let rendered = "";
let pending;
let simulateLoss = new URLSearchParams(location.search).get("test") === "lose-ack";
try {
  pending = JSON.parse(sessionStorage.getItem(draftKey) || "null");
  if (pending) field.value = pending.message;
} catch {}
function saveDraft(draft) {
  pending = draft;
  if (draft) sessionStorage.setItem(draftKey, JSON.stringify(draft));
  else sessionStorage.removeItem(draftKey);
}
async function refresh() {
  const response = await fetch(endpoint, {cache:"no-store"});
  if (response.status === 401) {
    thread.replaceChildren();
    rendered = "";
    logout.hidden = true;
    signedIn = false;
    shouldRefresh = false;
    send.disabled = false;
    status.textContent = "Type your question. We’ll ask you to sign in when you send it.";
    return;
  }
  if (!response.ok) throw new Error();
  const firstCheck = !signedIn;
  signedIn = true;
  logout.hidden = false;
  if (firstCheck) {
    send.disabled = false;
    status.textContent = "";
  }
  const rows = await response.json();
  const key = JSON.stringify(rows);
  if (rendered === key) return;
  rendered = key;
  thread.replaceChildren(...rows.map(row => {
    const item = document.createElement("li");
    const visitor = row.direction === "visitor";
    item.className = visitor ? "message message--visitor" : "message";
    const sender = document.createElement("span");
    sender.className = "sender";
    sender.textContent = visitor ? "You" : "Support";
    const bubble = document.createElement("p");
    bubble.className = "bubble";
    bubble.textContent = row.text;
    item.append(sender, bubble);
    return item;
  }));
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const message = field.value.trim();
  if (!message || send.disabled) return;
  if (pending && pending.message !== message && signedIn) {
    status.textContent = "Restore the previous message to recheck delivery before sending a different one.";
    return;
  }
  if (!pending || pending.message !== message) saveDraft({message, requestId:crypto.randomUUID()});
  if (!signedIn) {
    location.assign("/api/auth/login");
    return;
  }
  send.disabled = true;
  try {
    const headers = {"Content-Type":"application/json"};
    if (simulateLoss) {
      headers["X-Foyerdesk-Test-Lose-Ack"] = "1";
      simulateLoss = false;
      history.replaceState(null, "", "/");
    }
    const response = await fetch(endpoint, {method:"POST",headers,body:JSON.stringify(pending)});
    if (response.status === 401) {
      location.assign("/api/auth/login");
      return;
    }
    if (!response.ok) throw new Error();
    saveDraft(null);
    field.value = "";
    status.textContent = "Message sent.";
    await refresh().catch(() => {});
  } catch {
    status.textContent = "Delivery is unconfirmed. Your message is still here. Send again to check it.";
  } finally {
    send.disabled = false;
  }
};
logout.onclick = async () => {
  try {
    const response = await fetch("/api/auth/logout", {method:"POST"});
    if (!response.ok) throw new Error();
    saveDraft(null);
    location.replace("/");
  } catch {
    status.textContent = "Could not sign out. Try again.";
  }
};
function refreshSafely() {
  refresh().catch(() => {
    if (!pending) status.textContent = "Support is temporarily unavailable. Reconnecting…";
  });
}
refreshSafely();
setInterval(() => { if (shouldRefresh) refreshSafely(); }, 2500);
`;
