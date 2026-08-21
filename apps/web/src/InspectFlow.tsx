import type {
  MeshHealthDiagnosis,
  ModelPresentationSummary,
  TopologyFindingKind,
  WatertightnessReason,
  WatertightnessVerdict,
} from "@voxelspy/analysis";
import type { Vec3 } from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import { inspectFocusPages, type InspectFocusId } from "./content";
import {
  ACCEPTED_UPLOAD_ACCEPT,
  defaultFrameForFormat,
  formatDeclaresOwnFrame,
  formatFrameDeclarationSummary,
  hasAcceptedExtension,
  inferFormat,
  unsupportedFormatMessage,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "./formats";
import {
  diagnoseModelAsync,
  InspectionCancelledError,
  inspectSourceAsync,
  type InspectionOutcome,
  type InspectSource,
  type MeshHealthDiagnosisOutcome,
} from "./inspect-worker-client";
import type { MeshHealthSelection } from "./MeshHealthViewer";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

const MeshHealthViewer = lazy(async () => {
  const module = await import("./MeshHealthViewer");
  return { default: module.MeshHealthViewer };
});

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

type ModelSourceSelection = {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
};

export function modelSourceSelectionForFile(
  file: File | null,
): ModelSourceSelection {
  const format = file ? inferFormat(file.name) : undefined;
  return { file, ...defaultFrameForFormat(format), frameSource: "default" };
}

/**
 * Same shape as `ComparisonFlow`'s `sourceCapability`, adapted to inspect a
 * single file rather than a baseline/candidate pair: same supported-format,
 * size, and unit/axis preconditions (this release's single importer applies
 * uniformly to both tools), phrased for inspection rather than comparison.
 */
export function modelSourceCapability(selection: ModelSourceSelection) {
  if (!selection.file)
    return { ready: false, message: "Choose a local model file." };
  if (!hasAcceptedExtension(selection.file.name))
    return { ready: false, message: unsupportedFormatMessage() };
  if (selection.file.size === 0)
    return { ready: false, message: "The selected file is empty." };
  if (selection.file.size > 32 * 1024 * 1024)
    return {
      ready: false,
      message: "The selected file exceeds the 32 MiB importer safety ceiling.",
    };
  const declaresOwnFrame = formatDeclaresOwnFrame(
    inferFormat(selection.file.name),
  );
  if (!declaresOwnFrame && (!selection.unit || !selection.axis))
    return {
      ready: false,
      message:
        "Choose the source unit and up-axis; this format does not declare them authoritatively.",
    };
  if (declaresOwnFrame)
    return {
      ready: true,
      message:
        selection.unit || selection.axis
          ? "Ready for local inspection using the selected override source frame."
          : "Ready for local inspection using this file's own declared source frame.",
    };
  return {
    ready: true,
    message:
      selection.frameSource === "default"
        ? "Ready for local inspection using millimetres and right-handed Z-up."
        : "Ready for local inspection using the selected expert source frame.",
  };
}

function ModelSourceCard({
  selection,
  update,
  expertSettingsOpen = false,
}: {
  selection: ModelSourceSelection;
  update: (selection: ModelSourceSelection) => void;
  /** Opens the unit/axis "Expert settings" drawer by default, rather than
   *  requiring a click to reveal it. Used by the `/tools/scale/` focus page
   *  to make the reinterpretation control prominent, per the roadmap: the
   *  control itself is unchanged, only its default visibility is. */
  expertSettingsOpen?: boolean;
}) {
  const capability = modelSourceCapability(selection);
  const format = selection.file ? inferFormat(selection.file.name) : undefined;
  const declaresOwnFrame = formatDeclaresOwnFrame(format);
  return (
    <fieldset className="source-card">
      <legend>Model</legend>
      <label className="source-file" htmlFor="model-file">
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL, OBJ, glTF, GLB, or 3MF, up to 32 MiB"}
        </small>
        <input
          id="model-file"
          type="file"
          accept={ACCEPTED_UPLOAD_ACCEPT}
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
      <details open={expertSettingsOpen}>
        <summary>Expert settings</summary>
        <p>
          {declaresOwnFrame
            ? formatFrameDeclarationSummary(format)
            : "Change these only when the source uses a different unit or up-axis. The selected values are recorded with the inspection."}
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
              {declaresOwnFrame && (
                <option value="">Use the file&rsquo;s declared value</option>
              )}
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
              {declaresOwnFrame && (
                <option value="">Use the file&rsquo;s declared value</option>
              )}
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
// Presentation helpers. Deliberately duplicated from (rather than imported
// out of) Workbench.tsx and ComparisonFlow.tsx: those files' formatting
// helpers are private to a comparison-shaped UI this tool does not
// restructure, and the duplication here is small, pure, and easy to keep in
// sync by inspection.
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

function unitLabel(unit: string): string {
  const known = units.find((entry) => entry.value === unit)?.label;
  if (known) return known;
  return unit === "unknown" ? "not declared by the file" : unit;
}

function axisLabel(axis: string): string {
  const known = axes.find((entry) => entry.value === axis)?.label;
  if (known) return known;
  return axis === "unknown" ? "not declared by the file" : axis;
}

function originLabel(origin: "embedded" | "declared" | "user"): string {
  if (origin === "embedded") return "embedded in the file";
  if (origin === "declared") return "import default";
  return "expert override";
}

function volumeReasonLabel(reason: string): string {
  return (
    {
      "empty-geometry": "empty geometry",
      "degenerate-triangles": "degenerate triangles",
      "boundary-edges": "open boundary edges",
      "non-manifold-edges": "non-manifold edges",
      "inconsistent-orientation": "inconsistent orientation",
    }[reason] ?? reason.replaceAll("-", " ")
  );
}

function topologyKindLabel(kind: TopologyFindingKind): string {
  switch (kind) {
    case "boundary-edges":
      return "Boundary edges";
    case "non-manifold-edges":
      return "Non-manifold edges";
    case "inconsistent-orientation":
      return "Inconsistent orientation";
    case "degenerate-triangles":
      return "Degenerate triangles";
  }
}

function watertightReasonLabel(reason: WatertightnessReason): string {
  return reason === "boundary-edges"
    ? "open boundary edges"
    : "non-manifold edges";
}

function watertightPresentation(verdict: WatertightnessVerdict): {
  className: string;
  label: string;
  detail: string;
} {
  if (verdict.state === "closed") {
    return {
      className: "watertight-closed",
      label: "Closed",
      detail:
        "Every edge in the mesh is shared by exactly two triangle corners: no open boundary edge and no non-manifold edge was found.",
    };
  }
  if (verdict.state === "not-closed") {
    return {
      className: "watertight-not-closed",
      label: "Not closed",
      detail: `Reason${verdict.reasons.length === 1 ? "" : "s"}: ${verdict.reasons
        .map(watertightReasonLabel)
        .join(", ")}.`,
    };
  }
  return {
    className: "watertight-indeterminate",
    label: "Indeterminate",
    detail: "The model has no triangles to evaluate.",
  };
}

// ---------------------------------------------------------------------------
// Full diagnostic evidence (`diagnoseMeshHealth`): on-demand, heavier
// detail for the topology findings above. Textual rendering here is the
// accessible equivalent of `MeshHealthViewer`'s 3D overlay -- every list
// states counts, exact positions, and truncation, never color alone.
// ---------------------------------------------------------------------------

export type DiagnosisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; outcome: MeshHealthDiagnosisOutcome }
  | { status: "error"; message: string };

function pointLabel(point: Vec3): string {
  return `(${point.map(conciseNumber).join(", ")}) mm`;
}

/** A compact stand-in for a boundary loop's shape: where it starts and how
 * far its points spread on each axis, so a reader can place it relative to
 * the model without needing every point in the list. */
function loopLocationLabel(points: readonly Vec3[]): string {
  if (points.length === 0) return "No points available.";
  const min: [number, number, number] = [...points[0]!];
  const max: [number, number, number] = [...points[0]!];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  const span = min.map((value, axis) => max[axis]! - value);
  return `Starts near ${pointLabel(points[0]!)} · spans ${span
    .map(conciseNumber)
    .join(" × ")} mm`;
}

function BoundaryLoopList({
  boundaryLoops,
  selection,
  onSelect,
}: {
  boundaryLoops: MeshHealthDiagnosis["boundaryLoops"];
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
}) {
  return (
    <section aria-labelledby="diagnostic-boundary-loops-title">
      <h4 id="diagnostic-boundary-loops-title">
        Boundary loops ({boundaryLoops.loopCount})
      </h4>
      {boundaryLoops.loops.length === 0 ? (
        <p>No boundary loops found.</p>
      ) : (
        <ol className="diagnostic-list">
          {boundaryLoops.loops.map((loop, index) => {
            const isSelected =
              selection?.kind === "boundary-loop" && selection.index === index;
            return (
              <li key={index}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(
                      isSelected ? undefined : { kind: "boundary-loop", index },
                    )
                  }
                >
                  <strong>Loop {index + 1}</strong>
                  <span>
                    {loop.edgeCount} edge{loop.edgeCount === 1 ? "" : "s"} ·{" "}
                    {loop.closed
                      ? "Closed loop"
                      : "Terminated chain (non-manifold boundary vertex)"}{" "}
                    · perimeter {conciseNumber(loop.perimeterMillimetres)} mm
                  </span>
                  <small>{loopLocationLabel(loop.pointsMillimetres)}</small>
                  {loop.pointsTruncated && (
                    <em className="topology-truncated">
                      Point list truncated for display; edge count and perimeter
                      above are exact.
                    </em>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {boundaryLoops.loopsTruncated && (
        <p className="topology-truncated">
          Showing {boundaryLoops.loops.length} of {boundaryLoops.loopCount}{" "}
          boundary loops.
        </p>
      )}
    </section>
  );
}

function EdgeSegmentList({
  title,
  idPrefix,
  set,
  kind,
  selection,
  onSelect,
}: {
  title: string;
  idPrefix: string;
  set: MeshHealthDiagnosis["nonManifoldEdges"];
  kind: "non-manifold" | "inconsistent-orientation";
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
}) {
  return (
    <section aria-labelledby={`${idPrefix}-title`}>
      <h4 id={`${idPrefix}-title`}>
        {title} ({set.count})
      </h4>
      {set.segments.length === 0 ? (
        <p>None found.</p>
      ) : (
        <ol className="diagnostic-list">
          {set.segments.map((segment, index) => {
            const isSelected =
              selection?.kind === kind && selection.index === index;
            return (
              <li key={index}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(isSelected ? undefined : { kind, index })
                  }
                >
                  <strong>Edge {index + 1}</strong>
                  <span>
                    {pointLabel(segment.endpointsMillimetres[0])} →{" "}
                    {pointLabel(segment.endpointsMillimetres[1])}
                  </span>
                  <small>
                    Triangle{segment.triangleIndices.length === 1 ? "" : "s"}{" "}
                    {segment.triangleIndices.join(", ")}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {set.truncated && (
        <p className="topology-truncated">
          Showing {set.segments.length} of {set.count}.
        </p>
      )}
    </section>
  );
}

function DegenerateTriangleList({
  set,
  selection,
  onSelect,
}: {
  set: MeshHealthDiagnosis["degenerateTriangles"];
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
}) {
  return (
    <section aria-labelledby="diagnostic-degenerate-triangles-title">
      <h4 id="diagnostic-degenerate-triangles-title">
        Degenerate triangles ({set.count})
      </h4>
      {set.triangles.length === 0 ? (
        <p>None found.</p>
      ) : (
        <ol className="diagnostic-list">
          {set.triangles.map((triangle, index) => {
            const isSelected =
              selection?.kind === "degenerate-triangle" &&
              selection.index === index;
            return (
              <li key={index}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(
                      isSelected
                        ? undefined
                        : { kind: "degenerate-triangle", index },
                    )
                  }
                >
                  <strong>Triangle {triangle.triangleIndex}</strong>
                  <span>
                    {triangle.positionsMillimetres.map(pointLabel).join(" · ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {set.truncated && (
        <p className="topology-truncated">
          Showing {set.triangles.length} of {set.count}.
        </p>
      )}
    </section>
  );
}

function DiagnosticEvidenceSection({
  state,
  onLoad,
  onRetry,
  selection,
  onSelect,
  sourceName,
}: {
  state: DiagnosisState;
  onLoad: () => void;
  onRetry: () => void;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
  sourceName: string;
}) {
  if (state.status === "idle") {
    return (
      <section
        aria-labelledby="diagnostic-evidence-title"
        className="diagnostic-evidence"
      >
        <h3 id="diagnostic-evidence-title">Full diagnostic evidence</h3>
        <p>
          Open the full boundary-loop, non-manifold-edge,
          inconsistent-orientation-edge, and degenerate-triangle evidence for
          this model, with a 3D view of each. This is a heavier, opt-in pass
          over the same model and may take longer than the summary above for a
          large mesh.
        </p>
        <button
          type="button"
          className="button button-secondary"
          onClick={onLoad}
        >
          Load full diagnostic evidence
        </button>
      </section>
    );
  }
  if (state.status === "loading") {
    return (
      <section
        aria-labelledby="diagnostic-evidence-title"
        className="diagnostic-evidence"
      >
        <h3 id="diagnostic-evidence-title">Full diagnostic evidence</h3>
        <p role="status" aria-live="polite">
          Computing full diagnostic evidence…
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section
        aria-labelledby="diagnostic-evidence-title"
        className="diagnostic-evidence"
      >
        <h3 id="diagnostic-evidence-title">Full diagnostic evidence</h3>
        <div className="comparison-error" role="alert">
          <strong>Diagnostic evidence could not be computed</strong>
          <p>{state.message}</p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={onRetry}
        >
          Try again
        </button>
      </section>
    );
  }
  const { diagnosis, model } = state.outcome;
  return (
    <section
      aria-labelledby="diagnostic-evidence-title"
      className="diagnostic-evidence"
    >
      <h3 id="diagnostic-evidence-title">Full diagnostic evidence</h3>
      <p className="inspect-semantics-note">
        Diagnostic-only, like the rest of this report: nothing here repairs,
        welds, or reinterprets the mesh. Positions use the same exact-coordinate
        topology as the findings above, with no tolerance-based matching.
      </p>
      <p id="diagnostic-evidence-equivalent-note" className="visually-hidden">
        The 3D preview below highlights the selected item from the evidence
        lists that follow it; those lists are the accessible, text equivalent of
        the preview, not a summary of it.
      </p>
      <Suspense
        fallback={
          <div className="workbench-loading" role="status">
            Preparing the 3D diagnostic view…
          </div>
        }
      >
        <MeshHealthViewer
          model={model}
          diagnosis={diagnosis}
          selection={selection}
          onSelect={onSelect}
          accessibleLabel={`3D preview of ${sourceName} with the selected diagnostic item highlighted, if any. Not a substitute for the evidence lists below.`}
        />
      </Suspense>
      <div className="diagnostic-evidence-lists">
        <BoundaryLoopList
          boundaryLoops={diagnosis.boundaryLoops}
          selection={selection}
          onSelect={onSelect}
        />
        <EdgeSegmentList
          title="Non-manifold edges"
          idPrefix="diagnostic-non-manifold"
          set={diagnosis.nonManifoldEdges}
          kind="non-manifold"
          selection={selection}
          onSelect={onSelect}
        />
        <EdgeSegmentList
          title="Inconsistent-orientation edges"
          idPrefix="diagnostic-inconsistent"
          set={diagnosis.inconsistentOrientationEdges}
          kind="inconsistent-orientation"
          selection={selection}
          onSelect={onSelect}
        />
        <DegenerateTriangleList
          set={diagnosis.degenerateTriangles}
          selection={selection}
          onSelect={onSelect}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function HeadlineStats({
  summary,
  focus,
}: {
  summary: ModelPresentationSummary;
  focus?: InspectFocusId | undefined;
}) {
  const dimensions = summary.bounds.available
    ? summary.bounds.dimensionsMillimetres.map(conciseNumber).join(" × ")
    : "Unavailable (no position data)";
  const volume = summary.volume.available
    ? `${conciseNumber(summary.volume.absoluteCubicMillimetres)} mm³`
    : "Not valid";
  // Focus emphasises a row with styling only -- the measurements themselves,
  // their order, and their values are identical to the general Inspect
  // report; this is presentation, not a second computation.
  const rowClass = (row: "dimensions" | "surfaceArea" | "volume") => {
    const emphasised =
      (focus === "scale" && row === "dimensions") ||
      (focus === "volume" && (row === "volume" || row === "surfaceArea"));
    return emphasised ? "row-emphasis" : undefined;
  };
  return (
    <section
      className="geometry-summary"
      aria-labelledby="inspect-measurements-title"
    >
      <h3 id="inspect-measurements-title">Measurements</h3>
      <div className="geometry-table geometry-table-2col" role="table">
        <div className="geometry-table-head" role="row">
          <span role="columnheader">Measure</span>
          <span role="columnheader">Value</span>
        </div>
        <div role="row" className={rowClass("dimensions")}>
          <strong role="rowheader">Dimensions (mm)</strong>
          <span>{dimensions}</span>
        </div>
        <div role="row" className={rowClass("surfaceArea")}>
          <strong role="rowheader">Surface area (mm²)</strong>
          <span>{conciseNumber(summary.surfaceAreaSquareMillimetres)}</span>
        </div>
        <div role="row" className={rowClass("volume")}>
          <strong role="rowheader">Volume</strong>
          <span>{volume}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Vertices (placed)</strong>
          <span>{summary.vertexCount}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Triangles (placed)</strong>
          <span>{summary.triangleCount}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Meshes</strong>
          <span>{summary.meshCount}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Instances</strong>
          <span>{summary.instanceCount}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Connected components</strong>
          <span>{summary.componentCount}</span>
        </div>
      </div>
      {!summary.volume.available && (
        <p>
          Volume withheld:{" "}
          {summary.volume.reasons.map(volumeReasonLabel).join(", ")}.
        </p>
      )}
    </section>
  );
}

function InspectReport({
  outcome,
  sourceMeta,
  onReset,
  focus,
  diagnosisState,
  onLoadDiagnosis,
  onRetryDiagnosis,
  diagnosisSelection,
  onSelectDiagnostic,
}: {
  outcome: InspectionOutcome;
  sourceMeta: { name: string; size: number };
  onReset: () => void;
  focus?: InspectFocusId | undefined;
  diagnosisState: DiagnosisState;
  onLoadDiagnosis: () => void;
  onRetryDiagnosis: () => void;
  diagnosisSelection: MeshHealthSelection | undefined;
  onSelectDiagnostic: (selection: MeshHealthSelection | undefined) => void;
}) {
  const { inspection, warnings } = outcome;
  const watertight = watertightPresentation(inspection.watertightness);
  return (
    <div className="inspect-report">
      <header className="inspect-report-header">
        <div>
          <h2>{sourceMeta.name}</h2>
          <p>
            {formatFileSize(sourceMeta.size)} · {inspection.provenance.formatId}{" "}
            · reported in millimetres, right-handed Z-up
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onReset}
        >
          Inspect another model
        </button>
      </header>

      <HeadlineStats summary={inspection.summary} focus={focus} />

      <section
        aria-labelledby="watertight-title"
        className={focus === "watertight" ? "section-emphasis" : undefined}
      >
        <h3 id="watertight-title">Watertightness</h3>
        <div className={`watertight-badge ${watertight.className}`}>
          <i aria-hidden="true" />
          <p>
            <strong>{watertight.label}</strong>
            <span>{watertight.detail}</span>
          </p>
        </div>
        <p className="inspect-semantics-note">
          Topology and watertightness use exact-coordinate adjacency: two
          triangle corners count as the same point only when their coordinates
          are bit-for-bit identical, with no tolerance-based welding anywhere in
          this pipeline. A model whose parts touch but are not exactly
          coincident can report open boundary edges even though it looks closed
          when rendered.
        </p>
      </section>

      <section
        aria-labelledby="topology-findings-title"
        className={focus === "watertight" ? "section-emphasis" : undefined}
      >
        <h3 id="topology-findings-title">Topology findings</h3>
        {inspection.topologyFindings.length === 0 ? (
          <p className="empty-findings">
            No topology issues found: no boundary edges, non-manifold edges,
            inconsistent orientation, or degenerate triangles.
          </p>
        ) : (
          <ul className="topology-list">
            {inspection.topologyFindings.map((finding) => (
              <li
                key={finding.id}
                className={`topology-item topology-${finding.severity}`}
              >
                <div className="topology-item-head">
                  <i aria-hidden="true" />
                  <strong>{topologyKindLabel(finding.kind)}</strong>
                  <span>
                    {finding.severity === "warning" ? "Warning" : "Info"} ·{" "}
                    {finding.count}
                  </span>
                </div>
                <p>{finding.summary}</p>
                {finding.examples.length > 0 && (
                  <details className="topology-examples">
                    <summary>
                      {finding.examples.length} example location
                      {finding.examples.length === 1 ? "" : "s"}
                    </summary>
                    <ul>
                      {finding.examples.map((example, index) => (
                        <li key={index}>
                          (
                          {example.positionMillimetres
                            .map((value) => conciseNumber(value))
                            .join(", ")}
                          ) mm · triangle
                          {example.triangleIndices.length === 1 ? "" : "s"}{" "}
                          {example.triangleIndices.join(", ")}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {finding.examplesTruncated && (
                  <p className="topology-truncated">
                    {finding.count - finding.examples.length} more not shown.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {inspection.topologyFindings.length > 0 && (
        <DiagnosticEvidenceSection
          state={diagnosisState}
          onLoad={onLoadDiagnosis}
          onRetry={onRetryDiagnosis}
          selection={diagnosisSelection}
          onSelect={onSelectDiagnostic}
          sourceName={sourceMeta.name}
        />
      )}

      <section
        className="geometry-summary"
        aria-labelledby="mesh-breakdown-title"
      >
        <h3 id="mesh-breakdown-title">Mesh breakdown</h3>
        <div className="geometry-table" role="table">
          <div className="geometry-table-head" role="row">
            <span role="columnheader">Mesh</span>
            <span role="columnheader">Triangles</span>
            <span role="columnheader">Vertices</span>
          </div>
          {inspection.meshBreakdown.meshes.map((mesh) => (
            <div role="row" key={mesh.meshId}>
              <strong role="rowheader">{mesh.meshId}</strong>
              <span>{mesh.triangleCount}</span>
              <span>{mesh.vertexCount}</span>
            </div>
          ))}
        </div>
        {inspection.meshBreakdown.truncated && (
          <p>
            Showing {inspection.meshBreakdown.meshes.length} of{" "}
            {inspection.meshBreakdown.totalMeshCount} meshes.
          </p>
        )}
      </section>

      <details className="technical-details" open={focus === "scale"}>
        <summary>Provenance &amp; interpretation</summary>
        <section>
          <dl className="provenance-list">
            <div>
              <dt>Format</dt>
              <dd>{inspection.provenance.formatId}</dd>
            </div>
            <div>
              <dt>Importer</dt>
              <dd>
                {inspection.provenance.importerId} v
                {inspection.provenance.importerVersion}
              </dd>
            </div>
            <div>
              <dt>Source file</dt>
              <dd>{inspection.provenance.sourceName}</dd>
            </div>
            <div>
              <dt>Source digest (SHA-256)</dt>
              <dd>
                {inspection.provenance.sourceDigest?.value ?? "Not computed"}
              </dd>
            </div>
            <div>
              <dt>Detected unit</dt>
              <dd>{unitLabel(inspection.provenance.detectedSourceUnit)}</dd>
            </div>
            <div>
              <dt>Detected up-axis</dt>
              <dd>{axisLabel(inspection.provenance.detectedSourceAxis)}</dd>
            </div>
            <div>
              <dt>Resolved unit</dt>
              <dd>
                {unitLabel(inspection.provenance.sourceUnit)} (
                {originLabel(inspection.provenance.sourceResolution.unit)})
              </dd>
            </div>
            <div>
              <dt>Resolved up-axis</dt>
              <dd>
                {axisLabel(inspection.provenance.sourceAxis)} (
                {originLabel(inspection.provenance.sourceResolution.axis)})
              </dd>
            </div>
            {inspection.provenance.notes.length > 0 && (
              <div>
                <dt>Importer notes</dt>
                <dd>{inspection.provenance.notes.join(" ")}</dd>
              </div>
            )}
          </dl>
          {warnings.length > 0 && (
            <div className="provenance-warnings">
              <strong>Import warnings</strong>
              <ul>
                {warnings.map((warning, index) => (
                  <li key={index}>
                    <span
                      className={
                        warning.severity === "error"
                          ? "severity-error"
                          : undefined
                      }
                    >
                      {warning.severity === "error"
                        ? "Error"
                        : warning.severity === "warning"
                          ? "Warning"
                          : "Info"}
                    </span>{" "}
                    {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Same rationale as `ComparisonFlow`'s `INITIAL_CAPABILITY`: no device
 * signals exist during server-side prerendering or before the first client
 * effect runs, so this matches exactly what `evaluateCapabilityPreflight`
 * returns for an all-unknown, worker-capable reading, keeping prerendered
 * HTML and the first client render identical.
 */
const INITIAL_CAPABILITY: CapabilityPreflight = {
  recommendedAnalysisMemoryMiB: DEFAULT_ANALYSIS_MEMORY_MIB,
  memoryNotes: [],
  workersAvailable: true,
  webglAvailable: true,
  analysisSupported: true,
  blockingMessage: undefined,
};

/**
 * `focus` renders one of the seeded landing routes into Inspect
 * (`/tools/scale/`, `/tools/volume/`, `/tools/watertight/`): the same
 * component, the same worker-backed single-model inspection, and the same
 * full report, parameterised by which aspect leads. Omitting it renders the
 * general `/tools/inspect/` page. See `InspectFocusPage` in content.ts for
 * each focus's copy and metadata, and the roadmap rationale in this bead:
 * these are landing pages into one capable inspector, not separate
 * implementations.
 */
export function InspectFlow({ focus }: { focus?: InspectFocusId } = {}) {
  const focusPage = focus
    ? inspectFocusPages.find((page) => page.id === focus)
    : undefined;
  const [selection, setSelection] = useState(modelSourceSelectionForFile(null));
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [outcome, setOutcome] = useState<InspectionOutcome>();
  const [sourceMeta, setSourceMeta] = useState<{
    name: string;
    size: number;
  }>();
  const [capability, setCapability] =
    useState<CapabilityPreflight>(INITIAL_CAPABILITY);
  useEffect(() => {
    setCapability(evaluateCapabilityPreflight(readEnvironmentReadings()));
  }, []);
  const activeRunRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => activeRunRef.current?.abort();
  }, []);

  // `diagnoseMeshHealth` is the heavier, opt-in sibling of the inspection
  // above: it only ever runs when a user explicitly asks for full
  // diagnostic evidence (`loadDiagnosis` below), never automatically
  // alongside every import. State resets whenever a new model is inspected
  // or the tool is reset, since a stale diagnosis belongs to a previous
  // file.
  const [diagnosisState, setDiagnosisState] = useState<DiagnosisState>({
    status: "idle",
  });
  const [diagnosisSelection, setDiagnosisSelection] =
    useState<MeshHealthSelection>();
  const diagnosisRunRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => diagnosisRunRef.current?.abort();
  }, []);

  const capabilityCheck = modelSourceCapability(selection);
  const ready =
    capabilityCheck.ready && !progress && capability.analysisSupported;

  const inspect = async () => {
    if (!ready || !selection.file) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setProgress("Reading and inspecting the model locally");
    try {
      const result = await inspectSourceAsync(
        selection as InspectSource,
        controller.signal,
      );
      setSourceMeta({ name: selection.file.name, size: selection.file.size });
      setOutcome(result);
      // A fresh inspection means any previously loaded diagnostic evidence
      // (or one still in flight) belongs to a different model now.
      diagnosisRunRef.current?.abort();
      setDiagnosisState({ status: "idle" });
      setDiagnosisSelection(undefined);
    } catch (reason) {
      if (reason instanceof InspectionCancelledError) {
        setNotice("Inspection cancelled.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Inspection failed safely.",
        );
      }
    } finally {
      setProgress(undefined);
      if (activeRunRef.current === controller) activeRunRef.current = null;
    }
  };

  const cancel = () => activeRunRef.current?.abort();

  const reset = () => {
    setOutcome(undefined);
    setSourceMeta(undefined);
    setError(undefined);
    setNotice(undefined);
    setSelection(modelSourceSelectionForFile(null));
    diagnosisRunRef.current?.abort();
    setDiagnosisState({ status: "idle" });
    setDiagnosisSelection(undefined);
  };

  const loadDiagnosis = async () => {
    if (!selection.file) return;
    diagnosisRunRef.current?.abort();
    const controller = new AbortController();
    diagnosisRunRef.current = controller;
    setDiagnosisSelection(undefined);
    setDiagnosisState({ status: "loading" });
    try {
      const diagnosisOutcome = await diagnoseModelAsync(
        selection as InspectSource,
        controller.signal,
      );
      setDiagnosisState({ status: "ready", outcome: diagnosisOutcome });
    } catch (reason) {
      if (reason instanceof InspectionCancelledError) {
        setDiagnosisState({ status: "idle" });
      } else {
        setDiagnosisState({
          status: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "Diagnostic evidence unavailable.",
        });
      }
    } finally {
      if (diagnosisRunRef.current === controller)
        diagnosisRunRef.current = null;
    }
  };

  return (
    <ToolShell
      eyebrow={focusPage?.eyebrow ?? "Inspect"}
      title={focusPage?.title ?? "Look inside one model"}
      description={
        focusPage?.description ??
        "Choose a single model file (STL, OBJ, glTF, GLB, or 3MF) from your device and get a full local report: dimensions, surface area, volume, watertightness, topology findings, and a per-mesh breakdown."
      }
    >
      {focusPage ? (
        <section className="inspect-focus-intro" aria-label="About this page">
          {focusPage.intro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <p className="inspect-focus-crosslink">
            This page leads with one question; the rest of the report is below.{" "}
            <Link to="/tools/inspect/">Open the full Inspect report →</Link>
          </p>
        </section>
      ) : (
        <nav className="inspect-entrypoints" aria-label="Focused entry points">
          <span>Looking for one specific answer?</span>
          <ul>
            {inspectFocusPages.map((page) => (
              <li key={page.id}>
                <Link to={page.path}>{page.question}</Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {outcome && sourceMeta ? (
        <InspectReport
          outcome={outcome}
          sourceMeta={sourceMeta}
          onReset={reset}
          focus={focus}
          diagnosisState={diagnosisState}
          onLoadDiagnosis={() => void loadDiagnosis()}
          onRetryDiagnosis={() => void loadDiagnosis()}
          diagnosisSelection={diagnosisSelection}
          onSelectDiagnostic={setDiagnosisSelection}
        />
      ) : (
        <section
          className="comparison-card"
          aria-labelledby="inspect-choose-title"
        >
          <div className="section-heading">
            <span className="step">Step 01</span>
            <h2 id="inspect-choose-title">Choose a model</h2>
            <p>
              Select one supported file to inspect immediately using common
              millimetre and right-handed Z-up defaults. If the source uses a
              different frame, adjust its Expert settings first.
            </p>
          </div>
          {!capability.analysisSupported && (
            <div className="comparison-error" role="alert">
              <strong>Local inspection is unavailable in this browser</strong>
              <p>{capability.blockingMessage}</p>
            </div>
          )}
          <div className="inspect-model-field">
            <ModelSourceCard
              selection={selection}
              update={setSelection}
              expertSettingsOpen={focus === "scale"}
            />
          </div>
          <div className="comparison-status" aria-live="polite">
            <span className={ready ? "status-ready" : ""}>
              {progress ??
                notice ??
                (ready
                  ? "Inputs pass capability preflight"
                  : !capability.analysisSupported
                    ? "Inspection disabled: see the browser support notice above"
                    : "Choose a source file")}
            </span>
            <div className="actions">
              {progress && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={cancel}
                >
                  Cancel inspection
                </button>
              )}
              <button
                className="button button-primary"
                type="button"
                disabled={!ready}
                onClick={() => void inspect()}
              >
                {progress ? "Inspecting locally…" : "Validate and inspect"}
              </button>
            </div>
          </div>
          {error && (
            <div className="comparison-error" role="alert">
              <strong>Inspection could not continue</strong>
              <p>{error}</p>
            </div>
          )}
          <p className="boundary-note">
            <strong>Local boundary:</strong> the source file and its geometry
            stay inside this browser's dedicated inspection worker; only the
            structured report leaves the worker, and nothing is uploaded.
          </p>
        </section>
      )}
    </ToolShell>
  );
}
