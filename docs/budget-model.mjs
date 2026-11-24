// Request budget model for /talk on Cloudflare Free. Run: node BUDGET_MODEL.mjs
// Limits (Free): 100,000 Worker requests/day; 100,000 Durable Object requests/day.
// Per history check: 1 Worker request + 2 DO requests (session read + thread) + 1-4 Chatwoot calls.
// ASSUMED visit (not measured): page load at 0 s, typing 0-40 s, sends at 40 s and 130 s, session ends at 900 s.
const SESSION = 900, SENDS = [40, 130];
const OVERHEAD = { worker: 8, doReq: 12 }; // login, callback, whoami, 2 sends, logout (+ closing the live channel), first page
const LIMIT = 100000;

function checks(schedule, tailAfterSession) {
  let t = 0, n = 0, last = 0;
  const idleSince = (now) => now - Math.max(...SENDS.filter((s) => s <= now), 0);
  while (t < SESSION) { n += 1; t += schedule(idleSince(t), t, SENDS); }
  if (tailAfterSession) { // guest tab keeps polling after the session ended
    for (let u = SESSION; u < SESSION + tailAfterSession; ) { n += 1; u += schedule(1e9, u, []); }
  }
  return n;
}
const current = (idle, t) => (idle < 120 || t < 130 + 120 ? 3 : 25);           // polling v2 (typing counts as activity)
const interim = (idle) => (idle < 20 ? 5 : idle < 80 ? 15 : 120);                // proposed interim
const rows = [
  ["polling v2 now, tab closed at session end", checks(current, 0), false],
  ["polling v2 now, guest tab left open 45 min", checks(current, 2700), false],
  ["interim interim, guest polling stopped", checks(interim, 0), false],
];
const visits = { "100/h x 8 h": 800, "100/h x 12 h": 1200, "100/h x 24 h": 2400 };
console.log("history checks per visit:", rows.map(([n, c]) => `${n}=${c}`).join("; "));
for (const [label, v] of Object.entries(visits)) {
  for (const [name, c] of rows) {
    const worker = v * (c + OVERHEAD.worker), dos = v * (2 * c + OVERHEAD.doReq);
    console.log(`${label.padEnd(14)} ${name.padEnd(42)} Worker ${String(worker).padStart(7)} (${Math.round(worker / LIMIT * 100)}%)  DO ${String(dos).padStart(7)} (${Math.round(dos / LIMIT * 100)}%)`);
  }
  // push (deployed): per visit = overhead + 1 upgrade + 3 safety checks (900 s / 300 s) + 1 reply (webhook + 1 refresh) [Worker];
  // DO: overhead + 2 (upgrade) + 3*2 (safety) + 1 (notify) + 2 (refresh) + 1 (18 pings billed 20:1). Assumes 1 team reply per visit.
  const pushW = v * (OVERHEAD.worker + 1 + 3 + 2), pushD = v * (OVERHEAD.doReq + 2 + 6 + 1 + 2 + 1);
  console.log(`${label.padEnd(14)} ${"push live (webhook + WebSocket)".padEnd(42)} Worker ${String(pushW).padStart(7)} (${Math.round(pushW / LIMIT * 100)}%)  DO ${String(pushD).padStart(7)} (${Math.round(pushD / LIMIT * 100)}%)`);
}
