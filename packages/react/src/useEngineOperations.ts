import { useEffect, useReducer, useRef } from "react";
import type { NormalizedModel } from "@voxelspy/contracts";
import type { SimplificationResult } from "@voxelspy/analysis";
import { createEngineRunner, type EngineRunnerController } from "./runner.js";
import {
  engineStatusReducer,
  IDLE_STATUS,
  type EngineAction,
  type EngineStatus,
} from "./status.js";
import {
  runEngineOperation,
  type EngineCallOptions,
  type EngineWorkerFactory,
} from "./worker-client.js";
import type {
  EngineOperationInputs,
  EngineOperationKind,
  EngineOperationResults,
} from "./operations.js";

export type RunEngineOperationOptions = Pick<
  EngineCallOptions,
  "transferModel"
>;
export interface UseEngineOperationResult<
  K extends EngineOperationKind,
  TResult = EngineOperationResults[K],
> {
  readonly status: EngineStatus<TResult>;
  readonly run: (
    input: EngineOperationInputs[K],
    options?: RunEngineOperationOptions,
  ) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
}

/** All hooks share the same cancellation, replacement and unmount lifecycle. */
function useOperation<K extends EngineOperationKind, TResult>(
  createWorker: EngineWorkerFactory,
  kind: K,
  project: (result: EngineOperationResults[K]) => TResult,
): UseEngineOperationResult<K, TResult> {
  const [status, dispatch] = useReducer(
    engineStatusReducer<TResult>,
    IDLE_STATUS as EngineStatus<TResult>,
  );
  const current = useRef({ createWorker, project });
  current.current = { createWorker, project };
  type Args = [
    input: EngineOperationInputs[K],
    options?: RunEngineOperationOptions,
  ];
  const runner = useRef<EngineRunnerController<
    Args,
    EngineOperationResults[K]
  > | null>(null);
  runner.current ??= createEngineRunner<Args, EngineOperationResults[K]>(
    (signal, input, options) =>
      runEngineOperation(current.current.createWorker, kind, input, {
        signal,
        ...(options?.transferModel === undefined
          ? {}
          : { transferModel: options.transferModel }),
      }),
    (action: EngineAction<EngineOperationResults[K]>) => {
      // Projection only runs for a winning generation: stale geometry never
      // reaches refs, and geometry buffers never enter React state.
      if (action.type === "success")
        dispatch({
          type: "success",
          result: current.current.project(action.result),
        });
      else dispatch(action);
    },
  );
  useEffect(() => () => runner.current?.cancel(), []);
  return {
    status,
    run: runner.current.run,
    cancel: runner.current.cancel,
    reset: runner.current.reset,
  };
}
const identity = <T>(value: T): T => value;
export function useModelClearance(
  createWorker: EngineWorkerFactory,
): UseEngineOperationResult<"clearance"> {
  return useOperation(createWorker, "clearance", identity);
}
export function useModelMeasurement(
  createWorker: EngineWorkerFactory,
): UseEngineOperationResult<"measure"> {
  return useOperation(createWorker, "measure", identity);
}
export function useModelSection(
  createWorker: EngineWorkerFactory,
): UseEngineOperationResult<"section"> {
  return useOperation(createWorker, "section", identity);
}
export function useModelPrintability(
  createWorker: EngineWorkerFactory,
): UseEngineOperationResult<"printability"> {
  return useOperation(createWorker, "printability", identity);
}
/** Returns a proposal and fit evidence only; the hook never applies alignment. */
export function useModelAlignment(
  createWorker: EngineWorkerFactory,
): UseEngineOperationResult<"alignment"> {
  return useOperation(createWorker, "alignment", identity);
}
export type SimplificationMetadata = Omit<SimplificationResult, "model">;
export interface UseModelSimplificationResult extends UseEngineOperationResult<
  "simplify",
  SimplificationMetadata
> {
  /** Borrowed model for the latest complete run; never held in React state. */
  readonly getSimplifiedModel: () => NormalizedModel | null;
}
export function useModelSimplification(
  createWorker: EngineWorkerFactory,
): UseModelSimplificationResult {
  const model = useRef<NormalizedModel | null>(null);
  const operation = useOperation(createWorker, "simplify", (result) => {
    const { model: geometry, ...metadata } = result;
    model.current = geometry;
    return metadata;
  });
  return {
    ...operation,
    run: (input, options) => {
      model.current = null;
      operation.run(input, options);
    },
    cancel: () => {
      model.current = null;
      operation.cancel();
    },
    reset: () => {
      model.current = null;
      operation.reset();
    },
    getSimplifiedModel: () => model.current,
  };
}
