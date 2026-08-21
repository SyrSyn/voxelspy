/**
 * The status model every hook in this package exposes, and the pure
 * reducer that drives it. Kept independent of React (no hook, no
 * `useReducer` call, here) so it can be constructed and asserted against
 * directly in tests without rendering anything -- see
 * `test/status.test.ts`.
 *
 * Exactly four top-level statuses, matching the bead's acceptance
 * criterion literally: `"idle" | "running" | "complete" | "failed"`. A
 * cancelled run is reported as `"failed"` with `reason.kind === "cancelled"`
 * rather than as a fifth top-level status, so a consumer who only
 * discriminates on `status` still gets a safe, non-`"complete"` answer,
 * while one who cares about the distinction can read `reason.kind`.
 *
 * `"complete"` always carries the engine's own result object completely
 * unmodified -- for `useModelComparison` this includes the case where
 * `result.outcome.state === "indeterminate"`. This status model describes
 * only the asynchronous lifecycle of *running the call*; it never
 * re-derives, flattens, or summarizes what the engine itself already
 * reported. An indeterminate analysis is still `"complete"` -- the call
 * finished and returned a validated answer, and that answer's "no method
 * could produce a validated result" is a fact about the geometry, not
 * about whether the hook is done running.
 */
export type EngineFailureReason =
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly error: Error };

export type EngineStatus<TResult> =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "complete"; readonly result: TResult }
  | { readonly status: "failed"; readonly reason: EngineFailureReason };

export type EngineAction<TResult> =
  | { readonly type: "start" }
  | { readonly type: "success"; readonly result: TResult }
  | { readonly type: "failure"; readonly error: Error }
  | { readonly type: "cancelled" }
  | { readonly type: "reset" };

export const IDLE_STATUS: EngineStatus<never> = { status: "idle" };

export function engineStatusReducer<TResult>(
  _state: EngineStatus<TResult>,
  action: EngineAction<TResult>,
): EngineStatus<TResult> {
  switch (action.type) {
    case "start":
      return { status: "running" };
    case "success":
      return { status: "complete", result: action.result };
    case "failure":
      return {
        status: "failed",
        reason: { kind: "error", error: action.error },
      };
    case "cancelled":
      return { status: "failed", reason: { kind: "cancelled" } };
    case "reset":
      return { status: "idle" };
  }
}

/** True exactly for `"failed"` produced by an aborted run rather than a genuine failure. */
export function isCancelledStatus(
  status: EngineStatus<unknown>,
): status is { status: "failed"; reason: { kind: "cancelled" } } {
  return status.status === "failed" && status.reason.kind === "cancelled";
}
