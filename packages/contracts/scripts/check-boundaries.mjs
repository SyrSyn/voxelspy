import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = [
  /(?:from|import\s*)\s*["'](?:node:|react(?:\/|["'])|three(?:\/|["']))/u,
  /\b(?:File|Blob|Worker|Window|Document|HTMLElement|localStorage|fetch)\b/u,
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => extname(path) === ".ts");
}

const violations = [];
for (const path of await sourceFiles(
  fileURLToPath(new URL("../src", import.meta.url)),
)) {
  const source = await readFile(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) violations.push(`${path}: ${pattern}`);
  }
}

if (violations.length > 0) {
  throw new Error(
    `Contract dependency boundary violations:\n${violations.join("\n")}`,
  );
}
