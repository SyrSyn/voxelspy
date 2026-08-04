import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = [
  "",
  "compare/",
  "docs/",
  "docs/getting-started/",
  "docs/privacy/",
  "docs/geometry/",
];
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
assert.match(compare, /units or up-axis/);
assert.match(compare, /disabled=""/);
const docs = await readFile(path.join(root, "dist/docs/index.html"), "utf8");
assert.match(docs, /Search documentation/);
assert.match(docs, /Privacy by default/);
console.log(
  `Verified ${routes.length} static routes, metadata, local boundary, and documentation content.`,
);
