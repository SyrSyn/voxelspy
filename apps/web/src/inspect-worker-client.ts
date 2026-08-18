import type { InspectionResult, MeshHealthDiagnosis } from "@voxelspy/analysis";
import type {
  ContractWarning,
  GeometryProvenance,
  NormalizedModel,
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
 * potentially long-running two-model analysis. Both `inspectModel` and
 * `diagnoseMeshHealth` are single bounded passes over one model's
 * already-imported geometry (see `packages/analysis/src/inspect.ts` and
 * `diagnose.ts`), so one request/response round trip per call is enough --
 * mirroring `summary-worker-client.ts`'s simpler protocol, not
 * `worker-client.ts`'s stateful one.
 *
 * `kind` distinguishes the cheap always-on report (`"inspect"`) from the
 * heavier opt-in mesh-health evidence (`"diagnose"`) and from the file
 * Forensics report (`"forensics"`, added for `/tools/file-forensics/`); all
 * three re-run the same local import from the same source bytes, since a
 * fresh dedicated worker is spun up and torn down per call (see
 * `runInspectWorker` below) rather than keeping an imported model alive
 * across requests -- the file is small (bounded by the shared 32 MiB /
 * 500,000-triangle importer ceiling every call applies), so re-importing
 * costs far less than the complexity of a stateful worker just to avoid it.
 * `"forensics"` asks the same importer the same question `"inspect"` does --
 * it never runs a second, different importer or validator -- and reports the
 * normalized model's own provenance, warnings, and mesh/instance structure
 * instead of `inspectModel`'s geometric measurements.
 */
export interface InspectWorkerRequestBase {
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

export type InspectWorkerRequest =
  | (InspectWorkerRequestBase & { readonly kind: "inspect" })
  | (InspectWorkerRequestBase & { readonly kind: "diagnose" })
  | (InspectWorkerRequestBase & { readonly kind: "forensics" });

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

/**
 * What one successful `"diagnose"` call hands back: the bounded
 * `MeshHealthDiagnosis` evidence plus the imported `NormalizedModel` itself.
 * Unlike `InspectionOutcome`, this *does* carry the model's typed-array
 * geometry back to the main thread -- deliberately, and only for this
 * opt-in, user-initiated call: `MeshHealthViewer` needs the model's own mesh
 * geometry to draw alongside the diagnostic overlay, the same way
 * `ComparisonFlow` already hands `Workbench` full baseline/candidate
 * `NormalizedModel`s for rendering. The model is bounded by the same
 * importer ceiling as every other call in this file, and it is held only in
 * the diagnostic viewer's own state for as long as that panel stays open.
 */
export interface MeshHealthDiagnosisOutcome {
  readonly model: NormalizedModel;
  readonly diagnosis: MeshHealthDiagnosis;
}

/** One imported mesh's placed structure, for the file Forensics report --
 *  counts derived from the mesh's own typed-array buffers inside the worker,
 *  never the buffers themselves. */
export interface ForensicsMeshSummary {
  readonly meshId: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

/**
 * One placed instance of a mesh, for the file Forensics report. `transform`
 * is the exact 16-value column-major affine matrix the model placement
 * schema stores (`meshToModel` for today's `"flat"` placement, or
 * `meshToNode` for a future `"hierarchy"` placement -- see
 * `modelPlacementSchema` in `@voxelspy/contracts`); `transformKind` records
 * which one it is so the report never mislabels the matrix it shows.
 */
export interface ForensicsInstanceSummary {
  readonly instanceId: string;
  readonly meshId: string;
  readonly transformKind: "meshToModel" | "meshToNode";
  readonly transform: readonly number[];
}

/**
 * What one successful `"forensics"` call hands back: the imported model's
 * own `provenance` and `warnings` verbatim (nothing paraphrased or
 * recomputed), plus a placement-structure summary built from the model's
 * mesh/instance records. Deliberately excludes the model's geometry buffers
 * (`positions`/`indices`) -- Forensics reports structure and provenance, not
 * measurements, and never needs them on the main thread.
 */
export interface ForensicsOutcome {
  readonly provenance: GeometryProvenance;
  readonly warnings: readonly ContractWarning[];
  readonly placementKind: "flat" | "hierarchy";
  readonly meshes: readonly ForensicsMeshSummary[];
  readonly instances: readonly ForensicsInstanceSummary[];
}

export type InspectWorkerResponse =
  | {
      readonly requestId: number;
      readonly kind: "inspect";
      readonly ok: true;
      readonly outcome: InspectionOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "inspect";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "diagnose";
      readonly ok: true;
      readonly outcome: MeshHealthDiagnosisOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "diagnose";
      readonly ok: false;
      readonly message: string;
    }
  | {
      readonly requestId: number;
      readonly kind: "forensics";
      readonly ok: true;
      readonly outcome: ForensicsOutcome;
    }
  | {
      readonly requestId: number;
      readonly kind: "forensics";
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
 * Runs one request/response round trip against a fresh dedicated inspection
 * worker: imports the source file and either inspects or diagnoses it,
 * entirely off the main thread. A fresh worker is spun up per call and torn
 * down once a result, failure, or abort settles the returned promise -- the
 * same lifecycle `summarizeModelComparisonAsync` uses, chosen for the same
 * reason: each call is a single bounded computation, not a session that
 * benefits from a persisted worker across multiple requests.
 *
 * The file's bytes are read once here and then transferred (not cloned) to
 * the worker: `File.arrayBuffer()` can be called again on a later,
 * independent call (e.g. `diagnoseModelAsync` after `inspectSourceAsync` for
 * the same source), since it does not consume the `File` itself -- only the
 * one `ArrayBuffer` produced for *this* call is transferred away.
 *
 * No network transmission is involved; the worker runs entirely in this
 * browser, and only the serializable response -- never a geometry buffer for
 * `"inspect"`, and only the one already-bounded model for `"diagnose"` --
 * travels back to the caller.
 */
async function runInspectWorker<K extends InspectWorkerRequest["kind"]>(
  source: InspectSource,
  kind: K,
  signal?: AbortSignal,
): Promise<Extract<InspectWorkerResponse, { kind: K }>> {
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
      name: `voxelspy-inspect-${kind}`,
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
      if (data.requestId !== requestId || data.kind !== kind) return;
      finish(() =>
        resolve(data as Extract<InspectWorkerResponse, { kind: K }>),
      );
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
      kind,
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

/** Imports one local model file and inspects it, entirely off the main
 * thread. See `runInspectWorker`'s doc comment for the shared worker
 * lifecycle. */
export async function inspectSourceAsync(
  source: InspectSource,
  signal?: AbortSignal,
): Promise<InspectionOutcome> {
  const response = await runInspectWorker(source, "inspect", signal);
  if (!response.ok) throw new Error(response.message);
  return response.outcome;
}

/**
 * Imports the same local model file again and runs the heavier, opt-in
 * `diagnoseMeshHealth` pass, entirely off the main thread. Deliberately not
 * run automatically alongside `inspectSourceAsync`: a caller invokes this
 * only when a user actually opens a diagnostic, matching
 * `diagnoseMeshHealth`'s own "opt-in heavier sibling of `inspectModel`"
 * design. See `runInspectWorker`'s doc comment for the shared worker
 * lifecycle and why re-importing here (rather than keeping the first
 * inspection's worker and model alive) is the simpler, still-cheap choice.
 */
export async function diagnoseModelAsync(
  source: InspectSource,
  signal?: AbortSignal,
): Promise<MeshHealthDiagnosisOutcome> {
  const response = await runInspectWorker(source, "diagnose", signal);
  if (!response.ok) throw new Error(response.message);
  return response.outcome;
}

/**
 * Imports one local model file and reports its file Forensics outcome
 * (provenance, warnings, and mesh/instance structure), entirely off the main
 * thread. Used by `/tools/file-forensics/`, distinct from
 * `inspectSourceAsync`'s geometric measurements. See `runInspectWorker`'s doc
 * comment for the shared worker lifecycle.
 */
export async function forensicsSourceAsync(
  source: InspectSource,
  signal?: AbortSignal,
): Promise<ForensicsOutcome> {
  const response = await runInspectWorker(source, "forensics", signal);
  if (!response.ok) throw new Error(response.message);
  return response.outcome;
}
