import {
  DEFAULT_SNAP_TOLERANCE_MILLIMETRES,
  MAX_SNAP_TOLERANCE_MILLIMETRES,
  type BoundingExtentResult,
  type PointToPointResult,
  type SectionResult,
  type SnapClassification,
  type SnapPointInput,
} from "@voxelspy/analysis";
import type {
  ContractWarning,
  SourceAxis,
  SourceUnit,
  Vec3,
} from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  MeasurementSessionCancelledError,
  openMeasureSession,
  type MeasureSession,
  type MeasureSource,
} from "./measure-worker-client";
import type {
  MeasureLineSegment,
  MeasureMarker,
  PickedRay,
  SectionLoopVisual,
} from "./MeasureSectionViewer";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

/**
 * `/tools/measure-section/`: click-to-measure and cross-section for one
 * loaded model. Runs `measureOnModel`/`sectionModel` (`@voxelspy/analysis`)
 * in a dedicated persistent worker session (`measure-worker-client.ts` --
 * see its module doc comment for why this is a third, session-shaped worker
 * pattern rather than either of `inspect.worker.ts`'s or
 * `clearance.worker.ts`'s existing shapes).
 *
 * **Two independent ways to place a point, always producing the same kind of
 * result:** click the 3D surface (casts an exact ray via `snap-point`), or
 * type X/Y/Z coordinates and snap them to the nearest surface point (also
 * `snap-point`, `at: {kind:"point"}`). A third way -- picking a point a
 * section already computed -- needs no further query at all, since a
 * section loop's points are already exact plane/surface intersections. All
 * three land in the same measurement-point list, so every capability here
 * (collecting two points, seeing what each snapped to, reading the resulting
 * distance) is reachable without a pointer and without WebGL: the lists
 * rendered alongside the 3D preview are that preview's accessible
 * equivalent, not a summary of it.
 */

const MeasureSectionViewer = lazy(async () => {
  const module = await import("./MeasureSectionViewer");
  return { default: module.MeasureSectionViewer };
});

type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

const units: { value: ResolvedSourceUnit; label: string }[] = [
  { value: "millimetre", label: "Millimetres" },
  { value: "centimetre", label: "Centimetres" },
  { value: "metre", label: "Metres" },
  { value: "micrometre", label: "Micrometres" },
  { value: "inch", label: "Inches" },
  { value: "foot", label: "Feet" },
];
const axes: { value: ResolvedSourceAxis; label: string }[] = [
  { value: "right-handed-z-up", label: "Right-handed, Z up" },
  { value: "right-handed-y-up", label: "Right-handed, Y up" },
];

interface ModelSourceSelection {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
}

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<
  ModelSourceSelection,
  "unit" | "axis" | "frameSource"
>;

/** Same shape and preconditions as `InspectFlow`'s/`ClearanceFlow`'s own
 *  single-file source selection -- deliberately duplicated rather than
 *  imported, matching the precedent those two already set for this small,
 *  pure logic (see `ClearanceFlow.tsx`'s own comment on this). */
export function modelSourceSelectionForFile(
  file: File | null,
): ModelSourceSelection {
  return { file, ...defaultSourceFrame };
}

export function modelSourceCapability(selection: ModelSourceSelection) {
  if (!selection.file)
    return { ready: false, message: "Choose a local STL or OBJ file." };
  if (!/\.(?:stl|obj)$/iu.test(selection.file.name))
    return {
      ready: false,
      message: "This release supports STL and OBJ mesh files.",
    };
  if (selection.file.size === 0)
    return { ready: false, message: "The selected file is empty." };
  if (selection.file.size > 32 * 1024 * 1024)
    return {
      ready: false,
      message: "The selected file exceeds the 32 MiB importer safety ceiling.",
    };
  if (!selection.unit || !selection.axis)
    return {
      ready: false,
      message:
        "Choose the source unit and up-axis; this format does not declare them authoritatively.",
    };
  return {
    ready: true,
    message:
      selection.frameSource === "default"
        ? "Ready for local measurement using millimetres and right-handed Z-up."
        : "Ready for local measurement using the selected expert source frame.",
  };
}

/** The three axis normals plus a caller-supplied custom one -- see
 *  `resolvePlane`'s doc comment for how a choice becomes an actual plane. */
export type NormalChoice = "x" | "y" | "z" | "custom";

export function axisUnitVector(choice: "x" | "y" | "z"): Vec3 {
  if (choice === "x") return [1, 0, 0];
  if (choice === "y") return [0, 1, 0];
  return [0, 0, 1];
}

