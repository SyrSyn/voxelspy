import { EngineCancelledError } from "./errors.js";
import type { EngineAction } from "./status.js";

/**
 * The imperative run/cancel/reset control flow both hooks in this package
 * wrap in `useReducer`/`useRef`/`useCallback`. Pulled out of the hooks
 * entirely so it can be constructed and driven directly in tests, with a
 * plain recording `dispatch` function and a fake `execute`, without
 * rendering any component -- see `test/runner.test.ts`. `useModelInspection`
 * and `useModelComparison` are thin React wrappers around exactly this
 * object; they add no control-flow logic of their own beyond keeping one
 * instance alive across renders and re-pointing it at the caller's latest
 * `createWorker`/`execute` function.
 *
 * `execute` receives the run's own `AbortSignal` plus whatever arguments
 * `run()` was called with, and must reject with `EngineCancelledError`
 * (never resolve) when that signal fires -- `runModelInspection`/
 * `runModelComparison` in `worker-client.ts` already do this.
 *
 * A newer `run()` call always wins: it aborts whatever the previous call
 * started, and a `generation` counter discards any in-flight call's result
 * that arrives after an even newer call (or a `reset()`) has superseded it,
 * so `dispatch` only ever receives the outcome of the most recently
 * requested run.
 */
export interface EngineRunnerController<
  TArgs extends readonly unknown[],
  TResult,
> {
  readonly run: (...args: TArgs) => void;
  /** Cancels the in-flight run, if any. A no-op otherwise. */
  readonly cancel: () => void;
  /** Cancels any in-flight run and dispatches `{ type: "reset" }`. */
  readonly reset: () => void;
}

export function createEngineRunner<TArgs extends readonly unknown[], TResult>(
  execute: (signal: AbortSignal, ...args: TArgs) => Promise<TResult>,
  dispatch: (action: EngineAction<TResult>) => void,
): EngineRunnerController<TArgs, TResult> {
  let controller: AbortController | null = null;
  let generation = 0;

  const run = (...args: TArgs): void => {
    controller?.abort();
    const active = new AbortController();
    controller = active;
    const thisGeneration = ++generation;
    dispatch({ type: "start" });
    void (async () => {
      try {
        const result = await execute(active.signal, ...args);
        if (generation !== thisGeneration) return;
        dispatch({ type: "success", result });
      } catch (error) {
        if (generation !== thisGeneration) return;
        if (error instanceof EngineCancelledError) {
          dispatch({ type: "cancelled" });
        } else {
          dispatch({
            type: "failure",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      } finally {
        if (controller === active) controller = null;
      }
    })();
  };

  const cancel = (): void => controller?.abort();

  const reset = (): void => {
    controller?.abort();
    generation += 1;
    dispatch({ type: "reset" });
  };

  return { run, cancel, reset };
}
