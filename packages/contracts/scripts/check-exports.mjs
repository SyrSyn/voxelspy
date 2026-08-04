import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

for (const [subpath, target] of Object.entries(packageJson.exports)) {
  const importPath = typeof target === "string" ? target : target.import;
  if (typeof importPath !== "string") {
    throw new TypeError(`Missing import target for ${subpath}`);
  }
  await import(new URL(`..${importPath.slice(1)}`, import.meta.url));
}
