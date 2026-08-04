import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const viteRoot = new URL("../consumers/vite", import.meta.url).pathname;
const packageEntry = new URL("../dist/index.js", import.meta.url).pathname;
const ssrOutput = new URL("../consumers/ssr/dist/entry.mjs", import.meta.url)
  .pathname;

await Promise.all([
  rm(new URL("../consumers/vite/dist", import.meta.url), {
    recursive: true,
    force: true,
  }),
  rm(new URL("../consumers/ssr/dist", import.meta.url), {
    recursive: true,
    force: true,
  }),
]);

await viteBuild({
  root: viteRoot,
  logLevel: "info",
  resolve: {
    alias: { "@voxelspy/worker-performance-spike": packageEntry },
  },
  build: { emptyOutDir: true },
});

await build({
  entryPoints: [new URL("../consumers/ssr/entry.ts", import.meta.url).pathname],
  outfile: ssrOutput,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  logLevel: "info",
  alias: { "@voxelspy/worker-performance-spike": packageEntry },
});

await run(process.execPath, [ssrOutput]);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Consumer exited with ${signal ?? `code ${code}`}`));
    });
  });
}
