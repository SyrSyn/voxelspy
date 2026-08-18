import type {
  ModelPresentationSummary,
  TopologyFindingKind,
  WatertightnessReason,
  WatertightnessVerdict,
} from "@voxelspy/analysis";
import type { SourceAxis, SourceUnit } from "@voxelspy/contracts";
import { useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  InspectionCancelledError,
  inspectSourceAsync,
  type InspectionOutcome,
  type InspectSource,
} from "./inspect-worker-client";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

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

type ModelSourceSelection = {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
};

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<
  ModelSourceSelection,
  "unit" | "axis" | "frameSource"
>;

export function modelSourceSelectionForFile(
  file: File | null,
): ModelSourceSelection {
  return { file, ...defaultSourceFrame };
}

/**
 * Same shape as `ComparisonFlow`'s `sourceCapability`, adapted to inspect a
 * single file rather than a baseline/candidate pair: same supported-format,
 * size, and unit/axis preconditions (this release's single importer applies
 * uniformly to both tools), phrased for inspection rather than comparison.
 */
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
        ? "Ready for local inspection using millimetres and right-handed Z-up."
        : "Ready for local inspection using the selected expert source frame.",
  };
}

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
          The selected values are recorded with the inspection.
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
// Report rendering
// ---------------------------------------------------------------------------

function HeadlineStats({ summary }: { summary: ModelPresentationSummary }) {
  const dimensions = summary.bounds.available
    ? summary.bounds.dimensionsMillimetres.map(conciseNumber).join(" × ")
    : "Unavailable (no position data)";
  const volume = summary.volume.available
    ? `${conciseNumber(summary.volume.absoluteCubicMillimetres)} mm³`
    : "Not valid";
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
        <div role="row">
          <strong role="rowheader">Dimensions (mm)</strong>
          <span>{dimensions}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Surface area (mm²)</strong>
          <span>{conciseNumber(summary.surfaceAreaSquareMillimetres)}</span>
        </div>
        <div role="row">
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
}: {
  outcome: InspectionOutcome;
  sourceMeta: { name: string; size: number };
  onReset: () => void;
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

      <HeadlineStats summary={inspection.summary} />

      <section aria-labelledby="watertight-title">
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

      <section aria-labelledby="topology-findings-title">
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

      <details className="technical-details">
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

export function InspectFlow() {
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

  const capabilityCheck = modelSourceCapability(selection);
  const ready =
    capabilityCheck.ready && !progress && capability.analysisSupported;

  const inspect = async () => {
    if (!ready || !selection.file || !selection.unit || !selection.axis) return;
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
  };

  return (
    <ToolShell
      eyebrow="Inspect"
      title="Look inside one model"
      description="Choose a single STL or OBJ file from your device and get a full local report: dimensions, surface area, volume, watertightness, topology findings, and a per-mesh breakdown."
    >
      {outcome && sourceMeta ? (
        <InspectReport
          outcome={outcome}
          sourceMeta={sourceMeta}
          onReset={reset}
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
            <ModelSourceCard selection={selection} update={setSelection} />
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
