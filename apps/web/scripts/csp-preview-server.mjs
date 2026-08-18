/**
 * A minimal static file server that serves `dist/` with the exact response
 * headers declared in `dist/_headers`, so the Content-Security-Policy that
 * ships in that file can be exercised by a real browser against real HTTP
 * response headers -- not merely inspected as text.
 *
 * `vite preview` (used by the ordinary Playwright suite) does not read or
 * emit `_headers`; that file only takes effect on a host that honors it
 * (Cloudflare Pages and compatible hosts). This server is a stand-in for
 * that behavior, used only to run the full Playwright suite once against
 * the enforced policy as evidence that it does not break the app. It is not
 * used by the default `pnpm test:e2e` run and ships no code into the
 * production build.
 *
 * Limits: it only implements the single "/*" rule this project's
 * `_headers` file currently declares (applied to every response), not
 * Cloudflare Pages' full glob-matching and precedence rules. It also
 * cannot demonstrate `frame-ancestors` (that needs a second origin
 * attempting to frame this one) or off-host behavior in general -- it
 * proves the policy is internally consistent with the app on this host,
 * not that every real static host will honor it identically.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const port = Number(process.argv[2] ?? process.env.CSP_PREVIEW_PORT ?? 4174);

function parseHeadersFile(text) {
  const rules = [];
  let current;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    current.headers.push([
      trimmed.slice(0, separator).trim(),
      trimmed.slice(separator + 1).trim(),
    ]);
  }
  return rules;
}

const headersText = await readFile(path.join(dist, "_headers"), "utf8");
const rules = parseHeadersFile(headersText);

function headersForResponse() {
  // Only the catch-all "/*" pattern is implemented -- see module doc.
  return rules.find((rule) => rule.pattern === "/*")?.headers ?? [];
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveFile(pathname) {
  const direct = path.join(dist, pathname);
  let info = await stat(direct).catch(() => null);
  if (info?.isDirectory()) {
    const indexPath = path.join(direct, "index.html");
    info = await stat(indexPath).catch(() => null);
    if (info) return indexPath;
  } else if (info) {
    return direct;
  }
  const asDirectoryIndex = path.join(dist, pathname, "index.html");
  info = await stat(asDirectoryIndex).catch(() => null);
  if (info) return asDirectoryIndex;
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(requestUrl.pathname);
    for (const [name, value] of headersForResponse()) {
      res.setHeader(name, value);
    }
    const filePath = await resolveFile(pathname);
    if (!filePath) {
      const notFoundPath = path.join(dist, "404.html");
      res.statusCode = 404;
      res.setHeader("Content-Type", contentTypes[".html"]);
      res.end(await readFile(notFoundPath).catch(() => "Not found"));
      return;
    }
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    );
    res.end(await readFile(filePath));
  } catch (error) {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.stack : String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `CSP preview server: serving dist/ with dist/_headers applied at http://127.0.0.1:${port}`,
  );
});
