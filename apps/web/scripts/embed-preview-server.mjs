/** Test-only host: serve the opt-in bundle beneath its real /workbench/ prefix. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 4186);
const headers = await readFile(path.join(root, "public/_headers"), "utf8");
const basePolicy = headers.match(/^  Content-Security-Policy: (.+)$/m)[1];
const workerPolicy =
  "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"),
      embedded = url.pathname.startsWith("/workbench/"),
      base = path.join(root, embedded ? "dist-embed" : "dist");
    const relative = decodeURIComponent(
      embedded
        ? url.pathname.slice("/workbench/".length)
        : url.pathname.slice(1),
    );
    const target = path.resolve(base, relative || "index.html");
    if (!target.startsWith(base + path.sep) && target !== base) {
      res.writeHead(404).end();
      return;
    }
    const info = await stat(target);
    const file = info.isDirectory() ? path.join(target, "index.html") : target;
    res.setHeader(
      "Content-Security-Policy",
      url.pathname.endsWith("/step/occt.worker.js")
        ? workerPolicy
        : embedded
          ? basePolicy.replace(
              "frame-ancestors 'none'",
              "frame-ancestors 'self'",
            )
          : basePolicy,
    );
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] ?? "application/octet-stream",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Hosted test preview on loopback ${port}`),
);
