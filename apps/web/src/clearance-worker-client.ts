import type { ClearanceCheckResult } from "@voxelspy/analysis";
import type {
  ContractWarning,
  Mat4,
  NormalizedModel,
  SourceAxis,
  SourceUnit,
} from "@voxelspy/contracts";
import { inferFormat } from "@voxelspy/importers";
import type { SupportedFormat } from "@voxelspy/importers";

type ResolvedUnit = Exclude<SourceUnit, "unknown">;
type ResolvedAxis = Exclude<SourceAxis, "unknown">;

/**
 * Message protocol for the dedicated clearance worker (`clearance.worker.ts`).
 * A fourth app-internal, single-purpose worker channel next to
 * `comparison.worker.ts` (versioned two-model diff protocol),
 * `inspect.worker.ts` (single-model inspect/diagnose/forensics), and
 * `summary.worker.ts` (presentation summary) -- not an extension of any of
 * them, since a clearance check needs two independently imported models plus
 * each part's own deliberate placement transform in one request, a shape
 * none of the existing channels carries. Mirrors `inspect-worker-client.ts`'s
 * lifecycle exactly: one fresh dedicated worker per call, imports both parts
 * from their raw bytes, runs one bounded `checkClearance` pass, and is torn
 * down once a result, failure, or abort settles the returned promise.
 */
export interface ClearancePartSource {
  readonly file: File;
  readonly unit: ResolvedUnit;
  readonly axis: ResolvedAxis;
  readonly frameSource?: "default" | "expert";
  /**
   * This part's own rigid placement into the shared comparison frame, built
   * by `buildPlacementMatrix` (`clearance-placement.ts`) from the explicit
   * translation/rotation the user set on `/tools/clearance-fit/`. Honoured
   * exactly by `checkClearance` -- never auto-aligned or adjusted.
   */
  readonly modelToComparison: Mat4;
}

export interface CheckClearanceSource {
  readonly first: ClearancePartSource;
  readonly second: ClearancePartSource;
  readonly desiredClearanceMillimetres: number;
}

interface ClearanceWorkerPartRequest {
  readonly format: SupportedFormat;
  readonly sourceName: string;
  readonly bytes: Uint8Array;
  readonly options: {
    declaredUnit?: ResolvedUnit;
    declaredAxis?: ResolvedAxis;
    userUnit?: ResolvedUnit;
    userAxis?: ResolvedAxis;
  };
  readonly modelToComparison: Mat4;
}

export interface ClearanceWorkerRequest {
  readonly requestId: number;
  readonly kind: "clearance";
  readonly first: ClearanceWorkerPartRequest;
  readonly second: ClearanceWorkerPartRequest;
  readonly desiredClearanceMillimetres: number;
}

/** One part's import outcome: its normalized model (for the 3D view and
 *  provenance display) plus the import-time warnings `ClearanceCheckResult`
 *  itself does not carry. Mirrors `MeshHealthDiagnosisOutcome`'s rationale
 *  for handing a model's typed-array geometry back to the main thread: this
 *  is a deliberate, single, already-bounded transfer for the report's own 3D
 *  view, not a general geometry channel. */
export interface ClearancePartOutcome {
  readonly model: NormalizedModel;
  readonly warnings: readonly ContractWarning[];
}

export interface ClearanceOutcome {
  readonly result: ClearanceCheckResult;
  readonly first: ClearancePartOutcome;
  readonly second: ClearancePartOutcome;
}

export type ClearanceWorkerResponse =
  | {
      readonly requestId: number;
      readonly kind: "clearance";
      readonly ok: true;
      readonly outcome: ClearanceOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "clearance";
      readonly ok: false;
      readonly message: string;
    };

/** Raised when a clearance check is stopped because its `AbortSignal` fired,
 *  distinct from a genuine import/check failure -- mirrors
 *  `InspectionCancelledError` in `inspect-worker-client.ts`. */
export class ClearanceCancelledError extends Error {
  constructor(message = "Clearance check cancelled.") {
    super(message);
    this.name = "ClearanceCancelledError";
  }
}

/**
 * Runs one request/response round trip against a fresh dedicated clearance
 * worker: imports both parts from their raw bytes and checks clearance/fit
 * between them, entirely off the main thread. Both files' bytes are read
 * once here and transferred (not cloned) to the worker; only the serializable
 * result -- plus the two already-bounded imported models used to draw the 3D
 * view -- travels back. No network transmission is involved.
 */
export async function checkClearanceAsync(
  source: CheckClearanceSource,
  signal?: AbortSignal,
): Promise<ClearanceOutcome> {
  const firstFormat = inferFormat(source.first.file.name);
  if (!firstFormat)
    throw new Error(
      `${source.first.file.name} is not a supported STL or OBJ file.`,
    );
  const secondFormat = inferFormat(source.second.file.name);
  if (!secondFormat)
    throw new Error(
      `${source.second.file.name} is not a supported STL or OBJ file.`,
    );

  const [firstBytes, secondBytes] = await Promise.all([
    source.first.file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    source.second.file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClearanceCancelledError());
      return;
    }
    const worker = new Worker(
      new URL("./clearance.worker.ts", import.meta.url),
      { type: "module", name: "voxelspy-clearance" },
    );
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
      finish(() => reject(new ClearanceCancelledError()));
    };
    const onMessage = (event: MessageEvent<ClearanceWorkerResponse>) => {
      const data = event.data;
      if (data.requestId !== requestId || data.kind !== "clearance") return;
      finish(() => {
        if (data.ok) resolve(data.outcome);
        else reject(new Error(data.message));
      });
    };
    const onError = () => {
      finish(() => reject(new Error("Clearance worker stopped unexpectedly.")));
    };

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const partRequest = (
      part: ClearancePartSource,
      format: SupportedFormat,
      bytes: Uint8Array,
    ): ClearanceWorkerPartRequest => ({
      format,
      sourceName: part.file.name,
      bytes,
      options:
        part.frameSource === "expert"
          ? { userUnit: part.unit, userAxis: part.axis }
          : { declaredUnit: part.unit, declaredAxis: part.axis },
      modelToComparison: part.modelToComparison,
    });

    const request: ClearanceWorkerRequest = {
      kind: "clearance",
      requestId,
      first: partRequest(source.first, firstFormat, firstBytes),
      second: partRequest(source.second, secondFormat, secondBytes),
      desiredClearanceMillimetres: source.desiredClearanceMillimetres,
    };
    worker.postMessage(request, [firstBytes.buffer, secondBytes.buffer]);
  });
}
