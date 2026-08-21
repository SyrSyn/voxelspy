import type { InspectOptions, InspectionResult } from "@voxelspy/analysis";
import type { NormalizedModel } from "@voxelspy/contracts";
import { useEffect, useReducer, useRef } from "react";

import { createEngineRunner, type EngineRunnerController } from "./runner.js";
import {
  engineStatusReducer,
  IDLE_STATUS,
  type EngineStatus,
} from "./status.js";
import type { EngineWorkerFactory } from "./worker-client.js";
import { runModelInspection } from "./worker-client.js";

export interface RunModelInspectionOptions {
  readonly inspect?: InspectOptions;
  /** See `EngineCallOptions.transferModel` in `worker-client.ts`: defaults to `false` (clone). */
  readonly transferModel?: boolean;
}

export interface UseModelInspectionResult {
  readonly status: EngineStatus<InspectionResult>;
  /**
   * Starts inspecting `model` off the main thread. A call already in
   * flight is cancelled first, so only the most recently requested
   * inspection can ever complete. The heavy `NormalizedModel` (its
   * typed-array geometry buffers) is handed to the worker, never kept in
   * React state -- only the returned `InspectionResult`, a plain
   * serializable report with no geometry buffers of its own, ever reaches
   * `status`.
   */
  readonly run: (
    model: NormalizedModel,
    options?: RunModelInspectionOptions,
  ) => void;
  /** Cancels the in-flight run, if any. A no-op otherwise. */
  readonly cancel: () => void;
  /** Cancels any in-flight run and returns to `{ status: "idle" }`. */
  readonly reset: () => void;
}

type Runner = EngineRunnerController<
  [model: NormalizedModel, options?: RunModelInspectionOptions],
  InspectionResult
>;

/**
 * Inspects one `NormalizedModel` (`inspectModel` from `@voxelspy/analysis`)
 * entirely off the main thread, through a worker the consumer supplies via
 * `createWorker` -- see `@voxelspy/react/worker`'s `createEngineWorkerHandler`
 * and the package README's "Worker supply contract" section for how to
 * write that worker file.
 *
 * `status` is the hook's whole public state, a discriminated union over
 * exactly four cases (`idle`/`running`/`complete`/`failed` -- see
 * `status.ts`); `complete` always carries the real `InspectionResult`
 * unmodified, including its topology findings, watertightness verdict, and
 * mesh breakdown. This hook never flattens that into a boolean.
 *
 * The in-flight run is aborted automatically on unmount and whenever a new
 * `run()` call supersedes it, so a slow inspection can never resolve into a
 * component that is no longer mounted, or overwrite a newer request's
 * result with a stale one. All of that control flow lives in
 * `createEngineRunner` (`runner.ts`), a plain, non-React object this hook
 * only wires up to `useReducer` -- see that module's doc comment and
 * `test/runner.test.ts` for how it is tested directly, without a renderer.
 */
export function useModelInspection(
  createWorker: EngineWorkerFactory,
): UseModelInspectionResult {
  const [status, dispatch] = useReducer(
    engineStatusReducer<InspectionResult>,
    IDLE_STATUS as EngineStatus<InspectionResult>,
  );

  // `createWorker` may be a fresh function identity on every render; the
  // runner is only ever constructed once (below) and reads this ref at call
  // time, so a consumer that does not memoize its worker factory still
  // always gets the latest one, without recreating the runner every render.
  const createWorkerRef = useRef(createWorker);
  createWorkerRef.current = createWorker;

  const runnerRef = useRef<Runner | null>(null);
  runnerRef.current ??= createEngineRunner(
    (signal, model, options) =>
      runModelInspection(createWorkerRef.current, model, options?.inspect, {
        signal,
        ...(options?.transferModel === undefined
          ? {}
          : { transferModel: options.transferModel }),
      }),
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
