/**
 * Raised when a hook's run is stopped because its own cancellation was
 * requested (either the caller's own `cancel()` or automatic unmount
 * cleanup) before the worker responded. Mirrors the
 * `InspectionCancelledError`/`ComparisonCancelledError` pattern already
 * established in `apps/web`'s worker clients: a distinct class so a
 * consumer, or this package's own reducer, can tell "stopped on purpose"
 * apart from "genuinely failed" with `instanceof` rather than string
 * matching.
 */
export class EngineCancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "EngineCancelledError";
  }
}

/**
 * A structured failure surfaced by the worker boundary itself -- an
 * unexpected/malformed message, a worker that terminated or errored before
 * responding, or a mismatched request ID -- as opposed to a failure the
 * engine call itself threw (see `EngineError` below). Mirrors
 * `ComparisonProtocolError` in `apps/web/src/worker-client.ts`.
 */
export class EngineProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineProtocolError";
  }
}

/**
 * Reconstructs, on the main thread, the error an engine call
 * (`inspectModel`/`analyzeModelPair`) threw inside the worker. The worker
 * boundary can only carry a plain string message and the original error's
 * `.name` (see `EngineWorkerResponse` in `protocol.ts`) -- not the original
 * class or stack -- so this is a new `Error` whose `.name` is set to the
 * original `errorName` when one was reported, letting a consumer still
 * write `error.name === "InspectionResourceLimitError"` (or match against
 * `@voxelspy/analysis`'s exported error classes' `.name` values) without
 * this package needing to re-import and re-throw every one of those classes
 * itself.
 */
export function describeEngineFailure(
  message: string,
  errorName?: string,
): Error {
  const error = new Error(message);
  if (errorName) error.name = errorName;
  return error;
}
