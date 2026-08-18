import type {
  MeasureOptions,
  MeasurementQuery,
  MeasurementResult,
  SectionOptions,
  SectionPlane,
  SectionResult,
} from "@voxelspy/analysis";
import type {
  ContractWarning,
  NormalizedModel,
  SourceAxis,
  SourceUnit,
} from "@voxelspy/contracts";
import { inferFormat } from "@voxelspy/importers";

type ResolvedUnit = Exclude<SourceUnit, "unknown">;
type ResolvedAxis = Exclude<SourceAxis, "unknown">;

export interface MeasureSource {
  file: File;
  unit: ResolvedUnit;
  axis: ResolvedAxis;
  frameSource?: "default" | "expert";
}

/** What one successful `"load"` call hands back: the imported model itself
 *  (this viewer needs the model's own mesh geometry to draw, the same
 *  rationale `MeshHealthDiagnosisOutcome` documents in
 *  `inspect-worker-client.ts`) plus its import-time `warnings`. */
export interface MeasureLoadOutcome {
  readonly model: NormalizedModel;
  readonly warnings: readonly ContractWarning[];
}

/**
 * Message protocol for the dedicated measurement worker (`measure.worker.ts`).
 * An app-internal channel, deliberately outside the versioned comparison
 * protocol -- same rationale `inspect-worker-client.ts` documents -- but
 * shaped differently from *both* precedents already in this app:
 *
 * - `inspect.worker.ts` spins up a fresh worker and re-imports the source
 *   file for every single call, which is fine for one report per file but
 *   would re-parse the whole file on every click of an interactive
 *   click-to-measure tool.
 * - `clearance.worker.ts` (and `comparison.worker.ts`) run one whole
 *   computation to completion per worker lifetime.
 *
 * Measure & Section needs neither shape: one model is imported once
 * (`"load"`), then the same already-imported `NormalizedModel` answers an
 * open-ended number of `"measure"`/`"section"` queries -- one per click, per
 * typed point, per plane adjustment -- for as long as the tool page keeps
 * that model open. So this worker is a small *session*: it stays alive
 * across many request/response round trips against one in-memory model,
 * closer in shape to `comparison.worker.ts`'s persistent session than to
 * `inspect.worker.ts`'s spin-up-per-call pattern, but far simpler than
 * either -- no queued operations, no cancellation handshake, no progress
 * events -- because every query here is a single bounded, fast computation
 * (`measureOnModel`/`sectionModel` are both charge-before-work bounded, see
 * their own doc comments in `@voxelspy/analysis`), not a potentially
 * long-running two-model analysis.
 */
interface MeasureWorkerRequestBase {
  readonly requestId: number;
}

export type MeasureWorkerRequest =
  | (MeasureWorkerRequestBase & {
      readonly kind: "load";
      readonly format: "stl" | "obj";
      readonly sourceName: string;
      readonly bytes: Uint8Array;
      readonly options: {
        declaredUnit?: ResolvedUnit;
        declaredAxis?: ResolvedAxis;
        userUnit?: ResolvedUnit;
        userAxis?: ResolvedAxis;
      };
    })
  | (MeasureWorkerRequestBase & {
      readonly kind: "measure";
      readonly query: MeasurementQuery;
      readonly options: MeasureOptions | undefined;
    })
  | (MeasureWorkerRequestBase & {
      readonly kind: "section";
      readonly plane: SectionPlane;
      readonly options: SectionOptions | undefined;
    });

export type MeasureWorkerResponse =
  | {
      readonly requestId: number;
      readonly kind: "load";
      readonly ok: true;
      readonly outcome: MeasureLoadOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "load";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "measure";
      readonly ok: true;
      readonly result: MeasurementResult;
    }
  | {
      readonly requestId: number;
      readonly kind: "measure";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "section";
      readonly ok: true;
      readonly result: SectionResult;
    }
  | {
      readonly requestId: number;
      readonly kind: "section";
      readonly ok: false;
      readonly message: string;
    };

/** Raised when a session was cancelled (its `AbortSignal` fired, or `close()`
 *  was called) rather than failing on its own terms -- mirrors
 *  `InspectionCancelledError`/`ClearanceCancelledError`. */
export class MeasurementSessionCancelledError extends Error {
  constructor(message = "Measurement session cancelled.") {
    super(message);
    this.name = "MeasurementSessionCancelledError";
  }
}

/** Raised when the worker itself stops responding (a genuine crash), distinct
 *  from a query that fails on its own terms (which resolves with `ok: false`
 *  and is surfaced as a plain `Error` from `measure`/`section` instead). */
