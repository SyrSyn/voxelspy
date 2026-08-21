import type { AnalysisRequest, NormalizedModel } from "@voxelspy/contracts";
import type { InspectOptions } from "@voxelspy/analysis";

import {
  describeEngineFailure,
  EngineCancelledError,
  EngineProtocolError,
} from "./errors.js";
import {
  collectModelBuffers,
  type CompareWorkerRequest,
  type CompareWorkerSuccess,
  type EngineWorkerRequest,
  type EngineWorkerResponse,
  type InspectWorkerRequest,
  type InspectWorkerSuccess,
} from "./protocol.js";

/**
 * A consumer-supplied function that constructs one fresh Web Worker running
 * this package's protocol handler (`createEngineWorkerHandler`, from
 * `@voxelspy/react/worker`). See the package README's "Worker supply
 * contract" section for why this package cannot construct the worker
 * itself: `new Worker(new URL("...", import.meta.url), { type: "module" })`
 * has to be written in the consumer's own source for the consumer's own
 * bundler to recognize and bundle the worker file.
 *
 * Called once per hook call (`run(...)`): each call gets its own worker,
 * used for exactly one request and then terminated, mirroring
 * `apps/web/src/inspect-worker-client.ts`'s `runInspectWorker` lifecycle --
 * a single bounded engine call has no need for a persistent, multi-request
 * worker session.
 */
export type EngineWorkerFactory = () => Worker;

/**
 * Whether the `NormalizedModel`(s) passed into a single call are copied
 * (default) or transferred into the worker. Cloning is the safe default:
 * the caller's model stays fully usable afterward (e.g. also handed to a
 * 3D viewer). Passing `transferModel: true` detaches every geometry buffer
 * in the model(s) from the calling thread for zero-copy performance on
 * very large meshes -- only safe when the caller is certain nothing else on
 * the main thread still needs that model instance. See the README's
 * "Model ownership" section.
 */
export interface EngineCallOptions {
  readonly signal?: AbortSignal;
  readonly transferModel?: boolean;
}

function runOneShot<TRequest extends EngineWorkerRequest>(
  createWorker: EngineWorkerFactory,
  request: TRequest,
  transfer: readonly ArrayBuffer[],
  signal: AbortSignal | undefined,
): Promise<Extract<EngineWorkerResponse, { kind: TRequest["kind"] }>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineCancelledError());
      return;
    }
    const worker = createWorker();
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
      action();
    };
    const onAbort = () => finish(() => reject(new EngineCancelledError()));
    const onMessage = (event: MessageEvent<EngineWorkerResponse>) => {
      const data = event.data;
      if (data.requestId !== request.requestId || data.kind !== request.kind)
        return;
      finish(() =>
        resolve(
          data as Extract<EngineWorkerResponse, { kind: TRequest["kind"] }>,
        ),
      );
    };
    const onError = () =>
      finish(() =>
        reject(
          new EngineProtocolError("The analysis worker stopped unexpectedly."),
        ),
      );

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(request, transfer as ArrayBuffer[]);
  });
}

/** Fixed: each call uses a fresh, single-request worker (see `EngineWorkerFactory`), so request IDs never need to be unique beyond one call. */
const REQUEST_ID = 1;

export async function runModelInspection(
  createWorker: EngineWorkerFactory,
  model: NormalizedModel,
  options: InspectOptions | undefined,
  callOptions: EngineCallOptions,
) {
  const request: InspectWorkerRequest = {
    kind: "inspect",
    requestId: REQUEST_ID,
    model,
    ...(options === undefined ? {} : { options }),
  };
  const transfer = callOptions.transferModel ? collectModelBuffers(model) : [];
  const response = await runOneShot(
    createWorker,
    request,
    transfer,
    callOptions.signal,
  );
  if (!response.ok)
    throw describeEngineFailure(response.message, response.errorName);
  return (response as InspectWorkerSuccess).result;
}

export async function runModelComparison(
  createWorker: EngineWorkerFactory,
  request: AnalysisRequest,
  baseline: NormalizedModel,
  candidate: NormalizedModel,
  callOptions: EngineCallOptions,
) {
  const workerRequest: CompareWorkerRequest = {
    kind: "compare",
    requestId: REQUEST_ID,
    request,
    baseline,
    candidate,
  };
  const transfer = callOptions.transferModel
    ? [
        ...new Set([
          ...collectModelBuffers(baseline),
          ...collectModelBuffers(candidate),
        ]),
      ]
    : [];
  const response = await runOneShot(
    createWorker,
    workerRequest,
    transfer,
    callOptions.signal,
  );
  if (!response.ok)
    throw describeEngineFailure(response.message, response.errorName);
  return (response as CompareWorkerSuccess).result;
}
