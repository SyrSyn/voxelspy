import type {
  AnalysisRequest,
  AnalysisResult,
  NormalizedModel,
} from "@voxelspy/contracts";
import { useEffect, useReducer, useRef } from "react";

import { createEngineRunner, type EngineRunnerController } from "./runner.js";
import {
  engineStatusReducer,
  IDLE_STATUS,
  type EngineStatus,
} from "./status.js";
import type { EngineWorkerFactory } from "./worker-client.js";
import { runModelComparison } from "./worker-client.js";

export interface RunModelComparisonOptions {
  /** See `EngineCallOptions.transferModel` in `worker-client.ts`: defaults to `false` (clone). */
  readonly transferModel?: boolean;
}

export interface UseModelComparisonResult {
  readonly status: EngineStatus<AnalysisResult>;
  /**
   * Starts comparing `baseline` against `candidate` off the main thread
   * using `analysisRequest` (`analyzeModelPair` from `@voxelspy/analysis`).
   * A call already in flight is cancelled first. Neither model's geometry
   * buffers are ever kept in React state -- only the returned
   * `AnalysisResult` (plain, serializable metrics, regions, and outcome
   * data) reaches `status`.
   *
   * `analysisRequest.baseline.modelId`/`candidate.modelId` must match
   * `baseline.id`/`candidate.id` exactly, the same binding
   * `analyzeModelPair` itself requires -- this hook does not construct or
   * default the request for you, matching this package's "never silently
   * reinterpret geometry or a caller's request" stance.
   */
  readonly run: (
    analysisRequest: AnalysisRequest,
    baseline: NormalizedModel,
    candidate: NormalizedModel,
    options?: RunModelComparisonOptions,
  ) => void;
  /** Cancels the in-flight run, if any. A no-op otherwise. */
  readonly cancel: () => void;
  /** Cancels any in-flight run and returns to `{ status: "idle" }`. */
  readonly reset: () => void;
}

type Runner = EngineRunnerController<
  [
    analysisRequest: AnalysisRequest,
    baseline: NormalizedModel,
    candidate: NormalizedModel,
    options?: RunModelComparisonOptions,
  ],
  AnalysisResult
>;

/**
 * Compares two `NormalizedModel`s (`analyzeModelPair` from
 * `@voxelspy/analysis`) entirely off the main thread, through a worker the
 * consumer supplies via `createWorker` -- see `useModelInspection`'s doc
 * comment and the package README's "Worker supply contract" section for
 * the shared worker-file pattern both hooks use.
 *
 * `status.complete.result` is the engine's real `AnalysisResult`,
 * unmodified -- including when `result.outcome.state === "indeterminate"`.
 * This hook's own `status` describes only whether the call finished, not
 * whether the analysis itself reached a conclusive answer; see
 * `status.ts`'s doc comment and the package README's "Status model"
 * section for why collapsing those two questions into one boolean would
 * misrepresent exactly the outcomes `@voxelspy/analysis` most needs a
 * caller to see honestly.
 */
export function useModelComparison(
  createWorker: EngineWorkerFactory,
): UseModelComparisonResult {
  const [status, dispatch] = useReducer(
    engineStatusReducer<AnalysisResult>,
    IDLE_STATUS as EngineStatus<AnalysisResult>,
  );

  const createWorkerRef = useRef(createWorker);
  createWorkerRef.current = createWorker;

  const runnerRef = useRef<Runner | null>(null);
  runnerRef.current ??= createEngineRunner(
    (signal, analysisRequest, baseline, candidate, options) =>
      runModelComparison(
        createWorkerRef.current,
        analysisRequest,
        baseline,
        candidate,
        {
          signal,
          ...(options?.transferModel === undefined
            ? {}
            : { transferModel: options.transferModel }),
        },
      ),
    dispatch,
  );

  useEffect(() => {
    return () => runnerRef.current?.cancel();
  }, []);

  const runner = runnerRef.current;
  return {
    status,
    run: runner.run,
    cancel: runner.cancel,
    reset: runner.reset,
  };
}
