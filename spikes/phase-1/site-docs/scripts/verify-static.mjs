import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = [
  "",
  "tools/",
  "docs/",
  "docs/getting-started/",
  "docs/privacy/",
  "docs/geometry-contract/",
  "docs/brand/",
];

for (const route of routes) {
  const file = path.join(root, "dist", route, "index.html");
  const html = await readFile(file, "utf8");
  assert.match(
    html,
    /<main id="main-content">/,
    `${route || "/"} should contain prerendered application content`,
  );
  assert.match(
    html,
    /<title>[^<]+<\/title>/,
    `${route || "/"} should include a route title`,
  );
  assert.match(
    html,
    /meta name="description" content="[^"]+"/,
    `${route || "/"} should include a description`,
  );
  assert.match(
    html,
    /voxelspy-theme/,
    `${route || "/"} should run the theme guard before rendering`,
  );
}

const docs = await readFile(path.join(root, "dist/docs/index.html"), "utf8");
assert.match(docs, /Search documentation/);
assert.match(docs, /Privacy by default/);
const tools = await readFile(path.join(root, "dist/tools/index.html"), "utf8");
assert.match(tools, /No model network request or telemetry is configured/);
console.log(
  `Verified ${routes.length} static routes, metadata, theme guard, docs content, and tool boundary.`,
);
