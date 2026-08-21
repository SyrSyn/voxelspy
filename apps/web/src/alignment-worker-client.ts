import type { AlignmentEstimate } from "@voxelspy/analysis";
import type { RigidTransform } from "@voxelspy/contracts";
import type { SupportedFormat } from "@voxelspy/importers";
import {
  requireSupportedFormat,
  resolveFrameOptions,
  type FrameSource,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "./formats";

type ResolvedUnit = ResolvedSourceUnit;
type ResolvedAxis = ResolvedSourceAxis;

/**
 * Message protocol for the dedicated alignment worker (`alignment.worker.ts`).
 * A fifth app-internal, single-purpose worker channel next to
 * `comparison.worker.ts`, `inspect.worker.ts`, `summary.worker.ts`, and
 * `clearance.worker.ts` -- not an extension of any of them, and deliberately
 * not routed through `comparison.worker.ts`'s versioned protocol: alignment
 * is a bounded, throwaway "estimate a transform" computation the engine
 * (`estimateAlignment` in `@voxelspy/analysis`) performs entirely on its
 * inputs, with no model state persisted afterwards, so it needs neither that
 * protocol's multi-step import/analysis session nor its wire schema.
 *
 * Mirrors `clearance-worker-client.ts`'s lifecycle: one fresh dedicated
 * worker per call, imports both parts from their raw bytes independently of
 * any comparison already run, runs one bounded `estimateAlignment` pass, and
 * is torn down once a result, failure, or abort settles the returned
 * promise. Nothing computed here is ever applied automatically -- see
 * `ComparisonFlow.tsx`'s alignment review/accept step, which is the only
 * place a returned `AlignmentEstimate.transform` can become part of a
 * comparison request.
 */
export interface AlignmentPartSource {
  readonly file: File;
  readonly unit: ResolvedUnit | "";
  readonly axis: ResolvedAxis | "";
  readonly frameSource?: FrameSource;
}

export interface EstimateIcpAlignmentSource {
  /** The part being aligned (this app's candidate), in its own local frame. */
  readonly moving: AlignmentPartSource;
  /** The reference part (this app's baseline), never adjusted. */
  readonly fixed: AlignmentPartSource;
  /** Seeds the iteration -- typically a `correspondence-points` result the user has already reviewed. Identity (no assumed placement) if omitted. */
  readonly initialTransform?: RigidTransform;
  readonly maxIterations?: number;
  readonly convergenceToleranceMillimetres?: number;
}

export interface AlignmentIcpWorkerPartRequest {
  readonly format: SupportedFormat;
  readonly sourceName: string;
  readonly bytes: Uint8Array;
  readonly options: {
    declaredUnit?: ResolvedUnit;
    declaredAxis?: ResolvedAxis;
    userUnit?: ResolvedUnit;
    userAxis?: ResolvedAxis;
  };
}

export interface AlignmentIcpWorkerRequest {
  readonly requestId: number;
  readonly kind: "align-icp";
  readonly moving: AlignmentIcpWorkerPartRequest;
  readonly fixed: AlignmentIcpWorkerPartRequest;
  readonly initialTransform?: RigidTransform;
  readonly maxIterations?: number;
  readonly convergenceToleranceMillimetres?: number;
}

export type AlignmentIcpWorkerResponse =
  | {
      readonly requestId: number;
      readonly kind: "align-icp";
      readonly ok: true;
      readonly estimate: AlignmentEstimate;
    }
  | {
      readonly requestId: number;
      readonly kind: "align-icp";
      readonly ok: false;
      readonly message: string;
    };

/** Raised when an alignment estimate is stopped because its `AbortSignal` fired, distinct from a genuine import/estimate failure -- mirrors `ClearanceCancelledError`. */
export class AlignmentCancelledError extends Error {
  constructor(message = "Alignment estimate cancelled.") {
    super(message);
    this.name = "AlignmentCancelledError";
  }
}

/**
 * Runs one request/response round trip against a fresh dedicated alignment
 * worker: imports the moving (candidate) and fixed (baseline) parts from
 * their raw bytes and estimates an `iterative-closest-point` alignment
 * between them, entirely off the main thread. Both files' bytes are read
 * once here and transferred (not cloned) to the worker; only the
 * serializable `AlignmentEstimate` travels back -- never applied by this
 * function or the worker, only returned for the caller to review. No
 * network transmission is involved.
 */
export async function estimateIcpAlignmentAsync(
  source: EstimateIcpAlignmentSource,
  signal?: AbortSignal,
): Promise<AlignmentEstimate> {
  const movingFormat = requireSupportedFormat(source.moving.file.name);
  const fixedFormat = requireSupportedFormat(source.fixed.file.name);

  const [movingBytes, fixedBytes] = await Promise.all([
    source.moving.file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    source.fixed.file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AlignmentCancelledError());
      return;
    }
    const worker = new Worker(
      new URL("./alignment.worker.ts", import.meta.url),
      { type: "module", name: "voxelspy-alignment" },
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
      finish(() => reject(new AlignmentCancelledError()));
    };
    const onMessage = (event: MessageEvent<AlignmentIcpWorkerResponse>) => {
      const data = event.data;
      if (data.requestId !== requestId || data.kind !== "align-icp") return;
      finish(() => {
        if (data.ok) resolve(data.estimate);
        else reject(new Error(data.message));
      });
    };
    const onError = () => {
      finish(() => reject(new Error("Alignment worker stopped unexpectedly.")));
    };

    signal?.addEventListener("abort", onAbort);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const partRequest = (
      part: AlignmentPartSource,
      format: SupportedFormat,
      bytes: Uint8Array,
    ): AlignmentIcpWorkerPartRequest => ({
      format,
      sourceName: part.file.name,
      bytes,
      options: resolveFrameOptions(
        format,
        part.frameSource ?? "default",
        part.unit,
        part.axis,
      ),
    });

    const request: AlignmentIcpWorkerRequest = {
      kind: "align-icp",
      requestId,
      moving: partRequest(source.moving, movingFormat, movingBytes),
      fixed: partRequest(source.fixed, fixedFormat, fixedBytes),
      ...(source.initialTransform === undefined
        ? {}
        : { initialTransform: source.initialTransform }),
      ...(source.maxIterations === undefined
        ? {}
        : { maxIterations: source.maxIterations }),
      ...(source.convergenceToleranceMillimetres === undefined
        ? {}
        : {
            convergenceToleranceMillimetres:
              source.convergenceToleranceMillimetres,
          }),
    };
    worker.postMessage(request, [movingBytes.buffer, fixedBytes.buffer]);
  });
}
