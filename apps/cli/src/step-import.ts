import { Worker } from "node:worker_threads";
import {
  importRequestSchema,
  importResultSchema,
  type ImportResult,
} from "@voxelspy/contracts";

/** The native kernel runs outside the CLI event loop and can be terminated. */
export function importStepInWorker(input: unknown): Promise<ImportResult> {
  const parsed = importRequestSchema.safeParse(input);
  if (!parsed.success)
    return Promise.resolve({
      contractVersion: 1,
      ok: false,
      code: "invalid-input",
      message: "STEP import request does not satisfy its versioned contract.",
      warnings: [],
    });
  const request = parsed.data;
  return new Promise((resolve) => {
    const copy = request.bytes.slice();
    const worker = new Worker(
      new URL("./step-import.worker.js", import.meta.url),
      {
        workerData: { ...request, bytes: copy },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      },
    );
    let settled = false;
    const finish = (result: ImportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const refused = (message: string): ImportResult => ({
      contractVersion: 1,
      ok: false,
      code: "resource-limit",
      message,
      warnings: [],
    });
    const timer = setTimeout(
      () =>
        finish(
          refused("STEP tessellation exceeded its 60 second wall-clock limit."),
        ),
      60_000,
    );
    worker.once("message", (result: unknown) => {
      const checked = importResultSchema.safeParse(result);
      finish(
        checked.success
          ? checked.data
          : refused(
              "STEP kernel response did not satisfy its versioned result contract.",
            ),
      );
    });
    worker.once("error", () =>
      finish(
        refused(
          "STEP kernel worker stopped before producing a validated result.",
        ),
      ),
    );
    worker.once("exit", () => {
      if (!settled)
        finish(
          refused(
            "STEP kernel worker exited before producing a validated result.",
          ),
        );
    });
  });
}
