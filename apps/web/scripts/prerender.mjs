import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../.ssr/entry-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const template = await readFile(path.join(dist, "index.html"), "utf8");
const routes = [
  "/",
  "/compare/",
  "/docs/",
  "/docs/getting-started/",
  "/docs/privacy/",
  "/docs/geometry/",
];

const escapeAttribute = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
const escapeText = (value) => escapeAttribute(value).replaceAll(">", "&gt;");

for (const route of routes) {
  const { html, metadata } = render(route);
  const head = [
    `<title>${escapeText(metadata.title)}</title>`,
    `<meta name="description" content="${escapeAttribute(metadata.description)}">`,
    `<meta property="og:title" content="${escapeAttribute(metadata.title)}">`,
    `<meta property="og:description" content="${escapeAttribute(metadata.description)}">`,
  ].join("\n    ");
  const output = template
    .replace("<!--app-head-->", () => head)
    .replace("<!--app-html-->", () => html);
  const directory = route === "/" ? dist : path.join(dist, route.slice(1));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), output);
}

const notFoundHtml = render("/not-found/").html;
await writeFile(
  path.join(dist, "404.html"),
  template
    .replace(
      "<!--app-head-->",
      () => "<title>Page not found — VoxelSpy</title>",
    )
    .replace("<!--app-html-->", () => notFoundHtml),
);
await rm(path.join(root, ".ssr"), { recursive: true, force: true });
console.log(`Prerendered ${routes.length} routes and a static 404 page.`);
