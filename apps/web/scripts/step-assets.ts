import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const metadata = path.join(repository, "third-party/step");
const cache = path.join(repository, ".cache/step-sources");
const require = createRequire(
  path.join(repository, "packages/importers/package.json"),
);
const runtime = path.dirname(require.resolve("occt-import-js"));
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
interface Manifest {
  runtime: Record<string, string>;
  sources: { file: string; url: string; sha256: string }[];
}

const WASM_DIGEST_PLACEHOLDER = "__VOXELSPY_STEP_WASM_SHA256__";
async function readManifest(): Promise<Manifest> {
  return JSON.parse(
    await readFile(path.join(metadata, "manifest.json"), "utf8"),
  ) as Manifest;
}

/** Both production and development workers bind to the reviewed manifest. */
async function renderKernelWorker(manifest: Manifest): Promise<string> {
  const digest = manifest.runtime["occt-import-js.wasm"];
  if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("STEP manifest requires a canonical WASM SHA-256 digest.");
  const source = await readFile(
    path.join(repository, "apps/web/public/step/occt.worker.js"),
    "utf8",
  );
  if (source.split(WASM_DIGEST_PLACEHOLDER).length !== 2)
    throw new Error(
      "STEP kernel worker must contain exactly one digest placeholder.",
    );
  return source.replace(WASM_DIGEST_PLACEHOLDER, digest);
}

/** Builds ship their exact corresponding third-party sources beside replaceable binaries. */
async function prepare(output: string) {
  const manifest = await readManifest();
  const workerSource = await renderKernelWorker(manifest);
  await mkdir(cache, { recursive: true });
  await mkdir(path.join(output, "step/sources"), { recursive: true });
  await writeFile(path.join(output, "step/occt.worker.js"), workerSource);
  for (const [name, digest] of Object.entries(manifest.runtime)) {
    const bytes = await readFile(path.join(runtime, name));
    if (hash(bytes) !== digest)
      throw new Error(`STEP runtime digest mismatch: ${name}`);
    await writeFile(path.join(output, "step", name), bytes);
  }
  for (const source of manifest.sources) {
    const location = path.join(cache, source.file);
    let bytes = await readFile(location).catch(() => undefined);
    if (!bytes || hash(bytes) !== source.sha256) {
      console.log(`Preparing STEP corresponding source: ${source.file}`);
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`STEP source download refused: ${response.status}`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 128 * 1024 * 1024)
          throw new Error("STEP source archive exceeds preparation limit");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
      if (hash(bytes) !== source.sha256)
        throw new Error(`STEP source digest mismatch: ${source.file}`);
      await writeFile(location, bytes);
    }
    await writeFile(path.join(output, "step/sources", source.file), bytes);
  }
  for (const name of [
    "README.md",
    "manifest.json",
    "license.occt-import-js.txt",
    "license.occt.txt",
    "OCCT_LGPL_EXCEPTION.txt",
  ])
    await copyFile(path.join(metadata, name), path.join(output, "step", name));
}

export function stepAssets(): Plugin {
  let output = "";
  return {
    name: "voxelspy-step-runtime",
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      await prepare(output);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = req.url?.split("?")[0]?.replace(/^\/step\//u, "");
        if (
          !req.url?.startsWith("/step/") ||
          !name ||
          ![
            "occt.worker.js",
            "occt-import-js.js",
            "occt-import-js.wasm",
          ].includes(name)
        )
          return next();
        try {
          res.setHeader(
            "Content-Type",
            name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          );
          res.end(
            name === "occt.worker.js"
              ? await renderKernelWorker(await readManifest())
              : await readFile(path.join(runtime, name)),
          );
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
