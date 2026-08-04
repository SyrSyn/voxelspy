import { readFile, readdir } from "node:fs/promises";

const sourceDirectory = new URL("../src/", import.meta.url);
const forbidden = [
  /from\s+["'](?:node:|react|three)/u,
  /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/u,
];

for (const name of await readdir(sourceDirectory)) {
  if (!name.endsWith(".ts")) continue;
  const source = await readFile(new URL(name, sourceDirectory), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`${name} crosses a package boundary: ${pattern.source}`);
    }
  }
}
