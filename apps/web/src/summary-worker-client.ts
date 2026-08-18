import type { ModelComparisonPresentationSummary } from "@voxelspy/analysis";
import type { AnalysisResult, NormalizedModel } from "@voxelspy/contracts";

/**
 * Message protocol for the dedicated geometry-summary worker.
 *
 * This is an app-internal channel, deliberately outside the versioned
 * comparison-worker protocol in `@voxelspy/contracts`: the summary is a
 * presentation convenience recomputed from data the main thread already
 * holds (the baseline/candidate models and their analysis result), not a
 * portable inter-package contract that needs its own version number.
 */
export interface SummaryWorkerRequest {
  readonly requestId: number;
  readonly baseline: NormalizedModel;
  readonly candidate: NormalizedModel;
  readonly analysis: AnalysisResult;
}

export type SummaryWorkerResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly summary: ModelComparisonPresentationSummary;
    }
  | {
      readonly requestId: number;
      readonly ok: false;
      readonly message: string;
    };

/**
 * Computes a geometry-summary presentation off the main thread.
 *
 * The full-topology work this wraps (re-transforming every vertex, building
 * string-keyed edge maps, union-find over every triangle) can take seconds
 * to minutes on large imported models, so it must never run on the render
 * thread. Each call spins up its own dedicated module worker -- mirroring
 * `runComparison`'s pattern in `worker-client.ts` -- and tears it down once
 * a result, failure, or abort settles the returned promise.
 *
 * The models and analysis result are posted with ordinary structured-clone
 * semantics (no transfer list): the worker gets a private copy of the
 * geometry buffers, and the caller keeps its own buffers intact for
 * rendering. No network transmission is involved; the worker runs entirely
 * in this browser.
 */
export function summarizeModelComparisonAsync(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
  analysis: AnalysisResult,
  signal?: AbortSignal,
): Promise<ModelComparisonPresentationSummary> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Geometry summary aborted.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./summary.worker.ts", import.meta.url), {
      type: "module",
      name: "voxelspy-summary",
    });
    const requestId = 1;
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
    const onAbort = () => {
      finish(() =>
        reject(new DOMException("Geometry summary aborted.", "AbortError")),
      );
    };
    const onMessage = (event: MessageEvent<SummaryWorkerResponse>) => {
      const data = event.data;
      if (data.requestId !== requestId) return;
      if (data.ok) finish(() => resolve(data.summary));
      else finish(() => reject(new Error(data.message)));
    };
    const onError = () => {
      finish(() =>
        reject(new Error("Geometry summary worker stopped unexpectedly.")),
      );
    };

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const request: SummaryWorkerRequest = {
      requestId,
      baseline,
      candidate,
      analysis,
    };
    worker.postMessage(request);
  });
}
