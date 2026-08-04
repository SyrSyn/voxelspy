import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url);
const allowed = new Set([".json", ".md", ".mjs", ".ts"]);
const violations = [];

for (const file of files(new URL(".", root))) {
  if (!allowed.has(extname(file))) continue;
  if (file.includes("node_modules")) continue;
  const content = readFileSync(file, "utf8");
  if (/[ \t]+$/mu.test(content))
    violations.push(`${relative(root.pathname, file)}: trailing whitespace`);
}

if (violations.length > 0) throw new Error(violations.join("\n"));
console.log("Lane source policy checks passed");

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) yield* files(new URL(`${entry.name}/`, directory));
    else yield path;
  }
}
