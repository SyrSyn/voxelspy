import type { InspectionResult } from "@voxelspy/analysis";
import type {
  ContractWarning,
  SourceAxis,
  SourceUnit,
} from "@voxelspy/contracts";
import { inferFormat } from "@voxelspy/importers";

type ResolvedUnit = Exclude<SourceUnit, "unknown">;
type ResolvedAxis = Exclude<SourceAxis, "unknown">;

export interface InspectSource {
  file: File;
  unit: ResolvedUnit;
  axis: ResolvedAxis;
  frameSource?: "default" | "expert";
}

/**
 * Message protocol for the dedicated inspection worker (`inspect.worker.ts`).
 * This is an app-internal channel, deliberately outside the versioned
 * comparison-worker protocol in `@voxelspy/contracts`: inspecting a single
 * model needs neither the multi-operation session state nor the
 * cancellation/progress handshake `comparison.worker.ts` implements for a
 * potentially long-running two-model analysis. `inspectModel` itself is a
 * single bounded pass over one model's already-imported geometry (see
 * `packages/analysis/src/inspect.ts`), so one request/response round trip
 * per inspection is enough -- mirroring `summary-worker-client.ts`'s
 * simpler protocol, not `worker-client.ts`'s stateful one.
 */
export interface InspectWorkerRequest {
  readonly requestId: number;
  readonly format: "stl" | "obj";
  readonly sourceName: string;
  readonly bytes: Uint8Array;
  readonly options: {
    declaredUnit?: ResolvedUnit;
    declaredAxis?: ResolvedAxis;
    userUnit?: ResolvedUnit;
    userAxis?: ResolvedAxis;
  };
}

/**
 * What one successful inspection hands back to the UI: the serializable
 * `InspectionResult` plus the imported model's own `warnings` (import-time
 * notices such as unsupported-content approximations), which
 * `InspectionResult` does not carry itself -- it echoes only `frame` and
 * `provenance` from the source `NormalizedModel`, not `warnings`. Neither
 * field holds a typed-array geometry buffer: the worker imports the model,
 * computes the report, and lets the model (with its Float64Array positions
 * and Uint32Array indices) go out of scope inside the worker. No geometry
 * buffer is ever posted back to the main thread or held in React state.
 */
export interface InspectionOutcome {
  readonly inspection: InspectionResult;
  readonly warnings: readonly ContractWarning[];
}

export type InspectWorkerResponse =
  | {
      readonly requestId: number;
      readonly ok: true;
      readonly outcome: InspectionOutcome;
    }
  | {
      readonly requestId: number;
      readonly ok: false;
      readonly message: string;
    };

/**
 * Raised when an inspection run is stopped because its `AbortSignal` fired,
 * distinct from a genuine import/inspection failure -- mirrors
 * `ComparisonCancelledError` in `worker-client.ts`.
 */
export class InspectionCancelledError extends Error {
  constructor(message = "Inspection cancelled.") {
    super(message);
    this.name = "InspectionCancelledError";
  }
}

/**
 * Imports one local model file and inspects it, entirely off the main
 * thread. A fresh dedicated worker is spun up per call and torn down once a
 * result, failure, or abort settles the returned promise -- the same
 * lifecycle `summarizeModelComparisonAsync` uses, chosen for the same
 * reason: inspection is a single bounded computation, not a session that
 * benefits from a persisted worker across multiple requests.
 *
 * The file's bytes are read once here and then transferred (not cloned) to
 * the worker: unlike `runComparison`, nothing on this side needs the raw
 * bytes again afterward (there is no "save session" or "export report" step
 * for a single-model inspection), so a zero-copy transfer is strictly
 * better than a structured-clone copy.
 *
 * No network transmission is involved; the worker runs entirely in this
 * browser, and only the serializable `InspectionOutcome` -- never a
 * geometry buffer -- travels back to the caller.
 */
export async function inspectSourceAsync(
  source: InspectSource,
  signal?: AbortSignal,
): Promise<InspectionOutcome> {
  const format = inferFormat(source.file.name);
  if (!format)
    throw new Error(`${source.file.name} is not a supported STL or OBJ file.`);
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InspectionCancelledError());
      return;
    }
    const worker = new Worker(new URL("./inspect.worker.ts", import.meta.url), {
      type: "module",
      name: "voxelspy-inspect",
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
      finish(() => reject(new InspectionCancelledError()));
    };
    const onMessage = (event: MessageEvent<InspectWorkerResponse>) => {
      const data = event.data;
      if (data.requestId !== requestId) return;
      if (data.ok) finish(() => resolve(data.outcome));
      else finish(() => reject(new Error(data.message)));
    };
    const onError = () => {
      finish(() =>
        reject(new Error("Inspection worker stopped unexpectedly.")),
      );
    };

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const request: InspectWorkerRequest = {
      requestId,
      format,
      sourceName: source.file.name,
      bytes,
      options:
        source.frameSource === "expert"
          ? { userUnit: source.unit, userAxis: source.axis }
          : { declaredUnit: source.unit, declaredAxis: source.axis },
    };
    worker.postMessage(request, [request.bytes.buffer]);
  });
}
