import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Discovered from what the build actually emitted, so every prerendered page
// is verified even as routes are added. The prerenderer derives its own list
// from the application's declared routes, so a declared page that failed to
// render never reaches this step.
const routes = (
  await readdir(path.join(root, "dist"), {
    recursive: true,
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isFile() && entry.name === "index.html")
  .map((entry) =>
    path
      .relative(
        path.join(root, "dist"),
        path.join(entry.parentPath, entry.name),
      )
      .replace(/index\.html$/u, "")
      .replaceAll(path.sep, "/"),
  )
  .sort();
assert.ok(routes.length >= 6, "static build must emit every declared route");
for (const route of routes) {
  const html = await readFile(
    path.join(root, "dist", route, "index.html"),
    "utf8",
  );
  assert.match(
    html,
    /<main id="main-content">/,
    `${route || "/"} lacks prerendered application content`,
  );
  assert.match(
    html,
    /<title>[^<]+<\/title>/,
    `${route || "/"} lacks a route title`,
  );
  assert.match(
    html,
    /meta name="description" content="[^"]+"/,
    `${route || "/"} lacks a description`,
  );
  assert.match(
    html,
    /voxelspy-theme/,
    `${route || "/"} lacks the early theme guard`,
  );
}
const home = await readFile(path.join(root, "dist/index.html"), "utf8");
assert.match(home, /Instant - Local - Open Source/);
assert.match(home, /A 3D Toolkit, Free Forever\./);
assert.match(home, /viewport-difference/);
assert.match(home, /viewport-baseline/);
assert.match(home, /viewport-candidate/);
assert.doesNotMatch(home, /See what changed/);
assert.doesNotMatch(home, /Mounting bracket reinforcement/);
const compare = await readFile(
  path.join(root, "dist/compare/index.html"),
  "utf8",
);
assert.match(compare, /Import and analysis run in a dedicated browser worker/);
assert.match(compare, /millimetre and right-handed Z-up defaults/);
assert.match(compare, /Expert settings/);
assert.match(compare, /disabled=""/);
const docs = await readFile(path.join(root, "dist/docs/index.html"), "utf8");
assert.match(docs, /Search documentation/);
assert.match(docs, /Privacy by default/);

// Structural privacy boundary: the static build must ship a hosting headers
// file declaring a strict Content-Security-Policy, so a regression that
// drops or weakens it fails the build rather than silently shipping. See
// apps/web/tests/README.md and apps/web/tests/privacy.spec.ts for the
// behavioral half of this evidence.
const headers = await readFile(path.join(root, "dist/_headers"), "utf8");
assert.match(
  headers,
  /^\/\*$/m,
  "_headers must apply to all routes via a bare /* rule",
);
const cspLine = headers
  .split("\n")
  .find((line) => /Content-Security-Policy:/.test(line));
assert.ok(cspLine, "_headers must declare a Content-Security-Policy");
for (const directive of [
  "default-src 'self'",
  "script-src 'self' 'sha256-",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]) {
  assert.ok(
    cspLine.includes(directive),
    `_headers Content-Security-Policy is missing "${directive}"`,
  );
}
// Every inline script the build emits must be covered by a hash in the
// policy. Without this check an edit to the theme guard ships a policy that
// blocks the site's own script, which only fails in a browser.
for (const route of routes) {
  const html = await readFile(
    path.join(root, "dist", route, "index.html"),
    "utf8",
  );
  for (const [, body] of html.matchAll(
    /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gu,
  )) {
    const digest = createHash("sha256").update(body, "utf8").digest("base64");
    assert.ok(
      cspLine.includes(`'sha256-${digest}'`),
      `${route || "/"} has an inline script whose hash sha256-${digest} is not allowed by the Content-Security-Policy`,
    );
  }
}

// Hashed asset filenames are content-addressed and may be cached forever;
// route documents must revalidate so a deployment is visible immediately.
assert.match(
  headers,
  /^\/assets\/\*$/m,
  "_headers must declare a caching rule for hashed assets",
);
assert.match(
  headers,
  /Cache-Control: public, max-age=31536000, immutable/,
  "hashed assets must be immutably cacheable",
);
assert.match(
  headers,
  /Cache-Control: no-cache/,
  "route documents must revalidate before reuse",
);
assert.match(
  headers,
  /Referrer-Policy: no-referrer/,
  "_headers must set a conservative Referrer-Policy",
);
assert.match(
  headers,
  /X-Content-Type-Options: nosniff/,
  "_headers must set X-Content-Type-Options",
);
assert.match(
  headers,
  /Permissions-Policy: /,
  "_headers must set a Permissions-Policy",
);

console.log(
  `Verified ${routes.length} static routes, metadata, local boundary, documentation content, and hosting headers.`,
);
