import type { SimplificationResult, SimplifyOptions } from "@voxelspy/analysis";
import type {
  ContractWarning,
  NormalizedModel,
  SourceAxis,
  SourceUnit,
} from "@voxelspy/contracts";
import {
  inferFormat,
  type ExportOptions,
  type ExportResult,
} from "@voxelspy/importers";

/**
 * `exportModel`'s own `ResolvedSourceUnit`/`ResolvedSourceAxis` types
 * (`packages/importers/src/normalize.ts`) are not part of that package's
 * public surface, so this tool defines the identical `Exclude<..., "unknown">`
 * shape locally -- the same convention `worker-client.ts`, `measure-worker-
 * client.ts`, and every source-frame selection in this app already use.
 */
export type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
export type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

export interface ConvertSource {
  file: File;
  unit: ResolvedSourceUnit;
  axis: ResolvedSourceAxis;
  frameSource?: "default" | "expert";
}

/**
 * Cheap, honest placed-geometry counts: summed per placement instance (the
 * same way `exportModel`'s own `countFlattenedGeometry`, in
 * `packages/importers/src/export.ts`, counts flattened geometry), not per
 * unique mesh -- so a model that reuses one mesh across many instances is
 * not undercounted, and this number matches what a subsequent simplify or
 * export step will itself report as the "original" count.
 */
export interface PlacedGeometryCounts {
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly meshCount: number;
  readonly instanceCount: number;
}

/** What one successful `"load"` call hands back: no geometry crosses the
 *  worker boundary at all (this tool draws no 3D view -- see ConvertFlow.tsx's
 *  module doc comment), only the small, serializable facts a textual report
 *  needs. The imported model itself stays inside the worker for a
 *  subsequent `"simplify"`/`"export"` call against this same session. */
export interface ConvertLoadOutcome {
  readonly modelId: NormalizedModel["id"];
  readonly sourceName: string;
  readonly counts: PlacedGeometryCounts;
  readonly provenance: NormalizedModel["provenance"];
  readonly warnings: readonly ContractWarning[];
}

/** `SimplificationResult` minus its `model` field: the simplified geometry
 *  never leaves the worker (nothing in this tool's report needs it -- the
 *  certification numbers below are the point), it just becomes the input a
 *  later `"export"` call against this same session can select. */
export type ConvertSimplifyOutcome = Omit<SimplificationResult, "model">;

/** `ExportResult` plus which of this session's two models (the original load
 *  or the most recent simplification) actually produced these bytes --
 *  echoed back explicitly so a UI never has to infer it, matching this
 *  tool's "no silent defaults" discipline for export options themselves. */
export type ConvertExportOutcome = ExportResult & {
  readonly source: "original" | "simplified";
};

/**
 * Message protocol for the dedicated conversion worker (`convert.worker.ts`).
 * Shaped like `measure-worker-client.ts`'s small persistent session (see that
 * file's module doc comment for the rationale this mirrors): one model is
 * imported once (`"load"`), then any number of `"simplify"`/`"export"` calls
 * run against it without re-parsing the source file. Unlike Measure &
 * Section, a `"simplify"` call also replaces this session's "current
 * simplified model" (kept worker-side only), which a later `"export"` call
 * can select via `source: "simplified"` instead of `"original"`.
 */
interface ConvertWorkerRequestBase {
  readonly requestId: number;
}

export type ConvertWorkerRequest =
  | (ConvertWorkerRequestBase & {
      readonly kind: "load";
      readonly format: "stl" | "obj";
      readonly sourceName: string;
      readonly bytes: Uint8Array;
      readonly options: {
        declaredUnit?: ResolvedSourceUnit;
        declaredAxis?: ResolvedSourceAxis;
        userUnit?: ResolvedSourceUnit;
        userAxis?: ResolvedSourceAxis;
      };
    })
  | (ConvertWorkerRequestBase & {
      readonly kind: "simplify";
      readonly options: SimplifyOptions;
    })
  | (ConvertWorkerRequestBase & {
      readonly kind: "export";
      readonly source: "original" | "simplified";
      readonly options: ExportOptions;
    });

export type ConvertWorkerResponse =
  | {
      readonly requestId: number;
      readonly kind: "load";
      readonly ok: true;
      readonly outcome: ConvertLoadOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "load";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "simplify";
      readonly ok: true;
      readonly outcome: ConvertSimplifyOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "simplify";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "export";
      readonly ok: true;
      readonly outcome: ConvertExportOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "export";
      readonly ok: false;
      readonly message: string;
    };

