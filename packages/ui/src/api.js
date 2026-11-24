// Client for the Foyerdesk Worker. Same-origin cookies carry the session; nothing secret is held here.
export function createApi(base = "/api/support", authBase = "/api/auth") {
  async function call(method, path, body, root = base) {
    let response;
    try {
      // A request that never answers must not leave the screen waiting for minutes: reads give up after 15 s, writes after 30 s.
      response = await fetch(root + path, { method, cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(method === "GET" ? 15000 : 30000),
        headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { return { status: 0, data: null }; }
    const isJson = response.headers.get("content-type")?.includes("json");
    const data = response.status === 204 || !isJson ? null : await response.json().catch(() => null);
    // A 200 that is not the JSON the Worker sends (an error page, a captive portal, a missing route) is not a valid answer.
    if (response.ok && response.status !== 204 && (!data || typeof data !== "object")) return { status: 502, data: null };
    const retryAfter = Number(response.headers.get("retry-after"));
    return { status: response.status, data, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0 };
  }
  return {
    session: () => call("GET", "/session"),
    topics: (tab, page) => call("GET", `/topics?tab=${tab}&page=${page}`),
    createTopic: (input) => call("POST", "/topics", input),
    messages: (id, query = "") => call("GET", `/topics/${id}/messages${query}`),
    reply: (id, input) => call("POST", `/topics/${id}/messages`, input),
    resolve: (id) => call("POST", `/topics/${id}/resolve`, {}),
    reopen: (id) => call("POST", `/topics/${id}/reopen`, {}),
    logout: () => call("POST", "/logout", undefined, authBase),
    streamUrl: () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/stream`,
  };
}
export const newRequestId = () => crypto.randomUUID();
