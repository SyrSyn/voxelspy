import { build } from "esbuild";

const result = await build({
  bundle: true,
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});

if (
  result.outputFiles.length !== 1 ||
  result.outputFiles[0].contents.length === 0
) {
  throw new Error("Browser bundle verification did not produce output");
}