/**
 * Builds a `sectionModel` plane from the section controls: a chosen axis (or
 * a custom normal) plus a signed offset in millimetres, measured along that
 * normal's own unit direction from the model's origin -- so `offset` reads
 * plainly as "how far along the normal", independent of the normal's own
 * (possibly non-unit) input magnitude. Returns `undefined` for any input
 * that cannot become a real plane (a degenerate zero-length custom normal, a
 * non-finite offset, or a non-finite custom normal component) rather than
 * throwing -- the caller uses this to disable the "Run section" action
 * instead of surfacing a thrown error for an incomplete form.
 */
export function resolvePlane(
  normalChoice: NormalChoice,
  customNormal: Vec3,
  offsetMillimetres: number,
): { point: Vec3; normal: Vec3 } | undefined {
  const normal =
    normalChoice === "custom" ? customNormal : axisUnitVector(normalChoice);
  if (!normal.every((value) => Number.isFinite(value))) return undefined;
  if (!Number.isFinite(offsetMillimetres)) return undefined;
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(length > 0)) return undefined;
  const unit: Vec3 = [
    normal[0] / length,
    normal[1] / length,
    normal[2] / length,
  ];
  // `|| 0` normalizes a `-0` product (e.g. a zero normal component times a
  // negative offset) to plain `0` -- mirrors `sectionModel`'s own
  // `normalizeZero` treatment of its plane point, purely cosmetic (`-0` and
  // `0` are numerically identical) but avoids a confusing "-0 mm" in copy.
  const point: Vec3 = [
    unit[0] * offsetMillimetres || 0,
    unit[1] * offsetMillimetres || 0,
    unit[2] * offsetMillimetres || 0,
  ];
  return { point, normal };
}

// ---------------------------------------------------------------------------
// Presentation helpers. Deliberately duplicated from (rather than imported
// out of) InspectFlow.tsx/ClearanceFlow.tsx, matching the precedent those two
// already set for this small, pure formatting logic.
// ---------------------------------------------------------------------------

function conciseNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function pointLabel(point: Vec3): string {
  return `(${point.map(conciseNumber).join(", ")}) mm`;
}

function snapKindLabel(kind: MeasureMarker["snapKind"]): string {
  if (kind === "vertex") return "Vertex";
  if (kind === "edge") return "Edge";
  if (kind === "loop-point") return "Section loop point";
  return "Face interior";
}

function snapClassificationLabel(snap: SnapClassification): string {
  if (snap.kind === "vertex")
    return `Snapped to a vertex at ${pointLabel(snap.positionMillimetres)}.`;
  if (snap.kind === "edge")
    return `Snapped to an edge between ${pointLabel(
      snap.endpointsMillimetres[0],
    )} and ${pointLabel(snap.endpointsMillimetres[1])}.`;
  return "Landed on a face interior -- not within tolerance of any vertex or edge.";
}

// ---------------------------------------------------------------------------
// Model source card
// ---------------------------------------------------------------------------

