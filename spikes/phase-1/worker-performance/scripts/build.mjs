import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const common = {
  bundle: true,
  format: "esm",
  logLevel: "info",
  sourcemap: true,
  target: "es2022",
};

const inlineBuild = await build({
  ...common,
  entryPoints: [new URL("../src/browser-worker.ts", import.meta.url).pathname],
  platform: "browser",
  sourcemap: false,
  write: false,
});
const inlineSource = inlineBuild.outputFiles[0]?.text;
if (!inlineSource) throw new Error("The inline worker bundle was not produced");

const inlineSourcePlugin = {
  name: "inline-worker-source",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^virtual:inline-worker-source$/ },
      () => ({
        path: "inline-worker-source",
        namespace: "worker-spike",
      }),
    );
    buildContext.onLoad({ filter: /.*/, namespace: "worker-spike" }, () => ({
      contents: `export default ${JSON.stringify(inlineSource)};`,
      loader: "js",
    }));
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [
      new URL("../src/browser-worker.ts", import.meta.url).pathname,
    ],
    outfile: new URL("../dist/browser-worker.js", import.meta.url).pathname,
    platform: "browser",
  }),
  build({
    ...common,
    entryPoints: [new URL("../src/node-worker.ts", import.meta.url).pathname],
    outfile: new URL("../dist/node-worker.js", import.meta.url).pathname,
    platform: "node",
  }),
  build({
    ...common,
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    outfile: new URL("../dist/index.js", import.meta.url).pathname,
    platform: "browser",
    plugins: [inlineSourcePlugin],
  }),
]);
