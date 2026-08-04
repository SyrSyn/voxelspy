import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../.ssr/entry-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const template = await readFile(path.join(dist, "index.html"), "utf8");
const routes = [
  "/",
  "/tools/",
  "/docs/",
  "/docs/getting-started/",
  "/docs/privacy/",
  "/docs/geometry-contract/",
  "/docs/brand/",
];

for (const route of routes) {
  const { html, metadata } = render(route);
  const head = [
    `<title>${metadata.title}</title>`,
    `<meta name="description" content="${metadata.description}">`,
    `<meta property="og:title" content="${metadata.title}">`,
    `<meta property="og:description" content="${metadata.description}">`,
    `<meta name="twitter:title" content="${metadata.title}">`,
    `<meta name="twitter:description" content="${metadata.description}">`,
  ].join("\n    ");
  const output = template
    .replace("<!--app-head-->", head)
    .replace("<!--app-html-->", html);
  const directory = route === "/" ? dist : path.join(dist, route.slice(1));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), output);
}

await rm(path.join(root, ".ssr"), { recursive: true, force: true });
console.log(`Prerendered ${routes.length} routes.`);
