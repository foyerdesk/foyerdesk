// Static server for the harness page and the module sources. No API: tests mock it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/" || path === "/talk" || path === "/support" ? join(root, "test/harness/index.html") : normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(body); }
  catch { res.writeHead(404).end("not found"); }
}).listen(4177, "127.0.0.1");