/** Raised when a session was cancelled (its `AbortSignal` fired, or `close()`
 *  was called) rather than failing on its own terms -- mirrors
 *  `MeasurementSessionCancelledError`/`InspectionCancelledError`. */
export class ConvertSessionCancelledError extends Error {
  constructor(message = "Conversion session cancelled.") {
    super(message);
    this.name = "ConvertSessionCancelledError";
  }
}

/** Raised when the worker itself stops responding (a genuine crash), distinct
 *  from a call that fails on its own terms (which resolves with `ok: false`
 *  and is surfaced as a plain `Error` from `simplify`/`export` instead). */
export class ConvertSessionError extends Error {
  constructor(message = "Conversion worker stopped unexpectedly.") {
    super(message);
    this.name = "ConvertSessionError";
  }
}

/** One open session against one already-imported model: `simplify`/`export`
 *  each resolve or reject per call, any number of times, until `close()` (or
 *  the `AbortSignal` passed to `openConvertSession`) tears the worker down. */
export interface ConvertSession {
  readonly load: ConvertLoadOutcome;
  simplify(options: SimplifyOptions): Promise<ConvertSimplifyOutcome>;
  export(
    source: "original" | "simplified",
    options: ExportOptions,
  ): Promise<ConvertExportOutcome>;
  /** Terminates the underlying worker and rejects any in-flight call. Safe to
   *  call more than once. */
  close(): void;
}

/**
 * Imports one local model file into a fresh dedicated conversion worker and
 * returns a session for issuing any number of `simplify`/`export` calls
 * against it, entirely off the main thread. No network transmission is
 * involved; the worker runs entirely in this browser, and this tool draws no
 * 3D view, so nothing crosses back to the main thread except small,
 * serializable summaries, certification/export reports, and (only from a
 * successful `export` call) the produced file bytes themselves.
 */
export async function openConvertSession(
  source: ConvertSource,
  signal?: AbortSignal,
): Promise<ConvertSession> {
  const format = inferFormat(source.file.name);
  if (!format)
    throw new Error(`${source.file.name} is not a supported STL or OBJ file.`);
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  if (signal?.aborted) throw new ConvertSessionCancelledError();

  const worker = new Worker(new URL("./convert.worker.ts", import.meta.url), {
    type: "module",
    name: "voxelspy-convert",
  });

  let closed = false;
  let requestCounter = 0;
  const pending = new Map<
    number,
    {
      resolve: (response: ConvertWorkerResponse) => void;
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

  function onMessage(event: MessageEvent<ConvertWorkerResponse>) {
    const entry = pending.get(event.data.requestId);
    if (!entry) return;
    pending.delete(event.data.requestId);
    entry.resolve(event.data);
  }
  function onError() {
    teardown(new ConvertSessionError());
  }
  function onAbort() {
    teardown(new ConvertSessionCancelledError());
  }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  signal?.addEventListener("abort", onAbort);

  function call<K extends ConvertWorkerRequest["kind"]>(
    build: (requestId: number) => Extract<ConvertWorkerRequest, { kind: K }>,
    transfer?: Transferable[],
  ): Promise<Extract<ConvertWorkerResponse, { kind: K }>> {
    if (closed) return Promise.reject(new ConvertSessionCancelledError());
    requestCounter += 1;
    const requestId = requestCounter;
    const request = build(requestId);
    return new Promise((resolve, reject) => {
      pending.set(requestId, {
        resolve: resolve as (response: ConvertWorkerResponse) => void,
        reject,
      });
      worker.postMessage(request, transfer ?? []);
    });
  }

  let loadResponse: Extract<ConvertWorkerResponse, { kind: "load" }>;
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
    teardown(error instanceof Error ? error : new ConvertSessionError());
    throw error;
  }
  if (!loadResponse.ok) {
    teardown(new ConvertSessionCancelledError("Session closed."));
    throw new Error(loadResponse.message);
  }

  return {
    load: loadResponse.outcome,
    async simplify(options) {
      const response = await call<"simplify">((requestId) => ({
        kind: "simplify",
        requestId,
        options,
      }));
      if (!response.ok) throw new Error(response.message);
      return response.outcome;
    },
    async export(source: "original" | "simplified", options) {
      const response = await call<"export">((requestId) => ({
        kind: "export",
        requestId,
        source,
        options,
      }));
      if (!response.ok) throw new Error(response.message);
      return response.outcome;
    },
    close() {
      teardown(new ConvertSessionCancelledError("Session closed."));
    },
  };
}
