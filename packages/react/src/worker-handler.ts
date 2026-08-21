import { analyzeModelPair, inspectModel } from "@voxelspy/analysis";

import type {
  EngineWorkerRequest,
  EngineWorkerResponse,
  EngineWorkerScope,
} from "./protocol.js";

/**
 * Builds the worker-side message handler for `@voxelspy/react`'s hooks.
 * This is the whole of the "protocol lives in the package" half of the
 * worker-supply contract described in the README: it runs entirely inside
 * the consumer's own worker file, so this module intentionally has no
 * dependency on `react`, on the DOM, or on browser main-thread APIs -- only
 * on the public `@voxelspy/analysis` engine surface and this package's own
 * wire protocol.
 *
 * A consumer's worker entry file is expected to be exactly this:
 *
 * ```ts
 * // my-app/src/voxelspy-engine.worker.ts
 * /// <reference lib="webworker" />
 * import { createEngineWorkerHandler } from "@voxelspy/react/worker";
 *
 * self.addEventListener("message", createEngineWorkerHandler(self));
 * ```
 *
 * and then, in ordinary application code (not inside the worker file):
 *
 * ```ts
 * const createWorker = () =>
 *   new Worker(new URL("./voxelspy-engine.worker.ts", import.meta.url), {
 *     type: "module",
 *   });
 * ```
 *
 * `new Worker(new URL(...), { type: "module" })` must be written exactly
 * like that, in the consumer's own source, for every bundler this package
 * cannot assume in advance to recognize and bundle the worker file
 * correctly -- see the README's "Worker supply contract" section.
 *
 * Every request runs exactly one synchronous, bounded engine call
 * (`inspectModel` or `analyzeModelPair`) and posts back exactly one
 * response with the same `requestId` and `kind`. Nothing here retries,
 * caches, or holds state across messages: a fresh worker per call (the
 * lifecycle `worker-client.ts` implements) is simple enough that this
 * handler does not need to be anything more than a stateless dispatcher.
 *
 * Failures are never rethrown across the `postMessage` boundary: any error
 * the engine throws (a `<Domain>ResourceLimitError`, a `RangeError` on an
 * out-of-range option, a schema-validation error, or a genuine defect) is
 * caught here and reported as a structured `{ ok: false }` response instead
 * -- see `@voxelspy/analysis`'s README, "How failure is reported", for why
 * these entry points throw rather than returning a result-shaped failure,
 * and `describeEngineFailure` (`errors.ts`) for how the main-thread client
 * turns this back into a typed `Error`.
 */
export function createEngineWorkerHandler(
  scope: EngineWorkerScope,
): (event: MessageEvent<EngineWorkerRequest>) => void {
  return (event) => {
    const data = event.data;
    let response: EngineWorkerResponse;
    try {
      if (data.kind === "inspect") {
        const result = inspectModel(data.model, data.options);
        response = {
          kind: "inspect",
          requestId: data.requestId,
          ok: true,
          result,
        };
      } else {
        const result = analyzeModelPair({
          request: data.request,
          baseline: data.baseline,
          candidate: data.candidate,
        });
        response = {
          kind: "compare",
          requestId: data.requestId,
          ok: true,
          result,
        };
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Model analysis failed safely.";
      const errorName = error instanceof Error ? error.name : undefined;
      response = {
        kind: data.kind,
        requestId: data.requestId,
        ok: false,
        message,
        errorName,
      };
    }
    scope.postMessage(response);
  };
}
