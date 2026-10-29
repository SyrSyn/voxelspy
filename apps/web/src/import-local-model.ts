import { importModel, UnsupportedInputError } from "@voxelspy/importers";
import { importRequestSchema, type ImportResult } from "@voxelspy/contracts";
import {
  StepRuntimeResourceLimitError,
  type StepRuntime,
} from "@voxelspy/importers/step";

/** Optional STEP runtime is isolated from normal importers and page evaluation policy. */
const stepRuntime: StepRuntime = {
  version: "0.0.23",
  occtVersion: "7.6.1",
  readStepFile(bytes, parameters) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL(
          import.meta.env.BASE_URL === "./"
            ? "../step/occt.worker.js"
            : "/step/occt.worker.js",
          import.meta.url,
        ),
        { name: "voxelspy-step-kernel" },
      );
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new StepRuntimeResourceLimitError(
                "STEP tessellation exceeded its 60 second wall-clock limit.",
              ),
            ),
          ),
        60_000,
      );
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        action();
      };
      worker.onmessage = (
        event: MessageEvent<{
          ok: boolean;
          result?: unknown;
          message?: string;
          code?: "integrity-mismatch" | "secure-context-required";
        }>,
      ) =>
        finish(() =>
          event.data.ok
            ? resolve(event.data.result)
            : event.data.code === "integrity-mismatch"
              ? reject(
                  new UnsupportedInputError(
                    "STEP runtime integrity check failed. Reload the application or contact the host administrator.",
                  ),
                )
              : event.data.code === "secure-context-required"
                ? reject(
                    new UnsupportedInputError(
                      "STEP requires a secure context (HTTPS or localhost) with Web Crypto SHA-256 support.",
                    ),
                  )
                : reject(
                    new Error(
                      event.data.message ?? "STEP runtime refused the source.",
                    ),
                  ),
        );
      worker.onerror = () =>
        finish(() =>
          reject(
            new Error(
              "STEP runtime could not load under this host's worker policy.",
            ),
          ),
        );
      worker.onmessageerror = () =>
        finish(() =>
          reject(new Error("STEP runtime response could not be decoded.")),
        );
      const copy = bytes.slice();
      try {
        worker.postMessage({ bytes: copy, parameters }, [copy.buffer]);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  },
};
export async function importLocalModel(input: unknown): Promise<ImportResult> {
  const request = importRequestSchema.safeParse(input);
  return importModel(
    input,
    request.success && request.data.format === "step" ? { stepRuntime } : {},
  );
}