function ModelSourceCard({
  selection,
  update,
}: {
  selection: ModelSourceSelection;
  update: (selection: ModelSourceSelection) => void;
}) {
  const capability = modelSourceCapability(selection);
  return (
    <fieldset className="source-card">
      <legend>Model</legend>
      <label className="source-file" htmlFor="model-file">
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL or OBJ, up to 32 MiB"}
        </small>
        <input
          id="model-file"
          type="file"
          accept=".stl,.obj"
          onChange={(event) =>
            update(
              modelSourceSelectionForFile(
                event.currentTarget.files?.[0] ?? null,
              ),
            )
          }
        />
        <span className="button button-secondary" aria-hidden="true">
          Browse this device
        </span>
      </label>
      <details>
        <summary>Expert settings</summary>
        <p>
          Change these only when the source uses a different unit or up-axis.
          The selected values are recorded with the loaded model.
        </p>
        <div className="source-frame">
          <label>
            Source unit
            <select
              value={selection.unit}
              onChange={(event) =>
                update({
                  ...selection,
                  unit: event.currentTarget
                    .value as ModelSourceSelection["unit"],
                  frameSource: "expert",
                })
              }
            >
              {units.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source up-axis
            <select
              value={selection.axis}
              onChange={(event) =>
                update({
                  ...selection,
                  axis: event.currentTarget
                    .value as ModelSourceSelection["axis"],
                  frameSource: "expert",
                })
              }
            >
              {axes.map((axis) => (
                <option key={axis.value} value={axis.value}>
                  {axis.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      <p
        className={
          capability.ready ? "capability capability-ready" : "capability"
        }
      >
        <i />
        {capability.message}
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Measurement point state
// ---------------------------------------------------------------------------

interface MeasurePointState {
  readonly id: string;
  readonly positionMillimetres: Vec3;
  readonly snapKind: MeasureMarker["snapKind"];
  readonly source: "click" | "typed" | "loop-point";
  readonly detail: string;
}

interface KeptMeasurement {
  readonly id: string;
  readonly first: MeasurePointState;
  readonly second: MeasurePointState;
  readonly result: PointToPointResult;
}

type PendingMeasurementState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: PointToPointResult }
  | { status: "error"; message: string };

type SectionRunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: SectionResult }
  | { status: "error"; message: string };

type BoundsState =
  | { status: "loading" }
  | { status: "ready"; result: BoundingExtentResult }
  | { status: "error"; message: string };

function sourceLabel(source: MeasurePointState["source"]): string {
  if (source === "click") return "3D click";
  if (source === "typed") return "Typed coordinates";
  return "Section loop point";
}

function MeasurementPointsPanel({
  activePoints,
  snapBusy,
  snapError,
  pointNotice,
  pending,
  onKeep,
  onClear,
}: {
  activePoints: readonly MeasurePointState[];
  snapBusy: boolean;
  snapError: string | undefined;
  pointNotice: string | undefined;
  pending: PendingMeasurementState;
  onKeep: () => void;
  onClear: () => void;
}) {
  return (
    <section aria-labelledby="measure-active-points-title">
      <h4 id="measure-active-points-title">Current measurement</h4>
      {activePoints.length === 0 ? (
        <p>
          No points selected yet. Click the model above, or add a point below,
          to start a measurement.
        </p>
      ) : (
        <ol className="diagnostic-list">
          {activePoints.map((point, index) => (
            <li key={point.id}>
              <div className="topology-item">
                <div className="topology-item-head">
                  <i aria-hidden="true" />
                  <strong>
                    Point {index + 1} · {snapKindLabel(point.snapKind)}
                  </strong>
                  <span>{sourceLabel(point.source)}</span>
                </div>
                <p>{pointLabel(point.positionMillimetres)}</p>
                <p>{point.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {snapBusy && (
        <p role="status" aria-live="polite">
          Snapping to the surface…
        </p>
      )}
      {snapError && (
        <div className="comparison-error" role="alert">
          <strong>That point could not be placed</strong>
          <p>{snapError}</p>
        </div>
      )}
      {pointNotice && (
        <p role="status" aria-live="polite">
          {pointNotice}
        </p>
      )}
      {pending.status === "loading" && (
        <p role="status" aria-live="polite">
          Computing distance…
        </p>
      )}
      {pending.status === "ready" && (
        <div
          className="geometry-summary"
          aria-labelledby="measure-pending-title"
        >
          <h5 id="measure-pending-title">Distance</h5>
          <div className="geometry-table geometry-table-2col" role="table">
            <div className="geometry-table-head" role="row">
              <span role="columnheader">Measure</span>
              <span role="columnheader">Value</span>
            </div>
            <div role="row">
              <strong role="rowheader">Distance</strong>
              <span>
                {conciseNumber(pending.result.distanceMillimetres)} mm
              </span>
            </div>
            <div role="row">
              <strong role="rowheader">Δ (second − first)</strong>
              <span>
                {pending.result.deltaMillimetres.map(conciseNumber).join(", ")}{" "}
                mm
              </span>
            </div>
          </div>
        </div>
      )}
      {pending.status === "error" && (
        <div className="comparison-error" role="alert">
          <strong>Distance could not be computed</strong>
          <p>{pending.message}</p>
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={pending.status !== "ready"}
          onClick={onKeep}
        >
          Keep measurement
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={activePoints.length === 0}
          onClick={onClear}
        >
          Clear points
        </button>
      </div>
    </section>
  );
}

function KeptMeasurementsList({
  measurements,
  onRemove,
}: {
  measurements: readonly KeptMeasurement[];
  onRemove: (id: string) => void;
}) {
  return (
    <section aria-labelledby="measure-kept-title">
      <h4 id="measure-kept-title">
        Measurements taken ({measurements.length})
      </h4>
      {measurements.length === 0 ? (
        <p className="empty-findings">No measurements kept yet.</p>
      ) : (
        <ol className="diagnostic-list">
          {measurements.map((measurement, index) => (
            <li key={measurement.id}>
              <div className="topology-item">
                <div className="topology-item-head">
                  <i aria-hidden="true" />
                  <strong>Measurement {index + 1}</strong>
                  <span>
                    {conciseNumber(measurement.result.distanceMillimetres)} mm
                  </span>
                </div>
                <p>
                  {pointLabel(measurement.first.positionMillimetres)} →{" "}
                  {pointLabel(measurement.second.positionMillimetres)}
                </p>
                <p>
                  Δ:{" "}
                  {measurement.result.deltaMillimetres
                    .map(conciseNumber)
                    .join(", ")}{" "}
                  mm
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => onRemove(measurement.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section panel
// ---------------------------------------------------------------------------

function SectionControls({
  normalChoice,
  setNormalChoice,
  customNormal,
  setCustomNormal,
  offset,
  setOffset,
  onRun,
  running,
  ready,
}: {
  normalChoice: NormalChoice;
  setNormalChoice: (value: NormalChoice) => void;
  customNormal: Vec3;
  setCustomNormal: (value: Vec3) => void;
  offset: number;
  setOffset: (value: number) => void;
  onRun: () => void;
  running: boolean;
  ready: boolean;
}) {
  const choices: { value: NormalChoice; label: string }[] = [
    { value: "x", label: "X axis" },
    { value: "y", label: "Y axis" },
    { value: "z", label: "Z axis" },
    { value: "custom", label: "Custom normal" },
  ];
  return (
    <fieldset className="method-card">
      <legend>Section plane</legend>
      <div
        className="section-normal-choices"
        role="radiogroup"
        aria-label="Plane normal"
      >
        {choices.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name="measure-section-normal"
              value={choice.value}
              checked={normalChoice === choice.value}
              onChange={() => setNormalChoice(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </div>
      {normalChoice === "custom" && (
        <div className="placement-grid">
          <fieldset>
            <legend>Custom normal (need not be unit length)</legend>
            {(["x", "y", "z"] as const).map((axisName, index) => (
              <label key={axisName} htmlFor={`custom-normal-${axisName}`}>
                {axisName.toUpperCase()}
                <input
                  id={`custom-normal-${axisName}`}
                  type="number"
                  step="any"
                  value={
                    Number.isFinite(customNormal[index])
                      ? customNormal[index]
                      : ""
                  }
                  onChange={(event) => {
                    const next: Vec3 = [...customNormal];
                    next[index] = event.currentTarget.valueAsNumber;
                    setCustomNormal(next);
                  }}
                />
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <label className="clearance-desired-input" htmlFor="plane-offset">
        Offset along the normal (mm)
        <input
          id="plane-offset"
          type="number"
          step="any"
          value={Number.isFinite(offset) ? offset : ""}
          onChange={(event) => setOffset(event.currentTarget.valueAsNumber)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!ready || running}
          onClick={onRun}
        >
          {running ? "Sectioning locally…" : "Run section"}
        </button>
      </div>
    </fieldset>
  );
}

function SectionLoopsPanel({
  result,
  onAddLoopPoint,
  disableAdd,
}: {
  result: SectionResult;
  onAddLoopPoint: (point: Vec3) => void;
  disableAdd: boolean;
}) {
  const { loops } = result;
  const MAX_LOOP_POINT_BUTTONS = 20;
  return (
    <section aria-labelledby="section-loops-title">
      <h4 id="section-loops-title">Section loops ({loops.loopCount})</h4>
      <p>
        Plane point {pointLabel(result.plane.pointMillimetres)}, unit normal{" "}
        {pointLabel(result.plane.unitNormal)}.
      </p>
      {result.coincidentTriangleCount > 0 && (
        <div className="clearance-caveat" role="note">
          <strong>
            {result.coincidentTriangleCount} triangle
            {result.coincidentTriangleCount === 1 ? "" : "s"} lie exactly in
            this plane
          </strong>
          <p>
            Those triangles contribute no segment of their own; their own
            boundary is often still recovered from neighbouring triangles, but
            not guaranteed. Do not trust the loops below alone when this is
            nonzero.
          </p>
          {result.warnings.length > 0 && (
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {loops.loops.length === 0 ? (
        <p className="empty-findings">
          {loops.loopCount === 0
            ? "The plane does not cross the model's surface: no section loops."
            : "No loops fit within the returned point budget."}
        </p>
      ) : (
        <ol className="diagnostic-list">
          {loops.loops.map((loop, index) => (
            <li key={index}>
              <div className="topology-item">
                <div className="topology-item-head">
                  <i aria-hidden="true" />
                  <strong>Loop {index + 1}</strong>
                  <span>
                    {loop.edgeCount} edge{loop.edgeCount === 1 ? "" : "s"} ·{" "}
                    {loop.closed ? "Closed loop" : "Terminated chain"} ·
                    perimeter {conciseNumber(loop.perimeterMillimetres)} mm
                  </span>
                </div>
                <p>
                  Area:{" "}
                  {loop.area.available
                    ? `${conciseNumber(loop.area.absoluteSquareMillimetres)} mm²`
                    : "Not available (loop is not closed)."}
                </p>
                {loop.pointsTruncated && (
                  <em className="topology-truncated">
                    Point list truncated for display; edge count, perimeter, and
                    area above are exact.
                  </em>
                )}
                <details>
                  <summary>
                    {Math.min(
                      loop.pointsMillimetres.length,
                      MAX_LOOP_POINT_BUTTONS,
                    )}{" "}
                    of {loop.pointsMillimetres.length} loop point
                    {loop.pointsMillimetres.length === 1 ? "" : "s"} (add to a
                    measurement)
                  </summary>
                  <ol className="diagnostic-list">
                    {loop.pointsMillimetres
                      .slice(0, MAX_LOOP_POINT_BUTTONS)
                      .map((point, pointIndex) => (
                        <li key={pointIndex}>
                          <button
                            type="button"
                            disabled={disableAdd}
                            onClick={() => onAddLoopPoint(point)}
                          >
                            <span>{pointLabel(point)}</span>
                            <small>Add to measurement</small>
                          </button>
                        </li>
                      ))}
                  </ol>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}
      {loops.loopsTruncated && (
        <p className="topology-truncated">
          Showing {loops.loops.length} of {loops.loopCount} loops.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const INITIAL_CAPABILITY: CapabilityPreflight = {
  recommendedAnalysisMemoryMiB: DEFAULT_ANALYSIS_MEMORY_MIB,
  memoryNotes: [],
  workersAvailable: true,
  webglAvailable: true,
  analysisSupported: true,
  blockingMessage: undefined,
};

export function MeasureSectionFlow() {
  const [selection, setSelection] = useState(modelSourceSelectionForFile(null));
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [session, setSession] = useState<MeasureSession>();
  const [sourceMeta, setSourceMeta] = useState<{
    name: string;
    size: number;
  }>();
  const [warnings, setWarnings] = useState<readonly ContractWarning[]>([]);
  const [bounds, setBounds] = useState<BoundsState>();
  const [capability, setCapability] =
    useState<CapabilityPreflight>(INITIAL_CAPABILITY);
  useEffect(() => {
    setCapability(evaluateCapabilityPreflight(readEnvironmentReadings()));
  }, []);

  const activeRunRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<MeasureSession | undefined>(undefined);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    return () => {
      activeRunRef.current?.abort();
      sessionRef.current?.close();
    };
  }, []);

  const [snapTolerance, setSnapTolerance] = useState(
    DEFAULT_SNAP_TOLERANCE_MILLIMETRES,
  );
  const [manualPoint, setManualPoint] = useState<Vec3>([0, 0, 0]);
  const [activePoints, setActivePoints] = useState<MeasurePointState[]>([]);
  const [measurements, setMeasurements] = useState<KeptMeasurement[]>([]);
  const [pending, setPending] = useState<PendingMeasurementState>({
    status: "idle",
  });
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapError, setSnapError] = useState<string>();
  const [pointNotice, setPointNotice] = useState<string>();
  const nextPointId = useRef(0);
  const nextMeasurementId = useRef(0);

  const [normalChoice, setNormalChoice] = useState<NormalChoice>("z");
  const [customNormal, setCustomNormal] = useState<Vec3>([0, 0, 1]);
  const [offset, setOffset] = useState(0);
  const [sectionState, setSectionState] = useState<SectionRunState>({
    status: "idle",
  });

  const capabilityCheck = modelSourceCapability(selection);
  const ready =
    capabilityCheck.ready &&
    !progress &&
    !session &&
    capability.analysisSupported;

  const load = async () => {
    if (!ready || !selection.file || !selection.unit || !selection.axis) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setProgress("Reading and preparing the model locally");
    try {
      const newSession = await openMeasureSession(
        selection as MeasureSource,
        controller.signal,
      );
      setSession(newSession);
      setSourceMeta({ name: selection.file.name, size: selection.file.size });
      setWarnings(newSession.warnings);
      setActivePoints([]);
      setMeasurements([]);
      setPending({ status: "idle" });
      setSnapError(undefined);
      setPointNotice(undefined);
      setSectionState({ status: "idle" });
      setBounds({ status: "loading" });
      newSession
        .measure({ kind: "bounding-extent" })
        .then((result) => {
          if (result.kind === "bounding-extent")
            setBounds({ status: "ready", result });
        })
        .catch((reason: unknown) =>
          setBounds({
            status: "error",
            message:
              reason instanceof Error
                ? reason.message
                : "Could not compute dimensions.",
          }),
        );
    } catch (reason) {
      if (reason instanceof MeasurementSessionCancelledError) {
        setNotice("Load cancelled.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Model load failed safely.",
        );
      }
    } finally {
      setProgress(undefined);
      if (activeRunRef.current === controller) activeRunRef.current = null;
    }
  };

  const cancel = () => activeRunRef.current?.abort();

  const reset = () => {
    sessionRef.current?.close();
    setSession(undefined);
    setSourceMeta(undefined);
    setWarnings([]);
    setBounds(undefined);
    setError(undefined);
    setNotice(undefined);
    setSelection(modelSourceSelectionForFile(null));
    setActivePoints([]);
    setMeasurements([]);
    setPending({ status: "idle" });
    setSnapError(undefined);
    setPointNotice(undefined);
    setSectionState({ status: "idle" });
  };

  const addPoint = (point: MeasurePointState) => {
    setPointNotice(undefined);
    setActivePoints((current) =>
      current.length >= 2 ? current : [...current, point],
    );
  };

  const runSnap = async (at: SnapPointInput, source: "click" | "typed") => {
    if (!session) return;
    if (activePoints.length >= 2) {
      setPointNotice(
        "Two points are already selected. Keep or clear this measurement before adding another.",
      );
      return;
    }
    setSnapBusy(true);
    setSnapError(undefined);
    try {
      const result = await session.measure(
        { kind: "snap-point", at },
        Number.isFinite(snapTolerance) && snapTolerance >= 0
          ? { snapToleranceMillimetres: snapTolerance }
          : undefined,
      );
      if (result.kind !== "snap-point") return;
      if (!result.outcome.hit) {
        setSnapError(
          at.kind === "ray"
            ? "That click did not land on the model's surface."
            : "No triangles are available to snap against.",
        );
        return;
      }
      nextPointId.current += 1;
      addPoint({
        id: `p-${nextPointId.current}`,
        positionMillimetres: result.outcome.pointMillimetres,
        snapKind: result.outcome.snap.kind,
        source,
        detail: snapClassificationLabel(result.outcome.snap),
      });
    } catch (reason) {
      setSnapError(
        reason instanceof Error ? reason.message : "Snap query failed.",
      );
    } finally {
      setSnapBusy(false);
    }
  };

  const addLoopPoint = (point: Vec3) => {
    if (activePoints.length >= 2) {
      setPointNotice(
        "Two points are already selected. Keep or clear this measurement before adding another.",
      );
      return;
    }
    nextPointId.current += 1;
    addPoint({
      id: `p-${nextPointId.current}`,
      positionMillimetres: point,
      snapKind: "loop-point",
      source: "loop-point",
      detail: "An exact point from the latest section's traced loop.",
    });
  };

  const clearPoints = () => {
    setActivePoints([]);
    setPointNotice(undefined);
    setPending({ status: "idle" });
  };

  const keepMeasurement = () => {
    if (activePoints.length !== 2 || pending.status !== "ready") return;
    nextMeasurementId.current += 1;
    setMeasurements((current) => [
      ...current,
      {
        id: `m-${nextMeasurementId.current}`,
        first: activePoints[0]!,
        second: activePoints[1]!,
        result: pending.result,
      },
    ]);
    setActivePoints([]);
    setPending({ status: "idle" });
  };

  const removeMeasurement = (id: string) => {
    setMeasurements((current) => current.filter((entry) => entry.id !== id));
  };

  // Recomputes the pending point-to-point distance whenever exactly two
  // points are active. `point-to-point` is pure arithmetic on the two
  // supplied points (see `measureOnModel`'s doc comment) so this is cheap,
  // but it still runs through the worker session like every other query
  // here rather than being computed on the main thread.
  useEffect(() => {
    if (!session || activePoints.length !== 2) {
      setPending({ status: "idle" });
      return;
    }
    let cancelled = false;
    setPending({ status: "loading" });
    session
      .measure({
        kind: "point-to-point",
        first: activePoints[0]!.positionMillimetres,
        second: activePoints[1]!.positionMillimetres,
      })
      .then((result) => {
        if (cancelled || result.kind !== "point-to-point") return;
        setPending({ status: "ready", result });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPending({
          status: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "Could not compute the distance.",
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activePoints]);

  const runSection = async () => {
    if (!session) return;
    const plane = resolvePlane(normalChoice, customNormal, offset);
    if (!plane) return;
    setSectionState({ status: "loading" });
    try {
      const result = await session.section(plane);
      setSectionState({ status: "ready", result });
    } catch (reason) {
      setSectionState({
        status: "error",
        message:
          reason instanceof Error ? reason.message : "Section failed safely.",
      });
    }
  };

  const planePreview = resolvePlane(normalChoice, customNormal, offset);

  const onPick = (ray: PickedRay) => {
    void runSnap(
      { kind: "ray", origin: ray.origin, direction: ray.direction },
      "click",
    );
  };

  const markers: MeasureMarker[] = [
    ...activePoints.map((point) => ({
      id: point.id,
      positionMillimetres: point.positionMillimetres,
      snapKind: point.snapKind,
      emphasis: "active" as const,
    })),
    ...measurements.flatMap((measurement) => [
      {
        id: measurement.first.id,
        positionMillimetres: measurement.first.positionMillimetres,
        snapKind: measurement.first.snapKind,
        emphasis: "kept" as const,
      },
      {
        id: measurement.second.id,
        positionMillimetres: measurement.second.positionMillimetres,
        snapKind: measurement.second.snapKind,
        emphasis: "kept" as const,
      },
    ]),
  ];

  const lines: MeasureLineSegment[] = [
    ...(activePoints.length === 2
      ? [
          {
            id: "active-line",
            aMillimetres: activePoints[0]!.positionMillimetres,
            bMillimetres: activePoints[1]!.positionMillimetres,
            emphasis: "active" as const,
          },
        ]
      : []),
    ...measurements.map((measurement) => ({
      id: measurement.id,
      aMillimetres: measurement.first.positionMillimetres,
      bMillimetres: measurement.second.positionMillimetres,
      emphasis: "kept" as const,
    })),
  ];

  const loopVisuals: SectionLoopVisual[] =
    sectionState.status === "ready"
      ? sectionState.result.loops.loops.map((loop, index) => ({
          id: `loop-${index}`,
          pointsMillimetres: loop.pointsMillimetres,
          closed: loop.closed,
          pointsTruncated: loop.pointsTruncated,
        }))
      : [];

  return (
    <ToolShell
      eyebrow="Measure & Section"
      title="How big is this, and what does it look like sliced open?"
      description="Load one local model, then click its surface (or type coordinates) to build point-to-point measurements, and cut a section plane to see cross-section loops with their perimeter and area."
    >
      {session && sourceMeta ? (
        <div className="inspect-report">
          <header className="inspect-report-header">
            <div>
              <h2>{sourceMeta.name}</h2>
              <p>
                {formatFileSize(sourceMeta.size)} · reported in millimetres,
                right-handed Z-up
              </p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={reset}
            >
              Load another model
            </button>
          </header>

          <p className="inspect-semantics-note">
            <strong>Exactness.</strong> Every snap, distance, and section result
            here is exact for this model's tessellated triangle mesh -- not
            sampled at some spacing that could hide a smaller feature, unlike
            Compare's or Clearance &amp; Fit's sampled distances. That is a
            claim about the mesh as given, not about any original curved or CAD
            geometry the mesh approximates: this release measures the triangles
            it imported, not a reconstruction of whatever produced them.
          </p>

          {warnings.length > 0 && (
            <div className="provenance-warnings">
              <strong>Import warnings</strong>
              <ul>
                {warnings.map((warning, index) => (
                  <li key={index}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}

          {bounds && (
            <section
              className="geometry-summary"
              aria-labelledby="measure-dimensions-title"
            >
              <h3 id="measure-dimensions-title">Model dimensions</h3>
              {bounds.status === "loading" && (
                <p role="status" aria-live="polite">
                  Computing dimensions…
                </p>
              )}
              {bounds.status === "error" && (
                <p>Dimensions unavailable: {bounds.message}</p>
              )}
              {bounds.status === "ready" &&
                (bounds.result.bounds.available ? (
                  <div
                    className="geometry-table geometry-table-2col"
                    role="table"
                  >
                    <div className="geometry-table-head" role="row">
                      <span role="columnheader">Measure</span>
                      <span role="columnheader">Value</span>
                    </div>
                    <div role="row">
                      <strong role="rowheader">Dimensions (mm)</strong>
                      <span>
                        {bounds.result.bounds.dimensionsMillimetres
                          .map(conciseNumber)
                          .join(" × ")}
                      </span>
                    </div>
                    <div role="row">
                      <strong role="rowheader">Bounds min</strong>
                      <span>{pointLabel(bounds.result.bounds.min)}</span>
                    </div>
                    <div role="row">
                      <strong role="rowheader">Bounds max</strong>
                      <span>{pointLabel(bounds.result.bounds.max)}</span>
                    </div>
                  </div>
                ) : (
                  <p>Dimensions unavailable: no position data.</p>
                ))}
            </section>
          )}

          <Suspense
            fallback={
              <div className="workbench-loading" role="status">
                Preparing the 3D measurement preview…
              </div>
            }
          >
            <MeasureSectionViewer
              model={session.model}
              markers={markers}
              lines={lines}
              loops={loopVisuals}
              onPick={onPick}
              accessibleLabel={`3D preview of ${sourceMeta.name}. Click its surface to place a measurement point. Not a substitute for the point-entry controls and lists below.`}
            />
          </Suspense>

          <section aria-labelledby="measure-section-title">
            <h3 id="measure-section-title">Measure</h3>
            <fieldset className="method-card">
              <legend>Add a point by typing coordinates</legend>
              <p>
                Click the model above, or enter a point here and snap it to the
                nearest surface point -- both produce the same kind of result
                and both count toward the same measurement.
              </p>
              <div className="placement-grid">
                <fieldset>
                  <legend>Point (mm)</legend>
                  {(["x", "y", "z"] as const).map((axisName, index) => (
                    <label key={axisName} htmlFor={`manual-${axisName}`}>
                      {axisName.toUpperCase()}
                      <input
                        id={`manual-${axisName}`}
                        type="number"
                        step="any"
                        value={
                          Number.isFinite(manualPoint[index])
                            ? manualPoint[index]
                            : ""
                        }
                        onChange={(event) => {
                          const next: Vec3 = [...manualPoint];
                          next[index] = event.currentTarget.valueAsNumber;
                          setManualPoint(next);
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Snap tolerance (mm)</legend>
                  <label htmlFor="snap-tolerance">
                    Tolerance
                    <input
                      id="snap-tolerance"
                      type="number"
                      step="any"
                      min="0"
                      max={MAX_SNAP_TOLERANCE_MILLIMETRES}
                      value={
                        Number.isFinite(snapTolerance) ? snapTolerance : ""
                      }
                      onChange={(event) =>
                        setSnapTolerance(event.currentTarget.valueAsNumber)
                      }
                    />
                  </label>
                </fieldset>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={
                    snapBusy ||
                    !manualPoint.every((value) => Number.isFinite(value))
                  }
                  onClick={() =>
                    void runSnap({ kind: "point", point: manualPoint }, "typed")
                  }
                >
                  Snap to nearest surface point
                </button>
              </div>
            </fieldset>

            <MeasurementPointsPanel
              activePoints={activePoints}
              snapBusy={snapBusy}
              snapError={snapError}
              pointNotice={pointNotice}
              pending={pending}
              onKeep={keepMeasurement}
              onClear={clearPoints}
            />

            <KeptMeasurementsList
              measurements={measurements}
              onRemove={removeMeasurement}
            />
          </section>

          <section aria-labelledby="section-plane-section-title">
            <h3 id="section-plane-section-title">Section</h3>
            <SectionControls
              normalChoice={normalChoice}
              setNormalChoice={setNormalChoice}
              customNormal={customNormal}
              setCustomNormal={setCustomNormal}
              offset={offset}
              setOffset={setOffset}
              onRun={() => void runSection()}
              running={sectionState.status === "loading"}
              ready={planePreview !== undefined}
            />
            {sectionState.status === "error" && (
              <div className="comparison-error" role="alert">
                <strong>Section could not be computed</strong>
                <p>{sectionState.message}</p>
              </div>
            )}
            {sectionState.status === "ready" && (
              <SectionLoopsPanel
                result={sectionState.result}
                onAddLoopPoint={addLoopPoint}
                disableAdd={activePoints.length >= 2}
              />
            )}
          </section>
        </div>
      ) : (
        <section
          className="comparison-card"
          aria-labelledby="measure-choose-title"
        >
          <div className="section-heading">
            <span className="step">Step 01</span>
            <h2 id="measure-choose-title">Choose a model</h2>
            <p>
              Select one supported file to measure and section immediately using
              common millimetre and right-handed Z-up defaults. If the source
              uses a different frame, adjust its Expert settings first.
            </p>
          </div>
          {!capability.analysisSupported && (
            <div className="comparison-error" role="alert">
              <strong>Local measurement is unavailable in this browser</strong>
              <p>{capability.blockingMessage}</p>
            </div>
          )}
          <div className="inspect-model-field">
            <ModelSourceCard selection={selection} update={setSelection} />
          </div>
          <div className="comparison-status" aria-live="polite">
            <span className={ready ? "status-ready" : ""}>
              {progress ??
                notice ??
                (ready
                  ? "Inputs pass capability preflight"
                  : !capability.analysisSupported
                    ? "Measurement disabled: see the browser support notice above"
                    : "Choose a source file")}
            </span>
            <div className="actions">
              {progress && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={cancel}
                >
                  Cancel
                </button>
              )}
              <button
                className="button button-primary"
                type="button"
                disabled={!ready}
                onClick={() => void load()}
              >
                {progress ? "Loading locally…" : "Load model"}
              </button>
            </div>
          </div>
          {error && (
            <div className="comparison-error" role="alert">
              <strong>Model could not be loaded</strong>
              <p>{error}</p>
            </div>
          )}
          <p className="boundary-note">
            <strong>Local boundary:</strong> the source file and its geometry
            stay inside this browser's dedicated measurement worker; only
            structured query results leave the worker, and nothing is uploaded.
          </p>
        </section>
      )}
    </ToolShell>
  );
}