export class MeasurementSessionError extends Error {
  constructor(message = "Measurement worker stopped unexpectedly.") {
    super(message);
    this.name = "MeasurementSessionError";
  }
}

/** One open session against one already-imported model: `measure`/`section`
 *  each resolve or reject per call, any number of times, until `close()` (or
 *  the `AbortSignal` passed to `openMeasureSession`) tears the worker down. */
export interface MeasureSession {
  readonly model: NormalizedModel;
  readonly warnings: readonly ContractWarning[];
  measure(
    query: MeasurementQuery,
    options?: MeasureOptions,
  ): Promise<MeasurementResult>;
  section(
    plane: SectionPlane,
    options?: SectionOptions,
  ): Promise<SectionResult>;
  /** Terminates the underlying worker and rejects any in-flight call. Safe to
   *  call more than once. */
  close(): void;
}

/**
 * Imports one local model file into a fresh dedicated measurement worker and
 * returns a session for issuing any number of `measure`/`section` queries
 * against it, entirely off the main thread. See the module doc comment above
 * for why this is a small persistent session rather than either of this
 * app's two existing worker shapes.
 *
 * No network transmission is involved; the worker runs entirely in this
 * browser, and only serializable query results travel back to the caller --
 * except for the one `"load"` response, which also carries the imported
 * model's own typed-array geometry back to the main thread so the viewer can
 * draw it (the same deliberate exception `MeshHealthDiagnosisOutcome`
 * documents).
 */
export async function openMeasureSession(
  source: MeasureSource,
  signal?: AbortSignal,
): Promise<MeasureSession> {
  const format = inferFormat(source.file.name);
  if (!format)
    throw new Error(`${source.file.name} is not a supported STL or OBJ file.`);
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  if (signal?.aborted) throw new MeasurementSessionCancelledError();

  const worker = new Worker(new URL("./measure.worker.ts", import.meta.url), {
    type: "module",
    name: "voxelspy-measure",
  });

  let closed = false;
  let requestCounter = 0;
  const pending = new Map<
    number,
    {
      resolve: (response: MeasureWorkerResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  const rejectAllPending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const teardown = (error: Error) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    worker.terminate();
    rejectAllPending(error);
  };

  function onMessage(event: MessageEvent<MeasureWorkerResponse>) {
    const entry = pending.get(event.data.requestId);
    if (!entry) return;
    pending.delete(event.data.requestId);
    entry.resolve(event.data);
  }
  function onError() {
    teardown(new MeasurementSessionError());
  }
  function onAbort() {
    teardown(new MeasurementSessionCancelledError());
  }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  signal?.addEventListener("abort", onAbort);

  function call<K extends MeasureWorkerRequest["kind"]>(
    build: (requestId: number) => Extract<MeasureWorkerRequest, { kind: K }>,
    transfer?: Transferable[],
  ): Promise<Extract<MeasureWorkerResponse, { kind: K }>> {
    if (closed) return Promise.reject(new MeasurementSessionCancelledError());
    requestCounter += 1;
    const requestId = requestCounter;
    const request = build(requestId);
    return new Promise((resolve, reject) => {
      pending.set(requestId, {
        resolve: resolve as (response: MeasureWorkerResponse) => void,
        reject,
      });
      worker.postMessage(request, transfer ?? []);
    });
  }

  let loadResponse: Extract<MeasureWorkerResponse, { kind: "load" }>;
  try {
    loadResponse = await call<"load">(
      (requestId) => ({
        kind: "load",
        requestId,
        format,
        sourceName: source.file.name,
        bytes,
        options:
          source.frameSource === "expert"
            ? { userUnit: source.unit, userAxis: source.axis }
            : { declaredUnit: source.unit, declaredAxis: source.axis },
      }),
      [bytes.buffer],
    );
  } catch (error) {
    teardown(error instanceof Error ? error : new MeasurementSessionError());
    throw error;
  }
  if (!loadResponse.ok) {
    teardown(new MeasurementSessionCancelledError("Session closed."));
    throw new Error(loadResponse.message);
  }

  const { model, warnings } = loadResponse.outcome;

  return {
    model,
    warnings,
    async measure(query, options) {
      const response = await call<"measure">((requestId) => ({
        kind: "measure",
        requestId,
        query,
        options,
      }));
      if (!response.ok) throw new Error(response.message);
      return response.result;
    },
    async section(plane, options) {
      const response = await call<"section">((requestId) => ({
        kind: "section",
        requestId,
        plane,
        options,
      }));
      if (!response.ok) throw new Error(response.message);
      return response.result;
    },
    close() {
      teardown(new MeasurementSessionCancelledError("Session closed."));
    },
  };
}
