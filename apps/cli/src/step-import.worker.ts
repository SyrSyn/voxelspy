import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { importModel } from "@voxelspy/importers";
import { createNodeStepRuntime } from "@voxelspy/importers/step-runtime-node";
try {
  const require = createRequire(
    import.meta.resolve("@voxelspy/importers/step-runtime-node"),
  );
  const wasmBinary = await readFile(
    path.join(
      path.dirname(require.resolve("occt-import-js")),
      "occt-import-js.wasm",
    ),
  );
  const stepRuntime = await createNodeStepRuntime({ wasmBinary });
  const result = await importModel(workerData, { stepRuntime });
  parentPort?.postMessage(result);
} catch {
  parentPort?.postMessage({
    contractVersion: 1,
    ok: false,
    code: "unsupported-input",
    message: "The qualified STEP kernel runtime could not be initialized.",
    warnings: [],
  });
}
